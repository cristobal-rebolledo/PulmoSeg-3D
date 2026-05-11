"""
worker/pipeline/inference.py — Carga del modelo y configuración del inferer.

Responsabilidades:
  - Instanciar la red neuronal (UNet MONAI) según ModelConfig.
  - Cargar los pesos del checkpoint (.pt) soportando múltiples formatos.
  - Configurar el SlidingWindowInferer con los parámetros correctos según
    el dispositivo disponible (GPU/CPU).

Formatos de checkpoint soportados:
  a) Dict anidado:    {"model": state_dict, ...}
  b) Dict alternativo: {"state_dict": state_dict, ...}
  c) state_dict directo: OrderedDict de pesos de capas

Dependencias externas:
  - PyTorch: motor de inferencia.
  - MONAI: UNet y SlidingWindowInferer.
"""

import logging
from typing import Optional

import torch
from monai.inferers import SlidingWindowInferer
from monai.networks.nets import UNet

from worker.model_config import ModelConfig

logger = logging.getLogger("pulmoseg.pipeline.inference")


def load_model(
    config: ModelConfig,
    device: torch.device,
) -> Optional[torch.nn.Module]:
    """
    Instancia la red neuronal y carga los pesos desde el checkpoint.

    Args:
        config: ModelConfig con la arquitectura y ruta al checkpoint.
        device: Dispositivo PyTorch donde cargar el modelo (cuda / cpu).

    Returns:
        Modelo en modo eval() listo para inferencia, o None si falla.
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
            # Punto de extensión para SegResNet u otras arquitecturas futuras
            raise ValueError(
                f"Arquitectura no soportada: {config.network_type}. "
                f"Agrega soporte en load_model() dentro de inference.py."
            )

        logger.info(
            f"Red instanciada: {config.network_type} | "
            f"in={config.in_channels}, out={config.out_channels}, "
            f"channels={config.channels}"
        )

        # --- 2. Cargar pesos del checkpoint ---
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
            # Formato (b): convención PyTorch Lightning
            state_dict = checkpoint["state_dict"]
            logger.info("state_dict extraído con clave 'state_dict'")
        else:
            # Formato (c): el checkpoint ES directamente el state_dict
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


def get_inferer(
    config: ModelConfig,
    device: torch.device,
) -> Optional[SlidingWindowInferer]:
    """
    Configura el SlidingWindowInferer según los parámetros del modelo.

    Selecciona sw_batch_size según el dispositivo:
      - GPU (cuda): usa config.sw_batch_size_gpu (mayor throughput).
      - CPU:        usa config.sw_batch_size_cpu (conservador, evita OOM).

    Args:
        config: ModelConfig con roi_size, overlap y batch sizes.
        device: Dispositivo para determinar el batch size óptimo.

    Returns:
        SlidingWindowInferer configurado, o None si MONAI no está disponible.
    """
    is_gpu = device.type == "cuda"
    sw_batch_size = config.sw_batch_size_gpu if is_gpu else config.sw_batch_size_cpu

    inferer = SlidingWindowInferer(
        roi_size=config.roi_size,
        sw_batch_size=sw_batch_size,
        overlap=config.overlap,
        mode="gaussian",  # Ponderación gaussiana para suavizar bordes entre parches
    )

    logger.info(
        f"SlidingWindowInferer configurado: "
        f"roi_size={config.roi_size}, overlap={config.overlap}, "
        f"sw_batch_size={sw_batch_size} ({'GPU' if is_gpu else 'CPU'})"
    )

    return inferer
