"""
pipeline_monai.py — Pipeline de preprocesamiento e inferencia MONAI para PulmoSeg 3D.

Regla 2 aplicada: Placeholder de Preprocesamiento Médico.
  - Define transforms reales de MONAI para CT pulmonar.
  - Configura SlidingWindowInferer con patch [64,64,64] en CPU.
  - En Fase 1 NO ejecuta inferencia real: retorna resultados mock.
  - Cada punto de extensión está marcado con "TODO: Fase 2".

Regla 3 aplicada: Ingesta DICOM Simplificada.
  - Conversión DICOM→NIfTI usando SimpleITK.
  - Asume Toy Dataset limpio y ordenado.

Hardware: Fuerza device='cpu' para evitar OOM en hardware local (4GB VRAM máx).
"""

import logging
from pathlib import Path
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Imports condicionales de MONAI y dependencias médicas
# Se importan condicionalmente para permitir ejecutar el mock sin MONAI
# instalado (útil para tests unitarios rápidos).
# ---------------------------------------------------------------------------
try:
    import SimpleITK as sitk
    import torch
    from monai.inferers import SlidingWindowInferer
    from monai.transforms import (
        Compose,
        EnsureChannelFirstd,
        LoadImaged,
        ScaleIntensityRanged,
        Spacingd,
    )

    MONAI_AVAILABLE = True
except ImportError:
    MONAI_AVAILABLE = False

from worker.mock_data import get_mock_artifacts, get_mock_clinical_results

logger = logging.getLogger("pulmoseg.pipeline")

# ---------------------------------------------------------------------------
# Constantes del pipeline
# ---------------------------------------------------------------------------
# Ventana Hounsfield para tejido pulmonar
# -1000 HU = aire, +400 HU = incluye tejido blando y calcificaciones
HU_WINDOW_MIN = -1000
HU_WINDOW_MAX = 400

# Resolución isotrópica objetivo (mm)
TARGET_SPACING = (1.5, 1.5, 1.5)

# Tamaño de parche para SlidingWindowInferer (Regla 2)
# [64, 64, 64] es deliberadamente pequeño para evitar OOM en CPU/GPU local
PATCH_SIZE = (64, 64, 64)
SLIDING_WINDOW_OVERLAP = 0.25

# Ruta base de almacenamiento local
LOCAL_STORAGE_BASE = Path("local_storage")


# ===========================================================================
# Conversión DICOM → NIfTI (Regla 3: Simplificada)
# ===========================================================================
def convert_dicom_to_nifti(
    dicom_dir: str | Path,
    output_path: str | Path,
) -> Path:
    """
    Convierte una serie DICOM a un volumen NIfTI usando SimpleITK.

    Regla 3: Asume que el Toy Dataset viene limpio, ordenado y sin
    inconsistencias de metadatos severas. No implementa validación
    exhaustiva de metadatos DICOM en esta fase.

    Args:
        dicom_dir: Directorio que contiene los archivos DICOM de una serie.
        output_path: Ruta donde guardar el archivo NIfTI resultante.

    Returns:
        Path al archivo NIfTI generado.

    Raises:
        FileNotFoundError: Si el directorio DICOM no existe.
        RuntimeError: Si SimpleITK no puede leer la serie DICOM.
    """
    if not MONAI_AVAILABLE:
        logger.warning("SimpleITK no disponible — retornando path mock")
        return Path(output_path)

    dicom_dir = Path(dicom_dir)
    output_path = Path(output_path)

    if not dicom_dir.exists():
        raise FileNotFoundError(f"Directorio DICOM no encontrado: {dicom_dir}")

    # Crear directorio de salida si no existe
    output_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"Leyendo serie DICOM desde: {dicom_dir}")

    # Leer la serie DICOM con SimpleITK
    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(str(dicom_dir))

    if not dicom_files:
        raise RuntimeError(
            f"No se encontraron archivos DICOM válidos en: {dicom_dir}"
        )

    logger.info(f"Archivos DICOM encontrados: {len(dicom_files)}")

    reader.SetFileNames(dicom_files)
    # MetaDataDictionaryArrayUpdate permite acceder a metadatos por slice
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOn()

    image = reader.Execute()

    # Guardar como NIfTI
    sitk.WriteImage(image, str(output_path))
    logger.info(f"Volumen NIfTI generado: {output_path}")
    logger.info(
        f"  Dimensiones: {image.GetSize()} | "
        f"Spacing: {image.GetSpacing()} | "
        f"Origin: {image.GetOrigin()}"
    )

    return output_path


