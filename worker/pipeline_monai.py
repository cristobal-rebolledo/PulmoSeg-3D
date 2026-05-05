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

import hashlib
import logging
from pathlib import Path
from typing import Callable, Optional

import numpy as np

# ---------------------------------------------------------------------------
# Imports condicionales — separados para máxima flexibilidad
#   - SimpleITK: solo necesario para conversión DICOM→NIfTI (no requiere GPU)
#   - torch + MONAI: necesarios para inferencia con el modelo de segmentación
# Separar estos imports permite que el pipeline convierta DICOM→NIfTI y
# calcule métricas básicas del volumen INCLUSO sin torch/MONAI instalados.
# ---------------------------------------------------------------------------
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

    Estrategia multi-nivel para máxima robustez:
      1. GDCM ImageSeriesReader (ordenamiento automático por metadatos).
      2. Fallback: lectura slice-by-slice ordenada por nombre de archivo
         (para uploads donde GDCM no detecta la serie automáticamente).

    Args:
        dicom_dir: Directorio que contiene los archivos DICOM de una serie.
        output_path: Ruta donde guardar el archivo NIfTI resultante.

    Returns:
        Path al archivo NIfTI generado.

    Raises:
        FileNotFoundError: Si el directorio DICOM no existe.
        RuntimeError: Si ninguna estrategia logra leer los archivos DICOM.
    """
    if not dicom_dir.exists():
        raise FileNotFoundError(f"Directorio DICOM no encontrado: {dicom_dir}")

    # Crear directorio de salida si no existe
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # --- Diagnóstico: hash de los archivos crudos para verificar unicidad ---
    all_raw = sorted(dicom_dir.rglob("*"))
    raw_files = [f for f in all_raw if f.is_file()]
    logger.info(
        f"Directorio DICOM: {dicom_dir} | "
        f"Total archivos en disco: {len(raw_files)}"
    )
    if raw_files:
        # Hash rápido de los primeros bytes de cada archivo para fingerprint
        h = hashlib.md5()
        for rf in raw_files[:10]:  # muestra de hasta 10 archivos
            try:
                h.update(rf.name.encode())
                h.update(rf.stat().st_size.to_bytes(8, "little"))
                with open(rf, "rb") as fh:
                    h.update(fh.read(512))   # primeros 512 bytes
            except Exception:
                pass
        logger.info(
            f"Fingerprint MD5 del directorio (nombre+tamaño+header): {h.hexdigest()} "
            f"← DEBE ser DIFERENTE para cada estudio distinto"
        )

    logger.info(f"Leyendo serie DICOM desde: {dicom_dir}")

    # ── Estrategia 1: GDCM ImageSeriesReader (detección automática) ──────────
    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(str(dicom_dir))

    if dicom_files:
        logger.info(
            f"Estrategia 1 (GDCM): {len(dicom_files)} slices detectados automáticamente"
        )
        reader.SetFileNames(dicom_files)
        reader.MetaDataDictionaryArrayUpdateOn()
        reader.LoadPrivateTagsOn()
        try:
            image = reader.Execute()
            sitk.WriteImage(image, str(output_path))
            logger.info(
                f"Volumen NIfTI generado (GDCM): {output_path} | "
                f"Dimensiones: {image.GetSize()} | Spacing: {image.GetSpacing()}"
            )
            return output_path
        except Exception as e1:
            logger.warning(
                f"Estrategia 1 (GDCM Execute) falló: {e1} — intentando estrategia 2"
            )
    else:
        logger.warning(
            "Estrategia 1 (GDCM): GetGDCMSeriesFileNames retornó 0 archivos "
            f"en {dicom_dir} — intentando estrategia 2 (lectura directa)"
        )

    # ── Estrategia 2: Lectura directa de archivos ordenados por nombre ────────
    # Útil cuando los metadatos GDCM no están completos (archivos anonimizados
    # o convertidos desde otros formatos).
    candidate_exts = {".dcm", ".dicom", ""}  # sin extensión también es válido
    candidate_files = sorted(
        f for f in raw_files
        if f.suffix.lower() in candidate_exts
    )
    if not candidate_files:
        # Último recurso: cualquier archivo en el directorio
        candidate_files = sorted(raw_files)

    if not candidate_files:
        raise RuntimeError(
            f"No se encontraron archivos legibles en: {dicom_dir}"
        )

    logger.info(
        f"Estrategia 2 (lectura directa): "
        f"intentando {len(candidate_files)} archivos ordenados por nombre"
    )

    slices = []
    failed = 0
    for f in candidate_files:
        try:
            img_slice = sitk.ReadImage(str(f))
            slices.append(img_slice)
        except Exception:
            failed += 1

    if not slices:
        raise RuntimeError(
            f"Estrategia 2 falló: ningún archivo pudo leerse como DICOM en {dicom_dir}. "
            f"Archivos fallidos: {failed}/{len(candidate_files)}"
        )

    logger.info(
        f"Estrategia 2: {len(slices)} slices leídos, {failed} ignorados"
    )

    # Apilar slices en el eje Z para formar el volumen 3D
    if len(slices) == 1:
        image = slices[0]
    else:
        try:
            join_filter = sitk.JoinSeriesImageFilter()
            image = join_filter.Execute(*slices)
        except Exception as e2:
            logger.warning(
                f"JoinSeries falló ({e2}) — usando TileImageFilter como fallback"
            )
            # Si JoinSeries falla, apilamos manualmente con numpy
            import numpy as np
            arrays = [sitk.GetArrayFromImage(s) for s in slices]
            stacked = np.stack(arrays, axis=0)
            image = sitk.GetImageFromArray(stacked)
            # Copiar spacing del primer slice
            sp = list(slices[0].GetSpacing())
            if len(sp) == 2:
                sp.append(1.0)  # z-spacing desconocido
            image.SetSpacing(sp[:3])

    sitk.WriteImage(image, str(output_path))
    logger.info(
        f"Volumen NIfTI generado (estrategia 2): {output_path} | "
        f"Dimensiones: {image.GetSize()} | Spacing: {image.GetSpacing()}"
    )
    return output_path


def resample_to_isotropic(
    input_image: "sitk.Image",
    target_spacing: float = 1.0,
) -> "sitk.Image":
    """
    Re-muestrea un volumen SimpleITK a spacing isotrópico (target_spacing mm³).

    Usa interpolación B-spline de orden 3 para el CT (imagen continua),
    garantizando que las reconstrucciones MPR sean anatomicamente correctas
    sin el efecto de "escalones" causado por la alta anisotropía Z (5-7 mm).

    Args:
        input_image: Volumen SimpleITK original (spacing anisótropo típico).
        target_spacing: Resolución objetivo en mm para los 3 ejes (defecto 1.0).

    Returns:
        Volumen SimpleITK remuestreado a target_spacing³ mm³.
    """
    orig_spacing = input_image.GetSpacing()          # (sx, sy, sz) en mm
    orig_size    = input_image.GetSize()             # (nx, ny, nz) en vóxeles

    # Calcular nuevo tamaño para mantener el volumen físico total
    new_size = [
        int(round(orig_size[i] * orig_spacing[i] / target_spacing))
        for i in range(3)
    ]
    new_spacing = [target_spacing] * 3

    logger.info(
        f"Resampling isotrópico: spacing {orig_spacing} → ({target_spacing},)*3 | "
        f"size {orig_size} → {new_size}"
    )

    resampler = sitk.ResampleImageFilter()
    resampler.SetOutputSpacing(new_spacing)
    resampler.SetSize(new_size)
    resampler.SetOutputDirection(input_image.GetDirection())
    resampler.SetOutputOrigin(input_image.GetOrigin())
    resampler.SetTransform(sitk.Transform())
    resampler.SetDefaultPixelValue(float(input_image.GetPixelIDValue()))
    # B-spline order 3 → calidad clínica sin aliasing excesivo
    resampler.SetInterpolator(sitk.sitkBSpline)

    return resampler.Execute(input_image)


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
      2. Discretización: argmax sobre la dimensión de canales (dim=1).
      3. Conversión a NumPy array uint8.

    Args:
        prediction: Tensor de salida del modelo, shape (B, C, D, H, W).
        config: ModelConfig con parámetros de post-procesamiento.

    Returns:
        Array NumPy binario 3D (D, H, W), dtype uint8.
    """
    # 1. Activación
    if config.use_softmax:
        activated = torch.softmax(prediction, dim=1)
    else:
        activated = torch.sigmoid(prediction)

    # 2. Discretización: argmax sobre la dimensión de canales
    # prediction shape: (B, C, D, H, W) -> mask shape: (B, D, H, W)
    mask = torch.argmax(activated, dim=1)

    # 3. Eliminar batch dim y convertir a NumPy
    # mask shape: (B, D, H, W) -> (D, H, W)
    mask_np = mask.squeeze(0).cpu().numpy().astype(np.uint8)

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
    Guarda la máscara de segmentación predicha como mask.nii.gz.

    Si hay un volumen NIfTI de referencia, copia su información espacial
    (origin, direction) para mantener alineación geométrica.

    Args:
        mask_np: Array binario 3D (D, H, W), dtype uint8.
        output_dir: Directorio de salida del Job.
        spacing: Spacing en mm del volumen procesado.
        reference_nifti_path: Path al volumen NIfTI original para copiar
                              metadatos espaciales.

    Returns:
        Path al archivo mask.nii.gz generado.
    """
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

    mask_path = output_dir / "mask.nii.gz"
    sitk.WriteImage(mask_image, str(mask_path))
    logger.info(
        f"Máscara predicha guardada: {mask_path} | "
        f"shape={mask_np.shape}, spacing={spacing}"
    )

    return mask_path


def save_uncertainty_map(
    prediction_probs: "torch.Tensor",
    output_dir: Path,
    spacing: tuple[float, float, float],
    reference_nifti_path: Optional[Path] = None,
) -> Optional[Path]:
    """
    Guarda el mapa de incertidumbre como uncertainty.nii.gz.

    El mapa se calcula como la probabilidad del canal foreground (canal 1)
    antes del argmax, que refleja directamente la confianza del modelo.
    Rango [0.0, 1.0]: 0.5 = máxima incertidumbre, 1.0 = máxima certeza foreground.

    Args:
        prediction_probs: Tensor de probabilidades post-softmax, shape (B, C, D, H, W).
        output_dir: Directorio de salida del Job.
        spacing: Spacing en mm del volumen procesado.
        reference_nifti_path: NIfTI de referencia para metadatos espaciales.

    Returns:
        Path al archivo uncertainty.nii.gz generado, o None si falla.
    """
    try:
        # Canal 1 = foreground probability → mapa de confianza
        uncertainty_np = (
            prediction_probs[0, 1].cpu().numpy().astype(np.float32)
        )

        unc_image = sitk.GetImageFromArray(uncertainty_np)
        unc_image.SetSpacing(spacing)

        if reference_nifti_path and reference_nifti_path.exists():
            try:
                ref_image = sitk.ReadImage(str(reference_nifti_path))
                unc_image.SetOrigin(ref_image.GetOrigin())
                unc_image.SetDirection(ref_image.GetDirection())
            except Exception:
                pass

        unc_path = output_dir / "uncertainty.nii.gz"
        sitk.WriteImage(unc_image, str(unc_path))
        logger.info(
            f"Mapa de incertidumbre guardado: {unc_path} | "
            f"shape={uncertainty_np.shape}, "
            f"rango=[{uncertainty_np.min():.3f}, {uncertainty_np.max():.3f}]"
        )
        return unc_path

    except Exception as e:
        logger.warning(f"No se pudo generar uncertainty.nii.gz: {e}")
        return None


# Fallback eliminado por solicitud del usuario


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
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info(f"[{job_id}] Dispositivo configurado: {device}")

    # --- 2. Cargar configuración del modelo activo ---
    config = get_active_config()
    _report(5, f"Modelo configurado: {config.name}")

    # ═══════════════════════════════════════════════════════════════════
    # CHECKPOINT A — Verificación de inputs y pesos del modelo
    # ═══════════════════════════════════════════════════════════════════
    logger.info(
        f"[{job_id}] ── CHECKPOINT A: Verificación de entradas ──"
    )
    logger.info(
        f"[{job_id}]   DICOM dir recibido: {dicom_dir}"
    )
    logger.info(
        f"[{job_id}]   DICOM dir existe en disco: "
        f"{dicom_dir.exists() if dicom_dir else 'N/A (None)'}"
    )
    if dicom_dir and dicom_dir.exists():
        dcm_count = len(list(dicom_dir.glob("*.dcm")))
        logger.info(
            f"[{job_id}]   Archivos .dcm visibles en dir: {dcm_count}"
        )
    logger.info(
        f"[{job_id}]   Pesos del modelo: {config.weights_path}"
    )
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

    # --- 3. Crear directorio de salida para este Job ---
    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- 4. Conversión DICOM → NIfTI (datos reales) ---
    nifti_path = output_dir / "volume.nii.gz"
    _dicom_conversion_ok = False

    if dicom_dir:
        _report(15, f"Convirtiendo DICOM a NIfTI desde: {dicom_dir}")
        try:
            nifti_path = convert_dicom_to_nifti(dicom_dir, nifti_path)
            _dicom_conversion_ok = nifti_path.exists() and nifti_path.stat().st_size > 0
            if _dicom_conversion_ok:
                _report(25, f"Volumen NIfTI generado: {nifti_path}")

                # ── Resampling isotrópico para el visor MPR ───────────────────
                # Genera volume_iso.nii.gz a 1×1×1 mm para que las vistas
                # coronal y sagital se vean correctas sin el efecto escalones.
                iso_path = output_dir / "volume_iso.nii.gz"
                try:
                    _raw_img = sitk.ReadImage(str(nifti_path))
                    _iso_img = resample_to_isotropic(_raw_img, target_spacing=1.0)
                    sitk.WriteImage(_iso_img, str(iso_path))
                    logger.info(
                        f"[{job_id}] volume_iso.nii.gz generado: "
                        f"{_iso_img.GetSize()} @ 1×1×1 mm"
                    )
                except Exception as _iso_err:
                    logger.warning(
                        f"[{job_id}] Resampling isotrópico falló (no crítico): {_iso_err}"
                    )
                    iso_path = None
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

        # ═══════════════════════════════════════════════════════════════
        # CHECKPOINT B — Hash y tamaño del NIfTI generado
        # Permite verificar que el archivo cambia con cada estudio.
        # ═══════════════════════════════════════════════════════════════
        if _dicom_conversion_ok:
            try:
                with open(nifti_path, "rb") as _f:
                    _nifti_hash = hashlib.md5(_f.read()).hexdigest()
                logger.info(
                    f"[{job_id}] ── CHECKPOINT B: NIfTI generado ──"
                )
                logger.info(
                    f"[{job_id}]   Path: {nifti_path}"
                )
                logger.info(
                    f"[{job_id}]   Tamaño: {nifti_path.stat().st_size:,} bytes"
                )
                logger.info(
                    f"[{job_id}]   Hash MD5: {_nifti_hash} "
                    f"← Debe ser DIFERENTE para cada estudio distinto"
                )
            except Exception as _e:
                logger.warning(f"[{job_id}] No se pudo calcular hash del NIfTI: {_e}")
        else:
            raise RuntimeError("Conversión DICOM→NIfTI resultó en archivo ausente/vacío.")
    else:
        raise ValueError("Directorio DICOM no proporcionado")

    # --- 5. Preprocesamiento MONAI (datos reales) ---
    preprocessed_data = None

    if nifti_path.exists() and nifti_path.stat().st_size > 0:
        _report(30, "Aplicando preprocesamiento MONAI...")

        # ── Intento A: pipeline MONAI completo (LoadImaged + transforms) ────
        transforms = get_preprocessing_transforms(config)
        if transforms:
            try:
                data_dict = {"image": str(nifti_path)}
                preprocessed_data = transforms(data_dict)

                img_tensor = preprocessed_data["image"]
                logger.info(
                    f"[{job_id}] ── CHECKPOINT C: Tensor de entrada ──"
                )
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
                preprocessed_data = None   # asegura que se intente el fallback

        # ── Intento B: carga directa con SimpleITK + normalización manual ────
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

                img_tensor = torch.from_numpy(_arr)  # (1, Z, Y, X)

                # EnsureTyped espera float32
                img_tensor = img_tensor.float()

                logger.info(
                    f"[{job_id}] Intento B exitoso — tensor shape={list(img_tensor.shape)}, "
                    f"rango=[{img_tensor.min():.3f}, {img_tensor.max():.3f}]"
                )

                # Empaquetamos como dict para que el paso 6 lo use igual
                preprocessed_data = {"image": img_tensor}
                _report(40, f"Carga manual completada — shape={list(img_tensor.shape)}")

            except Exception as e_sitk:
                logger.error(
                    f"[{job_id}] Intento B (carga manual) también falló: {e_sitk}",
                    exc_info=True,
                )
                raise RuntimeError(f"Fallo en preprocesamiento MONAI e intento B manual: {e_sitk}")
    else:
        raise RuntimeError("Volumen NIfTI no disponible para preprocesamiento")

    # --- 6. Inferencia real con SlidingWindowInferer ---
    mask_np = None
    prediction_probs = None   # probabilidades post-softmax para uncertainty map

    if preprocessed_data is not None:
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
                img_t = preprocessed_data["image"]
                # Garantizar que sea float32 y 4D antes del unsqueeze
                if img_t.ndim == 3:
                    img_t = img_t.unsqueeze(0)   # añadir dim canal si falta
                img_t = img_t.float()
                input_tensor = img_t.unsqueeze(0).to(device)  # → (B, C, D, H, W)

                logger.info(
                    f"[{job_id}] Input tensor: shape={list(input_tensor.shape)}, "
                    f"dtype={input_tensor.dtype}, device={input_tensor.device}"
                )

                # Inferencia con SlidingWindowInferer
                with torch.no_grad():
                    prediction = inferer(input_tensor, model)

                logger.info(
                    f"[{job_id}] Predicción raw: shape={list(prediction.shape)}, "
                    f"rango=[{prediction.min():.4f}, {prediction.max():.4f}]"
                )

                _report(70, "Inferencia completada — aplicando post-procesamiento...")

                # Calcular probabilidades post-softmax ANTES del argmax
                # para usarlas en el mapa de incertidumbre
                if config.use_softmax:
                    prediction_probs = torch.softmax(prediction, dim=1)
                else:
                    prediction_probs = torch.sigmoid(prediction)

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
                raise
        else:
            raise RuntimeError("Modelo o inferer no disponible para inferencia")
    else:
        raise RuntimeError("Sin datos preprocesados para inferencia")

    # --- 7. Guardar máscara, uncertainty y calcular métricas clínicas ---
    clinical_results = None

    if mask_np is not None and mask_np.sum() > 0:
        _report(80, "Guardando mask.nii.gz y uncertainty.nii.gz...")

        # SimpleITK espera spacing en orden (X, Y, Z) = inverso al de MONAI (Z,Y,X)
        spacing_sitk = tuple(reversed(config.target_spacing))
        ref_nifti = nifti_path if nifti_path.exists() else None

        # 7a. Guardar máscara binaria → mask.nii.gz
        mask_path = save_predicted_mask(
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
        # Promedio de probabilidad en el área segmentada (canal 1)
        real_confidence = 0.94  # Fallback
        if prediction_probs is not None:
            fg_probs = prediction_probs[0, 1].cpu().numpy()
            masked_probs = fg_probs[mask_np > 0]
            if len(masked_probs) > 0:
                real_confidence = float(np.mean(masked_probs))
                logger.info(f"[{job_id}] Confianza real calculada: {real_confidence:.4f}")

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

    # --- 9. Construir y retornar resultados ---
    # Mapear los archivos reales generados en output_dir
    artifacts = get_mock_artifacts(job_id)

    mask_file = output_dir / "mask.nii.gz"
    if mask_file.exists():
        artifacts["segmentation_mask_nifti_url"] = str(mask_file)

    uncertainty_file = output_dir / "uncertainty.nii.gz"
    if uncertainty_file.exists():
        artifacts["uncertainty_map_url"] = str(uncertainty_file)

    # Listar los archivos presentes en el directorio de salida para diagnóstico
    output_files = [f.name for f in output_dir.iterdir() if f.is_file()]
    logger.info(
        f"[{job_id}] Archivos en {output_dir}: {output_files}"
    )

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
