"""
pipeline_monai.py — Pipeline de preprocesamiento e inferencia MONAI para PulmoSeg 3D.

Flujo completo del pipeline:
  1. Conversión DICOM → NIfTI (SimpleITK).
  2. Preprocesamiento MONAI (Orientación, Spacing, Ventana HU).
  3. Inferencia real con SlidingWindowInferer sobre el modelo cargado.
  4. Post-procesamiento: softmax → argmax → máscara binaria.
  5. Guardado de la máscara como mask_predicted.nii.gz.
  6. Cálculo de métricas clínicas con clinical_metrics.py.

Diseño modular:
  Todos los parámetros del modelo (arquitectura, preprocesamiento, inferer)
  se leen desde worker.model_config.ModelConfig.  Para cambiar de modelo
  solo hay que editar model_config.py → get_active_config().

Fallback graceful:
  Si el modelo .pt no existe o la inferencia falla, el pipeline cae al modo
  mock con un warning en el log.  El sistema nunca se rompe por falta del
  modelo.
"""

import logging
from pathlib import Path
from typing import Callable, Optional

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
    from monai.networks.nets import UNet
    from monai.transforms import (
        Activations,
        AsDiscrete,
        Compose,
        EnsureChannelFirstd,
        EnsureTyped,
        LoadImaged,
        Orientationd,
        ScaleIntensityRanged,
        Spacingd,
    )

    MONAI_AVAILABLE = True
except ImportError:
    MONAI_AVAILABLE = False

from worker.clinical_metrics import compute_clinical_metrics
from worker.mock_data import get_mock_artifacts, get_mock_clinical_results
from worker.model_config import ModelConfig, get_active_config

logger = logging.getLogger("pulmoseg.pipeline")

# Ruta base de almacenamiento local
LOCAL_STORAGE_BASE = Path("local_storage")


