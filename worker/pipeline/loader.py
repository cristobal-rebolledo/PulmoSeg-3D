"""
worker/pipeline/loader.py — Conversión DICOM → NIfTI.

Responsabilidades:
  - Leer series DICOM con estrategia dual (GDCM + fallback slice-by-slice).
  - Generar un volumen NIfTI (.nii.gz) unificado desde los slices DICOM.

Dependencias externas:
  - SimpleITK: lectura DICOM y operaciones de imagen 3D.
"""

import hashlib
import logging
from pathlib import Path

import numpy as np
import SimpleITK as sitk

logger = logging.getLogger("pulmoseg.pipeline.loader")


def convert_dicom_to_nifti(
    dicom_dir: Path,
    output_path: Path,
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
        h = hashlib.md5()
        for rf in raw_files[:10]:
            try:
                h.update(rf.name.encode())
                h.update(rf.stat().st_size.to_bytes(8, "little"))
                with open(rf, "rb") as fh:
                    h.update(fh.read(512))
            except Exception:
                pass
        logger.info(
            f"Fingerprint MD5 del directorio (nombre+tamaño+header): {h.hexdigest()} "
            f"← DEBE ser DIFERENTE para cada estudio distinto"
        )

    logger.info(f"Leyendo serie DICOM desde: {dicom_dir}")

    # ── Estrategia 1: GDCM ImageSeriesReader ─────────────────────────────────
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

    # ── Estrategia 2: Lectura directa por nombre ──────────────────────────────
    candidate_exts = {".dcm", ".dicom", ""}
    candidate_files = sorted(
        f for f in raw_files
        if f.suffix.lower() in candidate_exts
    )
    if not candidate_files:
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
            arrays = [sitk.GetArrayFromImage(s) for s in slices]
            stacked = np.stack(arrays, axis=0)
            image = sitk.GetImageFromArray(stacked)
            sp = list(slices[0].GetSpacing())
            if len(sp) == 2:
                sp.append(1.0)
            image.SetSpacing(sp[:3])

    sitk.WriteImage(image, str(output_path))
    logger.info(
        f"Volumen NIfTI generado (estrategia 2): {output_path} | "
        f"Dimensiones: {image.GetSize()} | Spacing: {image.GetSpacing()}"
    )
    return output_path
