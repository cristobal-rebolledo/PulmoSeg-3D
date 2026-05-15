"""
worker/pipeline/postprocess.py — Post-procesamiento y persistencia de resultados.

Responsabilidades:
  - Convertir los logits del modelo en una máscara binaria 3D (uint8).
  - Guardar la máscara predicha alineada al espacio del volumen original.
  - Guardar el mapa de incertidumbre (probabilidades del canal foreground).

Alineación espacial:
  MONAI aplica Orientationd(axcodes="RAS") durante el preprocesamiento, lo que
  reorienta el volumen (flip de ejes X/Y en imágenes con dirección LPS). La
  máscara de salida del modelo está en este espacio RAS+resampled. Para
  posicionarla correctamente, se usa el affine del MetaTensor de MONAI (NIfTI/RAS)
  y se convierte a geometría SimpleITK (LPS) antes de resamplear al espacio
  original de la imagen de referencia.

Dependencias externas:
  - PyTorch: operaciones sobre tensores de salida del modelo.
  - SimpleITK: guardado de NIfTI con metadatos espaciales correctos.
  - NumPy: conversión y manejo de arrays.
"""

import logging
from pathlib import Path
from typing import Optional, Union

import numpy as np
import SimpleITK as sitk
import torch

from worker.model_config import ModelConfig

logger = logging.getLogger("pulmoseg.pipeline.postprocess")


