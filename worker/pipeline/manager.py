"""
worker/pipeline/manager.py — Orquestador del pipeline completo de segmentación.

Este módulo es el único punto de entrada para ejecutar el pipeline.
Coordina la secuencia completa llamando a los módulos especializados:

  1. loader.py      → Conversión DICOM → NIfTI + resampling isotrópico.
  2. transforms.py  → Preprocesamiento MONAI (orientación, spacing, HU).
  3. inference.py   → Carga del modelo + SlidingWindowInferer.
  4. postprocess.py → Máscara binaria + guardado de NIfTI + uncertainty map.
  5. clinical_metrics → Cálculo de métricas volumétricas y RECIST.

Diseño de robustez (graceful fallback):
  - Si el preprocesamiento MONAI falla, intenta carga manual via SimpleITK.
  - Si los pesos del modelo no existen, el sistema informa claramente.
  - Cada checkpoint de progreso está alineado con el callback del worker.
"""

import hashlib
import logging
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch

from worker.clinical_metrics import compute_clinical_metrics
from worker.mock_data import get_mock_artifacts
from worker.model_config import get_active_config
from worker.pipeline.inference import get_inferer, load_model
from worker.pipeline.loader import convert_dicom_to_nifti
from worker.pipeline.postprocess import (
    postprocess_prediction,
    save_predicted_mask,
    save_uncertainty_map,
)
from worker.pipeline.transforms import get_preprocessing_transforms

logger = logging.getLogger("pulmoseg.pipeline.manager")

# Ruta base de almacenamiento local
LOCAL_STORAGE_BASE = Path("local_storage")