# ===========================================================================
# Transforms de Preprocesamiento MONAI (Regla 2)
# ===========================================================================
def get_preprocessing_transforms() -> Optional["Compose"]:
    """
    Define el pipeline de preprocesamiento estándar para CT de pulmón
    usando monai.transforms.

    Transforms aplicadas (en orden):
      1. LoadImaged       — Carga el volumen NIfTI desde disco.
      2. EnsureChannelFirstd — Garantiza formato (C, H, W, D).
      3. Spacingd          — Remuestreo isotrópico a 1.5mm en cada eje.
      4. ScaleIntensityRanged — Normalización de ventana Hounsfield
                                [-1000, +400] HU → [0.0, 1.0].

    Returns:
        Compose de MONAI con las transforms, o None si MONAI no está disponible.
    """
    if not MONAI_AVAILABLE:
        logger.warning("MONAI no disponible — transforms no configuradas")
        return None

    transforms = Compose([
        # 1. Carga el NIfTI y retorna un dict con key "image"
        LoadImaged(keys=["image"]),

        # 2. Asegura que el tensor tenga dimensión de canal al inicio: (C, H, W, D)
        EnsureChannelFirstd(keys=["image"]),

        # 3. Remuestreo isotrópico: normaliza la resolución espacial
        #    a 1.5mm en cada eje para que el modelo reciba inputs consistentes
        Spacingd(
            keys=["image"],
            pixdim=TARGET_SPACING,
            mode="bilinear",
        ),

        # 4. Normalización de intensidad: ventana pulmonar Hounsfield
        #    Aire = -1000 HU, Tejido blando/calcificación = +400 HU
        #    Se mapea linealmente a [0.0, 1.0] con clipping
        ScaleIntensityRanged(
            keys=["image"],
            a_min=HU_WINDOW_MIN,
            a_max=HU_WINDOW_MAX,
            b_min=0.0,
            b_max=1.0,
            clip=True,
        ),
    ])

    logger.info(
        f"Pipeline de preprocesamiento configurado: "
        f"Spacing={TARGET_SPACING}, HU=[{HU_WINDOW_MIN}, {HU_WINDOW_MAX}]"
    )

    return transforms


# ===========================================================================
# Configuración del Inferer (Regla 2: CPU + Sliding Window)
# ===========================================================================
def get_inferer() -> Optional["SlidingWindowInferer"]:
    """
    Configura el SlidingWindowInferer de MONAI para inferencia en parches.

    Regla 2: Usa un tamaño de parche [64, 64, 64] deliberadamente pequeño
    para garantizar que el proceso no cause errores OOM en hardware local
    con ≤4GB de VRAM. El overlap de 0.25 (25%) proporciona continuidad
    entre parches adyacentes.

    Returns:
        SlidingWindowInferer configurado, o None si MONAI no está disponible.
    """
    if not MONAI_AVAILABLE:
        logger.warning("MONAI no disponible — inferer no configurado")
        return None

    inferer = SlidingWindowInferer(
        roi_size=PATCH_SIZE,
        sw_batch_size=1,  # Un parche a la vez para minimizar uso de memoria
        overlap=SLIDING_WINDOW_OVERLAP,
        mode="gaussian",  # Ponderación gaussiana para suavizar bordes de parche
    )

    logger.info(
        f"SlidingWindowInferer configurado: "
        f"patch_size={PATCH_SIZE}, overlap={SLIDING_WINDOW_OVERLAP}"
    )

    return inferer