# ===========================================================================
# Conversión DICOM → NIfTI
# ===========================================================================
def convert_dicom_to_nifti(
    dicom_dir: str | Path,
    output_path: str | Path,
) -> Path:
    """
    Convierte una serie DICOM a un volumen NIfTI usando SimpleITK.

    Asume que el Toy Dataset viene limpio, ordenado y sin
    inconsistencias de metadatos severas.

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
# Transforms de Preprocesamiento MONAI (configurables por modelo)
# ===========================================================================
def get_preprocessing_transforms(config: ModelConfig) -> Optional["Compose"]:
    """
    Define el pipeline de preprocesamiento según la configuración del modelo.

    Transforms aplicadas (en orden):
      1. LoadImaged       — Carga el volumen NIfTI desde disco.
      2. EnsureChannelFirstd — Garantiza formato (C, D, H, W).
      3. Orientationd     — Reorienta al sistema de coordenadas del modelo.
      4. Spacingd         — Remuestreo al spacing objetivo del modelo.
      5. ScaleIntensityRanged — Ventana Hounsfield específica del modelo.
      6. EnsureTyped      — Garantiza tipo tensor PyTorch.

    Args:
        config: ModelConfig con los parámetros de preprocesamiento.

    Returns:
        Compose de MONAI con las transforms, o None si MONAI no está disponible.
    """
    if not MONAI_AVAILABLE:
        logger.warning("MONAI no disponible — transforms no configuradas")
        return None

    transforms = Compose([
        # 1. Carga el NIfTI y retorna un dict con key "image"
        LoadImaged(keys=["image"]),

        # 2. Asegura que el tensor tenga dimensión de canal al inicio
        EnsureChannelFirstd(keys=["image"]),

        # 3. Reorienta al sistema de coordenadas que espera el modelo
        Orientationd(keys=["image"], axcodes=config.orientation),

        # 4. Remuestreo al spacing objetivo del modelo
        Spacingd(
            keys=["image"],
            pixdim=config.target_spacing,
            mode="bilinear",
        ),

        # 5. Normalización de intensidad: ventana HU específica del modelo
        ScaleIntensityRanged(
            keys=["image"],
            a_min=config.hu_window_min,
            a_max=config.hu_window_max,
            b_min=0.0,
            b_max=1.0,
            clip=True,
        ),

        # 6. Garantiza tipo tensor PyTorch
        EnsureTyped(keys=["image"]),
    ])

    logger.info(
        f"Pipeline de preprocesamiento configurado: "
        f"Spacing={config.target_spacing}, "
        f"HU=[{config.hu_window_min}, {config.hu_window_max}], "
        f"Orientación={config.orientation}"
    )

    return transforms


# ===========================================================================
# Carga del Modelo (modular por configuración)
# ===========================================================================
def load_model(
    config: ModelConfig,
    device: "torch.device",
) -> Optional["torch.nn.Module"]:
    """
    Instancia la red neuronal y carga los pesos desde el checkpoint.

    Soporta dos formatos de checkpoint:
      1. Dict con clave (e.g. {"model": state_dict}) — checkpoint_key != None.
      2. State_dict directo — checkpoint_key == None.

    La arquitectura se instancia según config.network_type:
      - "UNet": monai.networks.nets.UNet

    Args:
        config: ModelConfig con la arquitectura y ruta al checkpoint.
        device: Dispositivo PyTorch donde cargar el modelo.

    Returns:
        Modelo listo para inferencia (.eval()), o None si falla.
    """
    if not MONAI_AVAILABLE:
        logger.warning("MONAI no disponible — modelo no cargado")
        return None

    weights_path = config.weights_path
    if not weights_path.exists():
        logger.error(
            f"Archivo de pesos no encontrado: {weights_path}\n"
            f"Descarga el bundle y coloca model.pt en esta ruta."
        )
        return None

    try:
        # --- 1. Instanciar la red según la arquitectura ---
        if config.network_type == "UNet":
            model = UNet(
                spatial_dims=config.spatial_dims,
                in_channels=config.in_channels,
                out_channels=config.out_channels,
                channels=list(config.channels),
                strides=list(config.strides),
                num_res_units=config.num_res_units,
                norm=config.norm,
            )
        else:
            # Punto de extensión para SegResNet u otras arquitecturas
            raise ValueError(
                f"Arquitectura no soportada: {config.network_type}. "
                f"Agrega soporte en load_model()."
            )

        logger.info(
            f"Red instanciada: {config.network_type} | "
            f"in={config.in_channels}, out={config.out_channels}, "
            f"channels={config.channels}"
        )

        # --- 2. Cargar pesos del checkpoint ---
        # Formatos de checkpoint soportados:
        #   a) Dict anidado:  {"model": state_dict, ...}
        #   b) Dict con key:  {"state_dict": state_dict, ...}
        #   c) state_dict directo: OrderedDict de pesos de capas
        checkpoint = torch.load(
            str(weights_path),
            map_location=device,
            weights_only=False,
        )

        if isinstance(checkpoint, dict) and config.checkpoint_key and config.checkpoint_key in checkpoint:
            # Formato (a): dict anidado con la clave configurada
            state_dict = checkpoint[config.checkpoint_key]
            logger.info(f"state_dict extraído con clave '{config.checkpoint_key}'")
        elif isinstance(checkpoint, dict) and "state_dict" in checkpoint:
            # Formato (b): convención alternativa común en PyTorch Lightning
            state_dict = checkpoint["state_dict"]
            logger.info("state_dict extraído con clave 'state_dict'")
        else:
            # Formato (c): el checkpoint cargado ES directamente el state_dict
            state_dict = checkpoint
            logger.info(
                "Checkpoint interpretado como state_dict directo "
                f"({len(state_dict)} parámetros)"
            )

        model.load_state_dict(state_dict)
        logger.info(f"Pesos cargados desde: {weights_path}")

        # --- 3. Preparar para inferencia ---
        model = model.to(device)
        model.eval()

        param_count = sum(p.numel() for p in model.parameters())
        logger.info(
            f"Modelo listo: {param_count:,} parámetros | "
            f"Device: {device} | Mode: eval"
        )

        return model

    except Exception as e:
        logger.error(
            f"Error cargando modelo desde {weights_path}: {e}",
            exc_info=True,
        )
        return None


# ===========================================================================
# Configuración del Inferer (configurable por modelo)
# ===========================================================================
def get_inferer(
    config: ModelConfig,
    device: "torch.device",
) -> Optional["SlidingWindowInferer"]:
    """
    Configura el SlidingWindowInferer según los parámetros del modelo.

    Selecciona sw_batch_size según el dispositivo:
      - GPU: usa config.sw_batch_size_gpu (mayor throughput).
      - CPU: usa config.sw_batch_size_cpu (conservador para evitar OOM).

    Args:
        config: ModelConfig con roi_size, overlap y batch sizes.
        device: Dispositivo para determinar el batch size.

    Returns:
        SlidingWindowInferer configurado, o None si MONAI no está disponible.
    """
    if not MONAI_AVAILABLE:
        logger.warning("MONAI no disponible — inferer no configurado")
        return None

    is_gpu = device.type == "cuda"
    sw_batch_size = config.sw_batch_size_gpu if is_gpu else config.sw_batch_size_cpu

    inferer = SlidingWindowInferer(
        roi_size=config.roi_size,
        sw_batch_size=sw_batch_size,
        overlap=config.overlap,
        mode="gaussian",  # Ponderación gaussiana para suavizar bordes
    )

    logger.info(
        f"SlidingWindowInferer configurado: "
        f"roi_size={config.roi_size}, overlap={config.overlap}, "
        f"sw_batch_size={sw_batch_size} ({'GPU' if is_gpu else 'CPU'})"
    )

    return inferer


# ===========================================================================
# Post-procesamiento de la predicción
# ===========================================================================
def postprocess_prediction(
    prediction: "torch.Tensor",
    config: ModelConfig,
) -> np.ndarray:
    """
    Convierte los logits/probabilidades de salida en una máscara binaria.

    Pipeline de post-procesamiento:
      1. Activación: softmax (multi-clase) o sigmoid (binario).
      2. Discretización: argmax sobre canales.
      3. Extracción: selecciona el canal foreground como máscara binaria.
      4. Conversión a NumPy array uint8.

    Args:
        prediction: Tensor de salida del modelo, shape (B, C, D, H, W).
        config: ModelConfig con parámetros de post-procesamiento.

    Returns:
        Array NumPy binario 3D (D, H, W), dtype uint8.
    """
    # Activación
    if config.use_softmax:
        activation = Activations(softmax=True)
    else:
        activation = Activations(sigmoid=True)

    activated = activation(prediction)

    # Discretización: argmax sobre la dimensión de canales
    discretize = AsDiscrete(argmax=True)
    discrete = discretize(activated)

    # Squeeze batch dim y convertir a NumPy
    # discrete shape: (B, 1, D, H, W) → (D, H, W)
    mask_np = discrete.squeeze(0).squeeze(0).cpu().numpy().astype(np.uint8)

    n_foreground = int(mask_np.sum())
    total_voxels = int(np.prod(mask_np.shape))
    pct = (n_foreground / total_voxels) * 100 if total_voxels > 0 else 0

    logger.info(
        f"Post-procesamiento completado: "
        f"shape={mask_np.shape}, "
        f"vóxeles foreground={n_foreground:,} ({pct:.2f}%)"
    )

    return mask_np


# ===========================================================================
# Guardado de la máscara predicha como NIfTI
# ===========================================================================
def save_predicted_mask(
    mask_np: np.ndarray,
    output_dir: Path,
    spacing: tuple[float, float, float],
    reference_nifti_path: Optional[Path] = None,
) -> Path:
    """
    Guarda la máscara de segmentación predicha como archivo NIfTI.

    Si hay un volumen NIfTI de referencia, copia su información espacial
    (origin, direction) para mantener alineación geométrica.

    Args:
        mask_np: Array binario 3D (D, H, W), dtype uint8.
        output_dir: Directorio de salida del Job.
        spacing: Spacing en mm del volumen procesado.
        reference_nifti_path: Path al volumen NIfTI original para copiar
                              metadatos espaciales.

    Returns:
        Path al archivo mask_predicted.nii.gz generado.
    """
    if not MONAI_AVAILABLE:
        placeholder = output_dir / "mask_predicted.nii.gz"
        placeholder.touch(exist_ok=True)
        return placeholder

    mask_image = sitk.GetImageFromArray(mask_np.astype(np.uint8))
    mask_image.SetSpacing(spacing)

    # Copiar metadatos espaciales del volumen de referencia si existe
    if reference_nifti_path and reference_nifti_path.exists():
        try:
            ref_image = sitk.ReadImage(str(reference_nifti_path))
            mask_image.SetOrigin(ref_image.GetOrigin())
            mask_image.SetDirection(ref_image.GetDirection())
            logger.info("Metadatos espaciales copiados del volumen de referencia")
        except Exception as e:
            logger.warning(
                f"No se pudieron copiar metadatos de referencia: {e}"
            )

    mask_path = output_dir / "mask_predicted.nii.gz"
    sitk.WriteImage(mask_image, str(mask_path))
    logger.info(
        f"Máscara predicha guardada: {mask_path} | "
        f"shape={mask_np.shape}, spacing={spacing}"
    )

    return mask_path


# ===========================================================================
# Pipeline Principal de Inferencia
# ===========================================================================
def run_inference_pipeline(
    job_id: str,
    request_data: dict,
    dicom_dir: Path | None = None,
    progress_callback: Callable | None = None,
) -> dict:
    """
    Ejecuta el pipeline completo de segmentación.

    Flujo:
      1. Configura dispositivo (CUDA si disponible, si no CPU).
      2. Carga la configuración del modelo activo.
      3. Convierte DICOM → NIfTI usando SimpleITK.
      4. Aplica transforms de preprocesamiento según el modelo.
      5. Carga el modelo y ejecuta inferencia con SlidingWindowInferer.
      6. Post-procesa: softmax → argmax → máscara binaria.
      7. Guarda máscara como mask_predicted.nii.gz.
      8. Calcula métricas clínicas desde la máscara real.
      9. Si cualquier paso falla, cae al modo mock.

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
    if MONAI_AVAILABLE:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"[{job_id}] Dispositivo configurado: {device}")
    else:
        device = None
        logger.info(f"[{job_id}] MONAI no disponible — modo mock completo")

    # --- 2. Cargar configuración del modelo activo ---
    config = get_active_config()
    _report(5, f"Modelo configurado: {config.name}")

    # --- 3. Crear directorio de salida para este Job ---
    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- 4. Conversión DICOM → NIfTI (datos reales) ---
    nifti_path = output_dir / "volume.nii.gz"

    if dicom_dir and MONAI_AVAILABLE:
        _report(15, f"Convirtiendo DICOM a NIfTI desde: {dicom_dir}")
        nifti_path = convert_dicom_to_nifti(dicom_dir, nifti_path)
        _report(25, f"Volumen NIfTI generado: {nifti_path}")
    else:
        _report(15, "Sin directorio DICOM o MONAI — omitiendo conversión")

    # --- 5. Preprocesamiento MONAI (datos reales) ---
    preprocessed_data = None

    if MONAI_AVAILABLE and nifti_path.exists() and nifti_path.stat().st_size > 0:
        _report(30, "Aplicando preprocesamiento MONAI...")

        transforms = get_preprocessing_transforms(config)
        if transforms:
            try:
                data_dict = {"image": str(nifti_path)}
                preprocessed_data = transforms(data_dict)

                img_tensor = preprocessed_data["image"]
                _report(
                    40,
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
                _report(40, "Preprocesamiento falló — continuando con mock")
    else:
        _report(40, "Volumen NIfTI no disponible — omitiendo preprocesamiento")

    # --- 6. Inferencia real con SlidingWindowInferer ---
    mask_np = None

    if MONAI_AVAILABLE and preprocessed_data is not None:
        _report(45, f"Cargando modelo: {config.name}...")

        model = load_model(config, device)
        inferer = get_inferer(config, device)

        if model is not None and inferer is not None:
            try:
                _report(
                    50,
                    f"Ejecutando inferencia por parches "
                    f"(roi_size={config.roi_size}, overlap={config.overlap})..."
                )

                # Preparar tensor de entrada: (C, D, H, W) → (B, C, D, H, W)
                input_tensor = preprocessed_data["image"].unsqueeze(0).to(device)
                logger.info(
                    f"[{job_id}] Input tensor: shape={list(input_tensor.shape)}, "
                    f"device={input_tensor.device}"
                )

                # Inferencia con SlidingWindowInferer
                with torch.no_grad():
                    prediction = inferer(input_tensor, model)

                logger.info(
                    f"[{job_id}] Predicción raw: shape={list(prediction.shape)}, "
                    f"rango=[{prediction.min():.4f}, {prediction.max():.4f}]"
                )

                _report(70, "Inferencia completada — aplicando post-procesamiento...")

                # Post-procesamiento: softmax → argmax → máscara binaria
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
                _report(70, f"Inferencia falló: {e} — usando mock")
                mask_np = None
        else:
            _report(
                70,
                "Modelo o inferer no disponible — usando resultados mock"
            )
    else:
        _report(70, "Sin datos preprocesados — usando resultados mock")

    # --- 7. Guardar máscara y calcular métricas clínicas ---
    clinical_results = None

    if mask_np is not None and mask_np.sum() > 0:
        _report(80, "Guardando máscara predicha como NIfTI...")

        # El spacing para SimpleITK debe estar en orden (W, H, D)
        # El config.target_spacing está en orden MONAI (D, H, W) si
        # no se reorientó, pero con Orientationd(RAS) los ejes son (R, A, S).
        # Usamos el spacing tal como lo define el config para consistencia.
        spacing_sitk = tuple(reversed(config.target_spacing))

        mask_path = save_predicted_mask(
            mask_np=mask_np,
            output_dir=output_dir,
            spacing=spacing_sitk,
            reference_nifti_path=nifti_path if nifti_path.exists() else None,
        )

        _report(85, "Calculando métricas clínicas desde la máscara predicha...")

        try:
            clinical_results = compute_clinical_metrics(
                mask=mask_np,
                voxel_spacing=config.target_spacing,
                lesion_id="L1",
            )
            logger.info(
                f"[{job_id}] Métricas clínicas calculadas desde predicción real"
            )
        except Exception as e:
            logger.warning(
                f"[{job_id}] Error calculando métricas: {e}. Usando mock.",
                exc_info=True,
            )
    else:
        if mask_np is not None and mask_np.sum() == 0:
            _report(
                85,
                "Máscara vacía (0 vóxeles positivos) — usando resultados mock"
            )
        _report(85, "Generando resultados mock...")

    # --- 8. Fallback a mock si no se calcularon métricas ---
    if clinical_results is None:
        clinical_results = get_mock_clinical_results()
        logger.info(f"[{job_id}] Usando resultados clínicos mock")

    _report(90, "Construyendo resultado final...")

    # --- 9. Construir y retornar resultados ---
    # Actualizar artifacts con la ruta real de la máscara predicha
    artifacts = get_mock_artifacts(job_id)
    predicted_mask_file = output_dir / "mask_predicted.nii.gz"
    if predicted_mask_file.exists():
        artifacts["segmentation_mask_nifti_url"] = str(predicted_mask_file)

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