def _affine_ras_to_sitk(
    affine_ras: "torch.Tensor | np.ndarray",
) -> tuple[tuple, tuple, tuple]:
    """
    Convierte un affine NIfTI/RAS (4×4) a la geometría que espera SimpleITK (LPS).

    MONAI guarda el affine de la imagen preprocesada en convenio RAS+ (mismo que NIfTI).
    SimpleITK usa el convenio LPS (ejes X e Y negados respecto a RAS).

    Args:
        affine_ras: Matriz affine 4×4 en convenio RAS (salida de MONAI MetaTensor).

    Returns:
        (spacing_xyz, origin_lps, direction_lps_flat)
        - spacing_xyz    : tupla (sx, sy, sz) en mm, orden SimpleITK (X, Y, Z)
        - origin_lps     : tupla (ox, oy, oz) en mm, convenio LPS
        - direction_lps_flat: tupla de 9 floats (matriz 3×3 aplanada, fila por fila)
    """
    if hasattr(affine_ras, "numpy"):
        A = affine_ras.numpy().astype(float)
    else:
        A = np.asarray(affine_ras, dtype=float)

    # Spacing = norma euclidiana de cada columna (primeras 3 cols de la submatriz 3×3)
    col_norms = np.linalg.norm(A[:3, :3], axis=0)          # shape (3,)
    spacing_xyz = tuple(col_norms.tolist())                  # (sx, sy, sz)

    # Cosenos directores (columnas normalizadas)
    dir_ras = A[:3, :3] / col_norms[np.newaxis, :]          # 3×3, columnwise

    # Conversión RAS → LPS: negar X e Y (primera y segunda fila del coseno)
    flip = np.diag([-1.0, -1.0, 1.0])
    dir_lps = flip @ dir_ras                                 # 3×3

    # Origin RAS → LPS
    origin_ras = A[:3, 3]
    origin_lps = flip @ origin_ras

    return (
        tuple(float(s) for s in spacing_xyz),
        tuple(float(o) for o in origin_lps),
        tuple(float(d) for d in dir_lps.flatten()),
    )



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
    monai_affine=None,
) -> Path:
    """
    Guarda la máscara de segmentación predicha como mask.nii.gz.

    Si hay un volumen NIfTI de referencia, RESAMPLEA la máscara al espacio
    exacto del volumen original. Cuando se proporciona monai_affine (affine del
    MetaTensor tras Orientationd+Spacingd), se usa para posicionar correctamente
    la máscara en el espacio físico antes de resamplear — esto es necesario porque
    MONAI reorienta el volumen a RAS, cambiando los ejes físicos de la imagen.

    Args:
        mask_np: Array binario 3D (D, H, W), dtype uint8, en espacio de MONAI.
        output_dir: Directorio de salida del Job.
        spacing: Spacing en mm del volumen procesado (fallback si no hay affine).
        reference_nifti_path: Path al volumen NIfTI original para alinear.
        monai_affine: Affine 4×4 del MetaTensor MONAI (NIfTI/RAS). Si se provee,
                      se usa para establecer la geometría correcta del mask antes
                      de resamplear. Si es None, se usa el enfoque legacy.

    Returns:
        Path al archivo mask.nii.gz generado.
    """
    if monai_affine is not None:
        # ── Modo MONAI: tensor en orden (X, Y, Z) ─────────────────────────────────
        # MONAI almacena el tensor como (X, Y, Z) pero SimpleITK espera
        # numpy en orden (Z, Y, X). Sin la transposición el bazo aparece
        # en la posición incorrecta (swap de ejes X↔Z).
        try:
            mask_for_sitk = mask_np.transpose(2, 1, 0).astype(np.uint8)  # (X,Y,Z)→(Z,Y,X)
            spacing_xyz, origin_lps, direction_flat = _affine_ras_to_sitk(monai_affine)
            mask_image = sitk.GetImageFromArray(mask_for_sitk)
            mask_image.SetSpacing(spacing_xyz)      # (X, Y, Z) spacing → SimpleITK
            mask_image.SetOrigin(origin_lps)
            mask_image.SetDirection(direction_flat)
            logger.info(
                f"Mask MONAI: shape={mask_for_sitk.shape}, "
                f"spacing={[round(s,3) for s in spacing_xyz]}, "
                f"origin={[round(o,2) for o in origin_lps]}"
            )
        except Exception as e_aff:
            logger.warning(f"Fallo modo MONAI en save_predicted_mask: {e_aff} — usando legacy.")
            mask_image = sitk.GetImageFromArray(mask_np.astype(np.uint8))
            mask_image.SetSpacing(tuple(reversed(spacing)))
    else:
        # ── Fallback legacy (Intento B / SimpleITK): tensor ya en (Z, Y, X) ──
        mask_image = sitk.GetImageFromArray(mask_np.astype(np.uint8))
        mask_image.SetSpacing(tuple(reversed(spacing)))

    if reference_nifti_path and reference_nifti_path.exists():
        try:
            ref_image = sitk.ReadImage(str(reference_nifti_path))

            if monai_affine is None:
                mask_image.SetOrigin(ref_image.GetOrigin())
                mask_image.SetDirection(ref_image.GetDirection())

            # Resamplear al grid exacto del volumen original
            resampled = sitk.Resample(
                mask_image,
                ref_image,
                sitk.Transform(),
                sitk.sitkNearestNeighbor,
                0,
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

    # Fallback: guardar sin resamplear
    mask_path = output_dir / "mask.nii.gz"
    sitk.WriteImage(mask_image, str(mask_path))
    logger.info(
        f"Máscara predicha guardada (sin referencia): {mask_path} | "
        f"shape={mask_np.shape}"
    )
    return mask_path


def save_uncertainty_map(
    prediction_probs: torch.Tensor,
    output_dir: Path,
    spacing: tuple,
    reference_nifti_path: Optional[Path] = None,
    monai_affine=None,
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
        # MONAI tensor: (X, Y, Z) → transponer a (Z, Y, X) para SimpleITK
        uncertainty_raw = prediction_probs[0, 1].cpu().numpy().astype(np.float32)

        if monai_affine is not None:
            uncertainty_np = uncertainty_raw.transpose(2, 1, 0)  # (X,Y,Z)→(Z,Y,X)
        else:
            uncertainty_np = uncertainty_raw  # legacy: ya en (Z,Y,X)

        unc_image = sitk.GetImageFromArray(uncertainty_np)

        if monai_affine is not None:
            try:
                spacing_xyz, origin_lps, direction_flat = _affine_ras_to_sitk(monai_affine)
                unc_image.SetSpacing(spacing_xyz)
                unc_image.SetOrigin(origin_lps)
                unc_image.SetDirection(direction_flat)
            except Exception as e_aff:
                logger.warning(f"Affine MONAI en uncertainty: {e_aff}")
                unc_image.SetSpacing(spacing)
        else:
            unc_image.SetSpacing(spacing)

        if reference_nifti_path and reference_nifti_path.exists():
            try:
                ref_image = sitk.ReadImage(str(reference_nifti_path))
                if monai_affine is None:
                    unc_image.SetOrigin(ref_image.GetOrigin())
                    unc_image.SetDirection(ref_image.GetDirection())
                unc_image = sitk.Resample(
                    unc_image, ref_image, sitk.Transform(),
                    sitk.sitkLinear, 0.0, sitk.sitkFloat32,
                )
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
