"""
worker/pipeline/postprocess.py — Post-procesamiento y persistencia de resultados.

Responsabilidades:
  - Convertir los logits del modelo en una máscara binaria 3D (uint8).
  - Guardar la máscara predicha alineada al espacio del volumen original.
  - Guardar el mapa de incertidumbre (probabilidades del canal foreground).

Alineación espacial:
  Las máscaras se resamplean al grid exacto del NIfTI original usando
  sitk.sitkNearestNeighbor para garantizar superposición pixel-a-pixel
  con el CT en el visor MPR, sin importar el spacing usado por el modelo.

Dependencias externas:
  - PyTorch: operaciones sobre tensores de salida del modelo.
  - SimpleITK: guardado de NIfTI con metadatos espaciales correctos.
  - NumPy: conversión y manejo de arrays.
"""

import logging
from pathlib import Path
from typing import Optional

import numpy as np
import SimpleITK as sitk
import torch

from worker.model_config import ModelConfig

logger = logging.getLogger("pulmoseg.pipeline.postprocess")


def postprocess_prediction(
    prediction: torch.Tensor,
    config: ModelConfig,
) -> np.ndarray:
    """
    Convierte los logits/probabilidades de salida del modelo en máscara binaria.

    Pipeline:
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
    # prediction shape: (B, C, D, H, W) → mask shape: (B, D, H, W)
    mask = torch.argmax(activated, dim=1)

    # 3. Eliminar batch dim y convertir a NumPy
    # mask shape: (B, D, H, W) → (D, H, W)
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


def save_predicted_mask(
    mask_np: np.ndarray,
    output_dir: Path,
    spacing: tuple,
    reference_nifti_path: Optional[Path] = None,
) -> Path:
    """
    Guarda la máscara de segmentación predicha como mask.nii.gz.

    Si hay un volumen NIfTI de referencia, RESAMPLEA la máscara al espacio
    exacto del volumen original (mismo tamaño, spacing, origin y direction).
    Esto garantiza que la máscara se superpone pixel-a-pixel con el DICOM
    en el visor, sin importar la orientación del NIfTI o el spacing del modelo.

    Args:
        mask_np: Array binario 3D (D, H, W), dtype uint8, en espacio del modelo.
        output_dir: Directorio de salida del Job.
        spacing: Spacing en mm del volumen procesado (espacio del modelo).
        reference_nifti_path: Path al volumen NIfTI original para alinear.

    Returns:
        Path al archivo mask.nii.gz generado.
    """
    # Construir imagen SimpleITK en el espacio del modelo
    mask_image = sitk.GetImageFromArray(mask_np.astype(np.uint8))
    # SimpleITK espera spacing como (x, y, z); numpy/MONAI entrega (z, y, x)
    mask_image.SetSpacing(tuple(reversed(spacing)))

    if reference_nifti_path and reference_nifti_path.exists():
        try:
            ref_image = sitk.ReadImage(str(reference_nifti_path))

            # Copiar metadatos del volumen original
            mask_image.SetOrigin(ref_image.GetOrigin())
            mask_image.SetDirection(ref_image.GetDirection())

            # Resamplear al grid exacto del volumen original
            resampled = sitk.Resample(
                mask_image,
                ref_image,
                sitk.Transform(),
                sitk.sitkNearestNeighbor,   # vecino más cercano para máscara binaria
                0,                           # valor por defecto (fondo)
                sitk.sitkUInt8,
            )
            logger.info(
                f"Máscara resampleada al espacio original: "
                f"shape={sitk.GetArrayFromImage(resampled).shape}, "
                f"spacing={resampled.GetSpacing()}"
            )
            mask_path = output_dir / "mask.nii.gz"
            sitk.WriteImage(resampled, str(mask_path))
            logger.info(f"Máscara predicha guardada: {mask_path}")
            return mask_path

        except Exception as e:
            logger.warning(
                f"No se pudo resamplear al espacio de referencia: {e}. "
                f"Guardando en espacio del modelo."
            )

    # Fallback: guardar sin resamplear (solo si no hay referencia)
    mask_path = output_dir / "mask.nii.gz"
    sitk.WriteImage(mask_image, str(mask_path))
    logger.info(
        f"Máscara predicha guardada (sin referencia): {mask_path} | "
        f"shape={mask_np.shape}, spacing={spacing}"
    )
    return mask_path


def save_uncertainty_map(
    prediction_probs: torch.Tensor,
    output_dir: Path,
    spacing: tuple,
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