# ===========================================================================
# Pipeline Principal de Inferencia
# ===========================================================================
def run_inference_pipeline(
    job_id: str,
    request_data: dict,
    dicom_dir: Path | None = None,
    progress_callback: callable = None,
) -> dict:
    """
    Ejecuta el pipeline completo de segmentación pulmonar.

    Flujo actual:
      1. Configura el dispositivo (CPU).
      2. Convierte DICOM → NIfTI usando SimpleITK (archivos reales).
      3. Aplica transforms de preprocesamiento MONAI (datos reales).
      4. Inferencia: retorna resultados mock (modelo real en Fase 2).
      5. Genera archivos de salida NIfTI (máscara mock basada en volumen real).

    Args:
        job_id: Identificador único del Job.
        request_data: Diccionario con el payload del request original.
        dicom_dir: Path al directorio con archivos DICOM reales.
                   Si None, usa fallback mock.
        progress_callback: Función opcional callback(percentage, message)
                           para reportar progreso al worker.

    Returns:
        dict con clinical_results y artifacts.
    """
    logger.info(f"[{job_id}] Iniciando pipeline de inferencia...")

    def _report(pct: int, msg: str):
        """Reporta progreso si hay callback disponible."""
        if progress_callback:
            progress_callback(pct, msg)
        logger.info(f"[{job_id}] {msg}")

    # --- 1. Configurar dispositivo ---
    # Regla 2: Forzar CPU para evitar OOM en hardware local
    if MONAI_AVAILABLE:
        device = torch.device("cpu")
        logger.info(f"[{job_id}] Dispositivo configurado: {device}")
    else:
        logger.info(f"[{job_id}] MONAI no disponible — modo mock completo")

    # --- 2. Crear directorio de salida para este Job ---
    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- 3. Conversión DICOM → NIfTI (datos reales) ---
    nifti_path = output_dir / "volume.nii.gz"

    if dicom_dir and MONAI_AVAILABLE:
        _report(20, f"Convirtiendo DICOM a NIfTI desde: {dicom_dir}")
        nifti_path = convert_dicom_to_nifti(dicom_dir, nifti_path)
        _report(35, f"Volumen NIfTI generado: {nifti_path}")
    else:
        _report(20, "Sin directorio DICOM o MONAI — omitiendo conversión")

    # --- 4. Preprocesamiento MONAI (datos reales) ---
    preprocessed_data = None

    if MONAI_AVAILABLE and nifti_path.exists() and nifti_path.stat().st_size > 0:
        _report(40, "Aplicando preprocesamiento MONAI...")

        transforms = get_preprocessing_transforms()
        if transforms:
            try:
                # Ejecutar transforms sobre el volumen NIfTI real
                data_dict = {"image": str(nifti_path)}
                preprocessed_data = transforms(data_dict)

                # Log de las dimensiones del tensor preprocesado
                img_tensor = preprocessed_data["image"]
                _report(
                    55,
                    f"Preprocesamiento completado — "
                    f"Tensor shape: {list(img_tensor.shape)}, "
                    f"dtype: {img_tensor.dtype}, "
                    f"rango: [{img_tensor.min():.3f}, {img_tensor.max():.3f}]"
                )
            except Exception as e:
                logger.warning(
                    f"[{job_id}] Error en preprocesamiento MONAI: {e}. "
                    f"Continuando con resultados mock.",
                    exc_info=True,
                )
                _report(55, f"Preprocesamiento falló — continuando con mock")
    else:
        _report(55, "Volumen NIfTI no disponible — omitiendo preprocesamiento")

    # --- 5. Inferencia (mock — modelo real en Fase 2) ---
    _report(60, "Ejecutando inferencia SegResNet (mock en esta fase)...")

    # Configurar inferer (listo para Fase 2)
    inferer = get_inferer()
    if inferer:
        logger.info(
            f"[{job_id}] SlidingWindowInferer configurado "
            f"(se activará con modelo real en Fase 2)"
        )

    # TODO: Fase 2 — Reemplazar este bloque con inferencia real:
    #
    # model_path = LOCAL_STORAGE_BASE / "models" / "SegResNet_Lung_v2.1.pth"
    # model = load_segresnet_model(model_path, device)
    # model.eval()
    #
    # with torch.no_grad():
    #     input_tensor = preprocessed_data["image"].unsqueeze(0).to(device)
    #     prediction = inferer(input_tensor, model)
    #
    # mask = (prediction > 0.5).squeeze().cpu().numpy()

    _report(75, "Inferencia completada — generando archivos de salida...")

    # --- 6. Generar archivos de salida ---
    _generate_output_files(output_dir, preprocessed_data)

    _report(90, "Postprocesamiento y cálculo volumétrico (mock)...")

    # --- 7. Construir resultados ---
    result = {
        "clinical_results": get_mock_clinical_results(),
        "artifacts": get_mock_artifacts(job_id),
    }

    logger.info(
        f"[{job_id}] Pipeline completado | "
        f"Volumen: {result['clinical_results']['volumetric_data']['volume_ml']} ml | "
        f"Confianza: {result['clinical_results']['recist_metrics']['confidence_score']}"
    )

    return result


