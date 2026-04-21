"""
model_config.py — Configuración modular de modelos MONAI para PulmoSeg 3D.

Centraliza TODOS los parámetros específicos de un bundle/modelo en un solo
lugar.  Cuando se cambie del modelo temporal (spleen) al modelo de pulmón
definitivo, solo hay que:
  1. Crear una nueva instancia de ModelConfig con los valores del nuevo bundle.
  2. Actualizar get_active_config() para retornarla.

Parámetros cubiertos:
  - Ruta al checkpoint (.pt)
  - Arquitectura de red (tipo, canales, strides, normalización)
  - Preprocesamiento (HU window, spacing, orientación)
  - Inferer (roi_size, overlap, sw_batch_size)
  - Post-procesamiento (out_channels, activación)
"""

import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("pulmoseg.config")

# Ruta base de almacenamiento local
LOCAL_STORAGE_BASE = Path("local_storage")


@dataclass(frozen=True)
class ModelConfig:
    """
    Configuración inmutable de un modelo de segmentación MONAI.

    Cada instancia describe completamente cómo cargar, preprocesar,
    inferir y post-procesar con un modelo específico.

    Attributes:
        name:               Nombre legible del modelo.
        bundle_dir:         Directorio raíz del bundle MONAI.
        weights_path:       Ruta al archivo .pt con los pesos.
        checkpoint_key:     Clave dentro del checkpoint que contiene el
                            state_dict (None si el .pt ES el state_dict).

        # Arquitectura de red
        network_type:       Tipo de red ("UNet", "SegResNet", etc.).
        spatial_dims:       Dimensiones espaciales (2D o 3D).
        in_channels:        Canales de entrada (1 para CT).
        out_channels:       Canales de salida (clases incluyendo fondo).
        channels:           Lista de canales por nivel del encoder.
        strides:            Lista de strides entre niveles.
        num_res_units:      Unidades residuales por bloque.
        norm:               Tipo de normalización ("batch", "instance").

        # Preprocesamiento
        hu_window_min:      Límite inferior de la ventana Hounsfield.
        hu_window_max:      Límite superior de la ventana Hounsfield.
        target_spacing:     Resolución isotrópica objetivo en mm (D, H, W).
        orientation:        Código de orientación anatómica (e.g. "RAS").

        # Inferer
        roi_size:           Tamaño del parche para SlidingWindowInferer.
        overlap:            Fracción de overlap entre parches (0.0–1.0).
        sw_batch_size_gpu:  Parches simultáneos en GPU.
        sw_batch_size_cpu:  Parches simultáneos en CPU (conservador).

        # Post-procesamiento
        use_softmax:        Si True, aplica softmax antes de argmax.
                            Si False, aplica sigmoid + threshold.
        foreground_channel: Índice del canal que representa la estructura
                            de interés (nódulo/bazo/etc.).
    """
    # Identificación
    name: str = "Generic Model"
    bundle_dir: Path = LOCAL_STORAGE_BASE / "models" / "generic"
    weights_path: Path = LOCAL_STORAGE_BASE / "models" / "generic" / "model.pt"
    checkpoint_key: str | None = "model"

    # Arquitectura de red
    network_type: str = "UNet"
    spatial_dims: int = 3
    in_channels: int = 1
    out_channels: int = 2
    channels: tuple[int, ...] = (16, 32, 64, 128, 256)
    strides: tuple[int, ...] = (2, 2, 2, 2)
    num_res_units: int = 2
    norm: str = "batch"

    # Preprocesamiento
    hu_window_min: float = -1000.0
    hu_window_max: float = 400.0
    target_spacing: tuple[float, float, float] = (1.5, 1.5, 1.5)
    orientation: str = "RAS"

    # Inferer
    roi_size: tuple[int, int, int] = (96, 96, 96)
    overlap: float = 0.5
    sw_batch_size_gpu: int = 4
    sw_batch_size_cpu: int = 1

    # Post-procesamiento
    use_softmax: bool = True
    foreground_channel: int = 1


# ===========================================================================
# Configuraciones de modelos disponibles
# ===========================================================================

SPLEEN_CONFIG = ModelConfig(
    name="Spleen CT Segmentation (MONAI Bundle v0.5.9)",
    bundle_dir=LOCAL_STORAGE_BASE / "models" / "spleen_ct_segmentation",
    weights_path=(
        LOCAL_STORAGE_BASE
        / "models"
        / "spleen_ct_segmentation"
        / "models"
        / "model.pt"
    ),
    checkpoint_key="model",

    # Arquitectura — extraída de inference.json → network_def
    network_type="UNet",
    spatial_dims=3,
    in_channels=1,
    out_channels=2,
    channels=(16, 32, 64, 128, 256),
    strides=(2, 2, 2, 2),
    num_res_units=2,
    norm="batch",

    # Preprocesamiento — extraído de inference.json → preprocessing
    hu_window_min=-57.0,
    hu_window_max=164.0,
    target_spacing=(1.5, 1.5, 2.0),
    orientation="RAS",

    # Inferer — extraído de inference.json → inferer
    roi_size=(96, 96, 96),
    overlap=0.5,
    sw_batch_size_gpu=4,
    sw_batch_size_cpu=1,

    # Post-procesamiento — extraído de inference.json → postprocessing
    use_softmax=True,
    foreground_channel=1,  # channel 0 = background, channel 1 = spleen
)


# ---------------------------------------------------------------------------
# TODO: Cuando esté disponible el modelo de pulmón definitivo, agregar aquí:
#
# LUNG_CONFIG = ModelConfig(
#     name="SegResNet Lung v2.1",
#     bundle_dir=LOCAL_STORAGE_BASE / "models" / "lung_segmentation",
#     weights_path=LOCAL_STORAGE_BASE / "models" / "lung_segmentation" / "model.pt",
#     checkpoint_key=None,   # Si el .pt es directamente el state_dict
#
#     network_type="SegResNet",
#     spatial_dims=3,
#     in_channels=1,
#     out_channels=2,
#     channels=(...),
#     ...
#
#     hu_window_min=-1000.0,
#     hu_window_max=400.0,
#     target_spacing=(1.5, 1.5, 1.5),
#     ...
# )
# ---------------------------------------------------------------------------


def get_active_config() -> ModelConfig:
    """
    Retorna la configuración del modelo activo.

    Para cambiar de modelo, simplemente retorna una instancia diferente
    de ModelConfig (e.g. LUNG_CONFIG en lugar de SPLEEN_CONFIG).

    Returns:
        ModelConfig con todos los parámetros del modelo activo.
    """
    config = SPLEEN_CONFIG
    logger.info(
        f"Configuración activa: {config.name} | "
        f"Red: {config.network_type} | "
        f"Pesos: {config.weights_path}"
    )
    return config
