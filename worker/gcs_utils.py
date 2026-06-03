"""
worker/gcs_utils.py — Utilidades para Google Cloud Storage.

Centraliza todas las operaciones de lectura y escritura de archivos contra GCS,
sirviendo como capa de abstracción entre el pipeline de inferencia y el storage.

Operaciones cubiertas:
  - download_blob: Descarga un objeto GCS a un Path local.
  - upload_blob:   Sube un archivo local a un objeto GCS.
  - blob_exists:   Verifica si un objeto existe en GCS.

Configuración:
  Los nombres de los buckets se leen desde variables de entorno:
    GCS_BUCKET_INPUTS   → inputs DICOM (default: pulmoseg-inputs)
    GCS_BUCKET_OUTPUTS  → outputs NIfTI (default: pulmoseg-outputs)
    GCS_BUCKET_MODELS   → pesos del modelo (default: pulmoseg-models)

Autenticación:
  En Cloud Run, se usa la Service Account asignada al servicio (ADC).
  En desarrollo local, se puede usar GOOGLE_APPLICATION_CREDENTIALS
  apuntando a un Service Account JSON.
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger("pulmoseg.gcs_utils")

# ---------------------------------------------------------------------------
# Nombres de buckets desde variables de entorno
# ---------------------------------------------------------------------------
GCS_BUCKET_INPUTS  = os.environ.get("GCS_BUCKET_INPUTS",  "pulmoseg-inputs")
GCS_BUCKET_OUTPUTS = os.environ.get("GCS_BUCKET_OUTPUTS", "pulmoseg-outputs")
GCS_BUCKET_MODELS  = os.environ.get("GCS_BUCKET_MODELS",  "pulmoseg-models")

# ---------------------------------------------------------------------------
# Cliente GCS (lazy initialization para evitar errores en dev local sin SDK)
# ---------------------------------------------------------------------------
_gcs_client = None


def _get_client():
    """Retorna el cliente GCS, inicializándolo en el primer uso."""
    global _gcs_client
    if _gcs_client is None:
        from google.cloud import storage
        _gcs_client = storage.Client()
    return _gcs_client


# ---------------------------------------------------------------------------
# Operaciones principales
# ---------------------------------------------------------------------------

def download_blob(bucket_name: str, blob_name: str, dest_path: Path) -> Path:
    """
    Descarga un objeto de GCS a un archivo local.

    Args:
        bucket_name: Nombre del bucket GCS (sin gs://).
        blob_name:   Ruta del objeto dentro del bucket (ej: "spleen/model.pt").
        dest_path:   Ruta local de destino donde guardar el archivo.

    Returns:
        Path al archivo descargado.

    Raises:
        google.cloud.exceptions.NotFound: Si el blob no existe en GCS.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.download_to_filename(str(dest_path))
    logger.info(
        f"GCS ↓ gs://{bucket_name}/{blob_name} → {dest_path} "
        f"({dest_path.stat().st_size / (1024*1024):.1f} MB)"
    )
    return dest_path


def upload_blob(bucket_name: str, blob_name: str, src_path: Path) -> str:
    """
    Sube un archivo local a GCS.

    Args:
        bucket_name: Nombre del bucket GCS (sin gs://).
        blob_name:   Ruta de destino dentro del bucket.
        src_path:    Ruta local del archivo a subir.

    Returns:
        URI completa del objeto en GCS: "gs://{bucket_name}/{blob_name}".

    Raises:
        FileNotFoundError: Si src_path no existe.
    """
    if not src_path.exists():
        raise FileNotFoundError(f"Archivo local no encontrado para subir: {src_path}")

    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.upload_from_filename(str(src_path))
    uri = f"gs://{bucket_name}/{blob_name}"
    logger.info(
        f"GCS ↑ {src_path} → {uri} "
        f"({src_path.stat().st_size / (1024*1024):.1f} MB)"
    )
    return uri


def blob_exists(bucket_name: str, blob_name: str) -> bool:
    """
    Verifica si un objeto existe en GCS.

    Args:
        bucket_name: Nombre del bucket GCS.
        blob_name:   Ruta del objeto dentro del bucket.

    Returns:
        True si el objeto existe, False en caso contrario.
    """
    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    return blob.exists()


def upload_dicom_dir(job_id: str, local_dir: Path) -> list[str]:
    """
    Sube todos los archivos de un directorio DICOM local a GCS.

    Los archivos se suben bajo el prefijo: inputs/{job_id}/

    Args:
        job_id:    Identificador único del job (UUID v4).
        local_dir: Directorio local con los archivos DICOM.

    Returns:
        Lista de URIs GCS de los archivos subidos.
    """
    uris = []
    files = [f for f in local_dir.rglob("*") if f.is_file()]
    logger.info(f"[{job_id}] Subiendo {len(files)} archivos DICOM a GCS...")
    for f in files:
        relative = f.relative_to(local_dir)
        blob_name = f"inputs/{job_id}/{relative.as_posix()}"
        uri = upload_blob(GCS_BUCKET_INPUTS, blob_name, f)
        uris.append(uri)
    logger.info(f"[{job_id}] {len(uris)} archivos DICOM subidos a GCS.")
    return uris


def download_dicom_dir(job_id: str, dest_dir: Path) -> Path:
    """
    Descarga todos los archivos DICOM de un job desde GCS a un directorio local.

    Los archivos se buscan bajo el prefijo: inputs/{job_id}/

    Args:
        job_id:   Identificador único del job.
        dest_dir: Directorio local de destino.

    Returns:
        Path al directorio local con los DICOM descargados.
    """
    client = _get_client()
    bucket = client.bucket(GCS_BUCKET_INPUTS)
    prefix = f"inputs/{job_id}/"
    blobs = list(client.list_blobs(GCS_BUCKET_INPUTS, prefix=prefix))
    logger.info(f"[{job_id}] Descargando {len(blobs)} archivos DICOM desde GCS...")
    for blob in blobs:
        relative = blob.name[len(prefix):]
        dest_path = dest_dir / relative
        download_blob(GCS_BUCKET_INPUTS, blob.name, dest_path)
    logger.info(f"[{job_id}] DICOM descargados en: {dest_dir}")
    return dest_dir


def upload_outputs(job_id: str, output_dir: Path) -> dict[str, str]:
    """
    Sube los archivos de salida del pipeline (mask.nii.gz, uncertainty.nii.gz)
    al bucket de outputs de GCS.

    Args:
        job_id:     Identificador único del job.
        output_dir: Directorio local con los archivos de salida del pipeline.

    Returns:
        Diccionario {nombre_archivo: uri_gcs} con las rutas publicadas.
    """
    uris = {}
    for f in output_dir.glob("*.nii.gz"):
        blob_name = f"outputs/{job_id}/{f.name}"
        uri = upload_blob(GCS_BUCKET_OUTPUTS, blob_name, f)
        uris[f.name] = uri
        logger.info(f"[{job_id}] Output subido: {f.name} → {uri}")
    return uris


def ensure_model_local(model_blob_name: str, local_path: Path) -> Path:
    """
    Garantiza que el archivo de pesos del modelo exista localmente.

    Si ya existe localmente (caché), lo reutiliza.
    Si no existe, lo descarga desde GCS bucket de modelos.

    Args:
        model_blob_name: Ruta del modelo en el bucket de modelos
                         (ej: "spleen_ct_segmentation/model.pt").
        local_path:      Ruta local donde cachear el modelo.

    Returns:
        Path al archivo de pesos local.
    """
    if local_path.exists() and local_path.stat().st_size > 0:
        logger.info(f"Modelo en caché local: {local_path} — omitiendo descarga.")
        return local_path

    logger.info(
        f"Modelo no encontrado localmente. "
        f"Descargando desde gs://{GCS_BUCKET_MODELS}/{model_blob_name}..."
    )
    return download_blob(GCS_BUCKET_MODELS, model_blob_name, local_path)