# ===========================================================================
# Generación de archivos de salida
# ===========================================================================
def _generate_output_files(
    output_dir: Path,
    preprocessed_data: dict | None = None,
) -> None:
    """
    Genera los archivos NIfTI de salida (máscara y mapa de incertidumbre).

    Si hay datos preprocesados disponibles, genera una máscara mock con las
    mismas dimensiones del volumen real. Si no, genera archivos pequeños
    placeholder.

    Args:
        output_dir: Directorio donde guardar los archivos de salida.
        preprocessed_data: Dict con el tensor preprocesado (key "image"),
                          o None si no hay datos reales.
    """
    if not MONAI_AVAILABLE:
        # Sin SimpleITK: crear archivos vacíos como placeholder
        for filename in ["mask.nii.gz", "uncertainty.nii.gz"]:
            filepath = output_dir / filename
            filepath.touch(exist_ok=True)
        logger.info(f"Archivos placeholder vacíos creados en: {output_dir}")
        return

    # Determinar dimensiones de la máscara
    if preprocessed_data is not None and "image" in preprocessed_data:
        # Usar las dimensiones reales del volumen preprocesado
        img_tensor = preprocessed_data["image"]
        # Tensor shape es (C, H, W, D) — extraer dimensiones espaciales
        spatial_shape = img_tensor.shape[1:]  # (H, W, D)
        logger.info(
            f"Generando máscara mock con dimensiones del volumen real: "
            f"{list(spatial_shape)}"
        )

        # Máscara de segmentación mock: ceros con una región central marcada
        mask_array = np.zeros(spatial_shape, dtype=np.uint8)
        # Simular una lesión en la región central (~10% del volumen)
        h, w, d = spatial_shape
        ch, cw, cd = h // 2, w // 2, d // 2
        rh, rw, rd = max(h // 10, 2), max(w // 10, 2), max(d // 10, 2)
        mask_array[
            ch - rh : ch + rh,
            cw - rw : cw + rw,
            cd - rd : cd + rd,
        ] = 1

        # Extraer spacing del volumen preprocesado (si disponible via meta)
        spacing = TARGET_SPACING
        if hasattr(img_tensor, "meta") and "pixdim" in img_tensor.meta:
            spacing = tuple(img_tensor.meta["pixdim"][1:4].tolist())

    else:
        # Fallback: volumen mock pequeño (8x8x8)
        logger.info("Sin datos preprocesados — generando máscara mock 8x8x8")
        mask_array = np.zeros((8, 8, 8), dtype=np.uint8)
        mask_array[3:5, 3:5, 3:5] = 1
        spacing = TARGET_SPACING

    # Escribir máscara de segmentación NIfTI
    mask_image = sitk.GetImageFromArray(mask_array)
    mask_image.SetSpacing(spacing)
    mask_path = output_dir / "mask.nii.gz"
    sitk.WriteImage(mask_image, str(mask_path))
    logger.info(f"Máscara de segmentación guardada: {mask_path}")

    # Escribir mapa de incertidumbre NIfTI (valores bajos aleatorios)
    uncertainty_array = (
        np.random.rand(*mask_array.shape).astype(np.float32) * 0.1
    )
    uncertainty_image = sitk.GetImageFromArray(uncertainty_array)
    uncertainty_image.SetSpacing(spacing)
    uncertainty_path = output_dir / "uncertainty.nii.gz"
    sitk.WriteImage(uncertainty_image, str(uncertainty_path))
    logger.info(f"Mapa de incertidumbre guardado: {uncertainty_path}")