def run_inference_pipeline(
    job_id: str,
    request_data: dict,
    dicom_dir: Optional[Path] = None,
    progress_callback: Optional[Callable] = None,
) -> dict:
    """
    Ejecuta el pipeline completo de segmentación pulmonar 3D.

    Flujo:
      1. Configura dispositivo (CUDA si disponible, si no CPU).
      2. Carga la configuración del modelo activo (model_config.py).
      3. Convierte DICOM → NIfTI usando SimpleITK (loader.py).
      4. Convierte los DICOM a NIfTI (volume.nii.gz) para la inferencia MONAI.
      5. Aplica transforms de preprocesamiento MONAI (transforms.py).
         Fallback B: carga manual SimpleITK + normalización HU si MONAI falla.
      6. Carga el modelo y ejecuta inferencia SlidingWindow (inference.py).
      7. Post-procesa: softmax → argmax → máscara binaria (postprocess.py).
      8. Guarda mask.nii.gz y uncertainty.nii.gz alineados al espacio original.
      9. Calcula métricas clínicas (volumen, diámetro RECIST, confianza).

    Args:
        job_id: Identificador único del Job.
        request_data: Diccionario con el payload del request original.
        dicom_dir: Path al directorio con archivos DICOM reales.
                   Si None, el pipeline falla explícitamente (no hay mock).
        progress_callback: Función opcional callback(percentage: int, message: str)
                           para reportar progreso al worker.

    Returns:
        dict con:
          - "clinical_results": métricas clínicas calculadas desde la máscara.
          - "artifacts": rutas a los archivos generados (mask, uncertainty, etc.).
    """
    logger.info(f"[{job_id}] Iniciando pipeline de inferencia...")

    def _report(pct: int, msg: str) -> None:
        """Reporta progreso si hay callback disponible."""
        if progress_callback:
            progress_callback(pct, msg)
        logger.info(f"[{job_id}] {msg}")

    # =========================================================================
    # PASO 1 — Configurar dispositivo (GPU o CPU)
    # =========================================================================
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info(f"[{job_id}] Dispositivo configurado: {device}")

    # =========================================================================
    # PASO 2 — Cargar configuración del modelo activo
    # =========================================================================
    config = get_active_config()
    _report(5, f"Modelo configurado: {config.name}")

    # ── CHECKPOINT A: Verificación de inputs y pesos del modelo ──────────────
    logger.info(f"[{job_id}] ── CHECKPOINT A: Verificación de entradas ──")
    logger.info(f"[{job_id}]   DICOM dir recibido: {dicom_dir}")
    logger.info(
        f"[{job_id}]   DICOM dir existe en disco: "
        f"{dicom_dir.exists() if dicom_dir else 'N/A (None)'}"
    )
    if dicom_dir and dicom_dir.exists():
        dcm_count = len(list(dicom_dir.glob("*.dcm")))
        logger.info(f"[{job_id}]   Archivos .dcm visibles en dir: {dcm_count}")
    logger.info(f"[{job_id}]   Pesos del modelo: {config.weights_path}")
    logger.info(
        f"[{job_id}]   Pesos existen en disco: {config.weights_path.exists()}"
    )
    if not config.weights_path.exists():
        logger.warning(
            f"[{job_id}] ⚠️  ATENCIÓN: Los pesos del modelo NO existen. "
            f"El pipeline usará resultados MOCK. "
            f"Descarga el bundle y coloca model.pt en: {config.weights_path}"
        )
    logger.info(f"[{job_id}] ── FIN CHECKPOINT A ──")

    # =========================================================================
    # PASO 3 — Crear directorio de salida
    # =========================================================================
    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # =========================================================================
    # PASO 4 — Conversión DICOM → NIfTI
    # =========================================================================
    nifti_path = output_dir / "volume.nii.gz"
    _dicom_conversion_ok = False

    if dicom_dir:
        try:
            nifti_path = convert_dicom_to_nifti(dicom_dir, nifti_path)
            _dicom_conversion_ok = nifti_path.exists() and nifti_path.stat().st_size > 0

            if _dicom_conversion_ok:
                _report(25, f"Volumen NIfTI generado: {nifti_path}")

                # El resampling isotrópico para visualización se realiza
                # en el cliente (DicomCanvasViewer) usando el spacing leído
                # directamente de los metadatos DICOM (PixelSpacing + SliceThickness).
            else:
                raise RuntimeError(
                    f"convert_dicom_to_nifti retornó path vacío o inexistente: {nifti_path}"
                )
        except Exception as _conv_err:
            logger.error(
                f"[{job_id}] ❌ Error crítico en conversión DICOM→NIfTI: {_conv_err}",
                exc_info=True,
            )
            _report(25, f"Conversión DICOM falló: {_conv_err}")
            raise
    else:
        raise ValueError("Directorio DICOM no proporcionado")

    # ── CHECKPOINT B: Hash y tamaño del NIfTI generado ───────────────────────
    if _dicom_conversion_ok:
        try:
            with open(nifti_path, "rb") as _f:
                _nifti_hash = hashlib.md5(_f.read()).hexdigest()
            logger.info(f"[{job_id}] ── CHECKPOINT B: NIfTI generado ──")
            logger.info(f"[{job_id}]   Path: {nifti_path}")
            logger.info(f"[{job_id}]   Tamaño: {nifti_path.stat().st_size:,} bytes")
            logger.info(
                f"[{job_id}]   Hash MD5: {_nifti_hash} "
                f"← Debe ser DIFERENTE para cada estudio distinto"
            )
        except Exception as _e:
            logger.warning(f"[{job_id}] No se pudo calcular hash del NIfTI: {_e}")
    else:
        raise RuntimeError("Conversión DICOM→NIfTI resultó en archivo ausente/vacío.")

    # =========================================================================
    # PASO 5 — Preprocesamiento MONAI (Intento A + Fallback B)
    # =========================================================================
    preprocessed_data = None

    if nifti_path.exists() and nifti_path.stat().st_size > 0:
        _report(30, "Aplicando preprocesamiento MONAI...")

        # ── Intento A: pipeline MONAI completo ───────────────────────────────
        transforms = get_preprocessing_transforms(config)
        if transforms:
            try:
                data_dict = {"image": str(nifti_path)}
                preprocessed_data = transforms(data_dict)

                img_tensor = preprocessed_data["image"]
                logger.info(f"[{job_id}] ── CHECKPOINT C: Tensor de entrada ──")
                logger.info(f"[{job_id}]   Shape: {list(img_tensor.shape)}")
                logger.info(f"[{job_id}]   dtype: {img_tensor.dtype}")
                logger.info(
                    f"[{job_id}]   min={img_tensor.min():.4f} | "
                    f"max={img_tensor.max():.4f} | "
                    f"mean={img_tensor.mean():.4f} | "
                    f"std={img_tensor.std():.4f} "
                    f"← Estos valores DEBEN variar entre estudios distintos"
                )
                logger.info(f"[{job_id}] ── FIN CHECKPOINT C ──")
                _report(
                    40,
                    f"Preprocesamiento MONAI completado — "
                    f"shape={list(img_tensor.shape)}, "
                    f"rango=[{img_tensor.min():.3f}, {img_tensor.max():.3f}]"
                )
            except Exception as e_monai:
                logger.warning(
                    f"[{job_id}] Preprocesamiento MONAI falló: {e_monai} "
                    f"— intentando carga directa con SimpleITK.",
                    exc_info=True,
                )
                preprocessed_data = None  # activa el fallback B

        # ── Intento B: carga manual SimpleITK + normalización HU ─────────────
        # Necesario cuando la estrategia-2 genera NIfTI con spacing/direction
        # que MONAI LoadImaged no puede leer (e.g. volumen 2D apilado).
        if preprocessed_data is None:
            try:
                _report(32, "Intento B: carga manual del NIfTI con SimpleITK...")
                _sitk_img = sitk.ReadImage(str(nifti_path))
                _arr = sitk.GetArrayFromImage(_sitk_img).astype(np.float32)
                # shape de SimpleITK: (Z, Y, X) → añadir dim canal: (1, Z, Y, X)
                _arr = np.expand_dims(_arr, axis=0)

                # Normalización HU → [0, 1] con la ventana del config
                hu_min = float(config.hu_window_min)
                hu_max = float(config.hu_window_max)
                _arr = np.clip(_arr, hu_min, hu_max)
                _arr = (_arr - hu_min) / (hu_max - hu_min + 1e-8)

                img_tensor = torch.from_numpy(_arr).float()  # (1, Z, Y, X)

                logger.info(
                    f"[{job_id}] Intento B exitoso — tensor shape={list(img_tensor.shape)}, "
                    f"rango=[{img_tensor.min():.3f}, {img_tensor.max():.3f}]"
                )
                preprocessed_data = {"image": img_tensor}
                _report(40, f"Carga manual completada — shape={list(img_tensor.shape)}")

            except Exception as e_sitk:
                logger.error(
                    f"[{job_id}] Intento B (carga manual) también falló: {e_sitk}",
                    exc_info=True,
                )
                raise RuntimeError(
                    f"Fallo en preprocesamiento MONAI e intento B manual: {e_sitk}"
                )
    else:
        raise RuntimeError("Volumen NIfTI no disponible para preprocesamiento")

    # =========================================================================
    # PASO 6 — Inferencia con SlidingWindowInferer
    # =========================================================================
    mask_np = None
    prediction_probs = None

    if preprocessed_data is not None:
        _report(45, f"Cargando modelo: {config.name}...")

        model   = load_model(config, device)
        inferer = get_inferer(config, device)

        if model is not None and inferer is not None:
            try:
                _report(
                    50,
                    f"Ejecutando inferencia por parches "
                    f"(roi_size={config.roi_size}, overlap={config.overlap})..."
                )

                # Preparar tensor de entrada: (C, D, H, W) → (B, C, D, H, W)
                img_t = preprocessed_data["image"]
                if img_t.ndim == 3:
                    img_t = img_t.unsqueeze(0)  # añadir dim canal si falta
                img_t = img_t.float()
                input_tensor = img_t.unsqueeze(0).to(device)  # → (B, C, D, H, W)

                logger.info(
                    f"[{job_id}] Input tensor: shape={list(input_tensor.shape)}, "
                    f"dtype={input_tensor.dtype}, device={input_tensor.device}"
                )

                with torch.no_grad():
                    prediction = inferer(input_tensor, model)

                logger.info(
                    f"[{job_id}] Predicción raw: shape={list(prediction.shape)}, "
                    f"rango=[{prediction.min():.4f}, {prediction.max():.4f}]"
                )

                _report(70, "Inferencia completada — aplicando post-procesamiento...")

                # Calcular probabilidades post-activación ANTES del argmax
                # para usarlas en el mapa de incertidumbre
                if config.use_softmax:
                    prediction_probs = torch.softmax(prediction, dim=1)
                else:
                    prediction_probs = torch.sigmoid(prediction)

                mask_np = postprocess_prediction(prediction, config)

                _report(
                    75,
                    f"Máscara generada: shape={mask_np.shape}, "
                    f"vóxeles positivos={int(mask_np.sum()):,}"
                )

            except Exception as e:
                logger.error(
                    f"[{job_id}] Error durante inferencia: {e}",
                    exc_info=True,
                )
                raise
        else:
            raise RuntimeError("Modelo o inferer no disponible para inferencia")
    else:
        raise RuntimeError("Sin datos preprocesados para inferencia")

    # =========================================================================
    # PASO 7 — Guardar máscara, uncertainty y calcular métricas clínicas
    # =========================================================================
    clinical_results = None

    if mask_np is not None and mask_np.sum() > 0:
        _report(80, "Guardando mask.nii.gz y uncertainty.nii.gz...")

        # SimpleITK espera spacing en orden (X, Y, Z) = inverso al de MONAI (Z, Y, X)
        spacing_sitk = tuple(reversed(config.target_spacing))
        ref_nifti = nifti_path if nifti_path.exists() else None

        # 7a. Guardar máscara binaria → mask.nii.gz
        save_predicted_mask(
            mask_np=mask_np,
            output_dir=output_dir,
            spacing=spacing_sitk,
            reference_nifti_path=ref_nifti,
        )

        # 7b. Guardar mapa de incertidumbre → uncertainty.nii.gz
        if prediction_probs is not None:
            save_uncertainty_map(
                prediction_probs=prediction_probs,
                output_dir=output_dir,
                spacing=spacing_sitk,
                reference_nifti_path=ref_nifti,
            )
        else:
            logger.warning(
                f"[{job_id}] prediction_probs no disponible — "
                f"uncertainty.nii.gz no generado"
            )

        _report(85, "Calculando métricas clínicas desde la máscara predicha...")

        # Calcular confianza real basada en las probabilidades del modelo
        real_confidence = 0.94  # Fallback si no hay probabilidades
        if prediction_probs is not None:
            fg_probs = prediction_probs[0, 1].cpu().numpy()
            masked_probs = fg_probs[mask_np > 0]
            if len(masked_probs) > 0:
                real_confidence = float(np.mean(masked_probs))
                logger.info(
                    f"[{job_id}] Confianza real calculada: {real_confidence:.4f}"
                )

        try:
            clinical_results = compute_clinical_metrics(
                mask=mask_np,
                voxel_spacing=config.target_spacing,
                lesion_id="L1",
                confidence_score=real_confidence,
            )
            logger.info(
                f"[{job_id}] Métricas clínicas calculadas desde predicción real"
            )
        except Exception as e:
            logger.error(
                f"[{job_id}] Error calculando métricas: {e}",
                exc_info=True,
            )
            raise
    else:
        raise RuntimeError("Máscara vacía (0 vóxeles positivos) o no disponible.")

    if clinical_results is None:
        raise RuntimeError("Los resultados clínicos son None tras procesamiento.")

    _report(90, "Construyendo resultado final...")

    # =========================================================================
    # PASO 8 — Construir y retornar resultados
    # =========================================================================
    artifacts = get_mock_artifacts(job_id)

    mask_file = output_dir / "mask.nii.gz"
    if mask_file.exists():
        artifacts["segmentation_mask_nifti_url"] = str(mask_file)

    uncertainty_file = output_dir / "uncertainty.nii.gz"
    if uncertainty_file.exists():
        artifacts["uncertainty_map_url"] = str(uncertainty_file)

    # Listar archivos generados para diagnóstico
    output_files = [f.name for f in output_dir.iterdir() if f.is_file()]
    logger.info(f"[{job_id}] Archivos en {output_dir}: {output_files}")

    result = {
        "clinical_results": clinical_results,
        "artifacts": artifacts,
    }

    logger.info(
        f"[{job_id}] Pipeline completado | "
        f"Volumen: {result['clinical_results']['volumetric_data']['volume_ml']} ml | "
        f"Confianza: {result['clinical_results']['recist_metrics']['confidence_score']}"
    )

    return result
