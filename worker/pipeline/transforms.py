"""
worker/pipeline/transforms.py — Transforms de preprocesamiento MONAI.

Responsabilidades:
  - Definir el pipeline de transforms de MONAI para preparar el volumen NIfTI
    antes de pasarlo al modelo de segmentación.
  - Todas las transforms son configurables via ModelConfig (sin hardcoding).

Transforms aplicadas (en orden):
  1. LoadImaged         — Carga el volumen NIfTI desde disco.
  2. EnsureChannelFirstd — Garantiza formato (C, D, H, W).
  3. Orientationd       — Reorienta al sistema de coordenadas del modelo.
  4. Spacingd           — Remuestreo al spacing objetivo del modelo.
  5. ScaleIntensityRanged — Ventana Hounsfield específica del modelo.
  6. EnsureTyped        — Garantiza tipo tensor PyTorch float32.

Dependencias externas:
  - MONAI: framework de transforms para imágenes médicas.
"""

import logging
from typing import Optional

from monai.transforms import (
    Compose,
    EnsureChannelFirstd,
    EnsureTyped,
    LoadImaged,
    Orientationd,
    ScaleIntensityRanged,
    Spacingd,
)

from worker.model_config import ModelConfig

logger = logging.getLogger("pulmoseg.pipeline.transforms")


def get_preprocessing_transforms(config: ModelConfig) -> Optional[Compose]:
    """
    Define el pipeline de preprocesamiento según la configuración del modelo.

    Args:
        config: ModelConfig con los parámetros de preprocesamiento
                (spacing, ventana HU, orientación).

    Returns:
        Compose de MONAI con las transforms configuradas, o None si falla.
    """
    transforms = Compose([
        # 1. Carga el NIfTI y retorna un dict con key "image"
        LoadImaged(keys=["image"]),

        # 2. Asegura que el tensor tenga dimensión de canal al inicio: (C, D, H, W)
        EnsureChannelFirstd(keys=["image"]),

        # 3. Reorienta al sistema de coordenadas que espera el modelo (e.g. "RAS")
        Orientationd(keys=["image"], axcodes=config.orientation),

        # 4. Remuestreo al spacing objetivo del modelo
        Spacingd(
            keys=["image"],
            pixdim=config.target_spacing,
            mode="bilinear",
        ),

        # 5. Normalización de intensidad: ventana HU específica del modelo → [0.0, 1.0]
        ScaleIntensityRanged(
            keys=["image"],
            a_min=config.hu_window_min,
            a_max=config.hu_window_max,
            b_min=0.0,
            b_max=1.0,
            clip=True,
        ),

        # 6. Garantiza tipo tensor PyTorch float32
        EnsureTyped(keys=["image"]),
    ])

    logger.info(
        f"Pipeline de preprocesamiento configurado: "
        f"Spacing={config.target_spacing}, "
        f"HU=[{config.hu_window_min}, {config.hu_window_max}], "
        f"Orientación={config.orientation}"
    )

    return transforms
