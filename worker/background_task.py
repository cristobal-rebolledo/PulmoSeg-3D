"""
background_task.py — Orquestador de tareas en segundo plano para PulmoSeg 3D.

Regla 1 aplicada: Sustituye Google Cloud Pub/Sub por BackgroundTasks de FastAPI.
Esta función se ejecuta en un thread pool separado (no bloquea el event loop)
cuando FastAPI la invoca mediante BackgroundTasks.add_task().

Flujo del worker:
  1. Resuelve la ruta dinámica al directorio DICOM desde el request payload.
  2. Actualiza estado a PROCESSING.
  3. Llama al pipeline MONAI con los archivos DICOM físicos.
  4. Inyecta dicom_image_ids en artifacts para el visor MPR (DicomCanvasViewer).
  5. Actualiza estado a COMPLETED con los resultados.
  6. Si falla, actualiza estado a FAILED con el mensaje de error.

Jerárquica DICOM esperada (LIDC-IDRI):
  local_storage/inputs/dicom/{patient_pseudo_id}/{study_instance_uid}/*.dcm

Nota: Los directorios temp_{job_id}/ NO se eliminan al finalizar.
  Se conservan para re-análisis clínico y visualización posterior con el visor MPR Canvas.
"""

import logging
from datetime import datetime, timezone
from pathlib import Path

from api.database import SegmentationJob, SessionLocal
from worker.mock_data import get_mock_worker_details
from worker.pipeline_monai import run_inference_pipeline

logger = logging.getLogger("pulmoseg.worker")

# Ruta base de almacenamiento local (simula buckets GCS)
LOCAL_STORAGE_BASE = Path("local_storage")


def _resolve_dicom_directory(request_data: dict) -> Path:
    """
    Resuelve la ruta al directorio DICOM a partir del payload del request.

    La jerarquía en disco sigue la convención LIDC-IDRI de 3 niveles:
      local_storage/inputs/dicom/{patient_pseudo_id}/{study_instance_uid}/{series_instance_uid}/

    Estrategia de resolución (en orden):
      1. Ruta exacta usando series_instance_uid del request (camino rápido).
      2. Búsqueda recursiva de archivos .dcm dentro del directorio del estudio
         (fallback para cualquier profundidad de anidamiento).

    Args:
        request_data: Diccionario con el payload completo del request.

    Returns:
        Path al directorio que contiene directamente los archivos .dcm.

    Raises:
        FileNotFoundError: Si no se encuentran archivos .dcm en ninguna ruta.
        ValueError: Si faltan campos requeridos en el request.
    """
    patient_id = request_data.get("patient_pseudo_id")
    study_uid = request_data.get("study_instance_uid")
    series_uid = (
        request_data.get("dicom_source", {}).get("series_instance_uid")
    )

    if not patient_id:
        raise ValueError("Campo 'patient_pseudo_id' faltante en el request")
    if not study_uid:
        raise ValueError("Campo 'study_instance_uid' faltante en el request")

    study_dir = LOCAL_STORAGE_BASE / "inputs" / "dicom" / patient_id / study_uid

    if not study_dir.exists():
        raise FileNotFoundError(
            f"Directorio del estudio no encontrado: {study_dir}\n"
            f"  patient_pseudo_id:  {patient_id}\n"
            f"  study_instance_uid: {study_uid}\n"
            f"Verifica que los DICOM estén en:\n"
            f"  local_storage/inputs/dicom/{{patient_id}}/{{study_uid}}/..."
        )

    # --- Estrategia 1: ruta exacta con series_instance_uid ---
    if series_uid:
        series_dir = study_dir / series_uid
        if series_dir.exists():
            dcm_files = list(series_dir.glob("*.dcm"))
            if dcm_files:
                logger.info(
                    f"DICOM resuelto por SeriesUID: {series_dir} "
                    f"({len(dcm_files)} archivos)"
                )
                return series_dir
            logger.warning(
                f"SeriesUID dir existe pero no tiene .dcm: {series_dir} "
                f"— intentando búsqueda recursiva"
            )
        else:
            logger.warning(
                f"SeriesUID dir no encontrado: {series_dir} "
                f"— intentando búsqueda recursiva"
            )

    # --- Estrategia 2: búsqueda recursiva dentro del directorio del estudio ---
    # Encuentra el directorio padre más profundo que contiene .dcm
    all_dcm = list(study_dir.rglob("*.dcm"))
    if not all_dcm:
        raise FileNotFoundError(
            f"No se encontraron archivos .dcm dentro de: {study_dir}\n"
            f"  series_instance_uid buscado: {series_uid or '(no especificado)'}"
        )

    # Agrupar los .dcm por su directorio padre y elegir el más poblado
    dirs_found: dict[Path, int] = {}
    for f in all_dcm:
        dirs_found[f.parent] = dirs_found.get(f.parent, 0) + 1

    dicom_dir = max(dirs_found, key=dirs_found.__getitem__)
    logger.info(
        f"DICOM resuelto por búsqueda recursiva: {dicom_dir} "
        f"({dirs_found[dicom_dir]} archivos .dcm)"
    )
    if len(dirs_found) > 1:
        logger.warning(
            f"Se encontraron .dcm en {len(dirs_found)} subdirectorios. "
            f"Usando el más poblado: {dicom_dir}. "
            f"Especifica series_instance_uid en el request para mayor precisión."
        )

    return dicom_dir


def _update_progress(
    db, job: SegmentationJob, progress: int, message: str
) -> None:
    """Helper para actualizar el progreso del Job en la DB."""
    job.progress_percentage = progress
    job.updated_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(f"[{job.job_id}] Progreso: {progress}% — {message}")

def _check_cancelled(db, job_id: str) -> None:
    """
    Consulta la DB y lanza CancelledError si el job fue marcado CANCELLED.
    Se llama en los checkpoints del pipeline para abortar rápidamente.
    """
    job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()
    if job and job.status == "CANCELLED":
        raise RuntimeError("__CANCELLED__")



def run_segmentation_job(
    job_id: str,
    request_data: dict,
    dicom_dir: str | None = None,
    nifti_path: str | None = None,
) -> None:
    """
    Ejecuta un trabajo de segmentación en segundo plano.

    Esta función es llamada por BackgroundTasks de FastAPI y se ejecuta
    en un thread separado del thread pool.

    Flujo de resolución del input:
      1. Si nifti_path se proporciona, se usa directamente (modo validación NIfTI).
      2. Si dicom_dir se proporciona (multipart upload), se usa como entrada DICOM.
      3. Si ninguno, resuelve la ruta dinámicamente desde el payload del request
         usando patient_pseudo_id + study_instance_uid.

    Args:
        job_id: Identificador único del Job creado por POST /segment.
        request_data: Diccionario con el payload completo del request original.
        dicom_dir: Ruta directa al directorio temporal con los DICOM subidos.
                   Si se proporciona, se usa en lugar de resolver desde metadatos.
        nifti_path: Ruta directa a un archivo .nii.gz de entrada.
                    Cuando se provee, se salta completamente la conversión DICOM.
                    Útil para validar con datasets como Task09_Spleen.

    Side effects:
        - Actualiza el registro SegmentationJob en SQLite con:
          - Transiciones de estado: QUEUED → PROCESSING → COMPLETED/FAILED
          - Porcentaje de progreso
          - Historial de estados
          - Detalles del worker
          - Resultados clínicos (si COMPLETED)
          - Mensaje de error (si FAILED)
        - Limpia el directorio temporal al finalizar (si se creó uno).
    """
    logger.info(f"[{job_id}] Worker iniciado — procesando Job...")

    # Abrir una sesión de DB independiente para este thread
    # (cada thread necesita su propia sesión en SQLAlchemy)
    db = SessionLocal()

    try:
        # --- 1. Obtener el Job de la DB ---
        job = db.query(SegmentationJob).filter(
            SegmentationJob.job_id == job_id
        ).first()

        if not job:
            logger.error(f"[{job_id}] Job no encontrado en la base de datos")
            return

        # --- 2. Actualizar estado a PROCESSING ---
        job.status = "PROCESSING"
        job.progress_percentage = 5
        job.add_state_entry("PROCESSING")
        job.set_worker_details(get_mock_worker_details())
        job.updated_at = datetime.now(timezone.utc)
        db.commit()

        logger.info(f"[{job_id}] Estado actualizado: PROCESSING (5%)")

        # --- 3. Resolver ruta DICOM o NIfTI de entrada ---
        _check_cancelled(db, job_id)  # Checkpoint 1: antes de resolver input
        _update_progress(db, job, 10, "Resolviendo fuente de entrada...")

        resolved_dicom_dir = None
        resolved_nifti_path = None

        if nifti_path:
            # Modo NIfTI directo (validación): la ruta viene directa del endpoint
            resolved_nifti_path = Path(nifti_path)
            logger.info(
                f"[{job_id}] NIfTI directo recibido: {resolved_nifti_path} "
                f"({resolved_nifti_path.stat().st_size / (1024*1024):.1f} MB)"
            )
        elif dicom_dir:
            # Multipart upload: la ruta viene directa del endpoint
            resolved_dicom_dir = Path(dicom_dir)
            logger.info(
                f"[{job_id}] DICOM dir recibido vía upload: {resolved_dicom_dir} "
                f"({len(list(resolved_dicom_dir.glob('*.dcm')))} archivos .dcm)"
            )
        else:
            # Fallback: resolver desde metadatos del request (compatibilidad)
            resolved_dicom_dir = _resolve_dicom_directory(request_data)

        # --- 4. Ejecutar pipeline MONAI ---
        _check_cancelled(db, job_id)  # Checkpoint 2: antes de iniciar inferencia
        _update_progress(db, job, 15, "Iniciando pipeline MONAI...")

        result = run_inference_pipeline(
            job_id=job_id,
            request_data=request_data,
            dicom_dir=resolved_dicom_dir,
            nifti_path=resolved_nifti_path,
            progress_callback=lambda pct, msg: _update_progress(db, job, pct, msg),
        )

        # --- 5. Actualizar estado a COMPLETED ---
        # Inyectar dicom_image_ids en artifacts para que DicomCanvasViewer
        # (visor MPR en HTML Canvas) pueda cargar los slices DICOM directamente
        # desde el backend sin re-subir los archivos.
        if isinstance(result, dict) and dicom_dir:
            dicom_path = Path(dicom_dir)
            dcm_files = sorted(dicom_path.glob("*.dcm"))
            if dcm_files:
                dicom_image_ids = [
                    f"/dicom/{job_id}/{f.name}" for f in dcm_files
                ]
                result.setdefault("artifacts", {})
                result["artifacts"]["dicom_image_ids"] = dicom_image_ids
                logger.info(
                    f"[{job_id}] {len(dicom_image_ids)} dicom_image_ids "
                    f"registrados en artifacts"
                )

        job.status = "COMPLETED"
        job.progress_percentage = 100
        job.add_state_entry("COMPLETED")
        job.set_result_data(result)
        job.updated_at = datetime.now(timezone.utc)
        db.commit()

        logger.info(f"[{job_id}] ✅ Job completado exitosamente (100%)")

    except RuntimeError as e:
        if str(e) == "__CANCELLED__":
            # El usuario canceló el job — ya está marcado CANCELLED en la DB
            logger.info(f"[{job_id}] ⏹️ Job cancelado por el usuario. Pipeline abortado.")
        else:
            # RuntimeError genérico del pipeline → FAILED
            logger.error(f"[{job_id}] ❌ Error en el pipeline: {e}", exc_info=True)
            try:
                job = db.query(SegmentationJob).filter(
                    SegmentationJob.job_id == job_id
                ).first()
                if job:
                    job.status = "FAILED"
                    job.add_state_entry("FAILED")
                    job.error_message = str(e)
                    job.updated_at = datetime.now(timezone.utc)
                    db.commit()
            except Exception as db_error:
                logger.error(
                    f"[{job_id}] Error crítico al actualizar DB tras fallo: {db_error}",
                    exc_info=True,
                )

    except Exception as e:
        # Cualquier otro error inesperado → FAILED
        logger.error(f"[{job_id}] ❌ Error inesperado en el pipeline: {e}", exc_info=True)
        try:
            job = db.query(SegmentationJob).filter(
                SegmentationJob.job_id == job_id
            ).first()
            if job:
                job.status = "FAILED"
                job.add_state_entry("FAILED")
                job.error_message = str(e)
                job.updated_at = datetime.now(timezone.utc)
                db.commit()
                logger.info(f"[{job_id}] Estado actualizado: FAILED")
        except Exception as db_error:
            logger.error(
                f"[{job_id}] Error crítico al actualizar DB tras fallo: {db_error}",
                exc_info=True,
            )


    finally:
        # Siempre cerrar la sesión de DB
        db.close()
        logger.info(f"[{job_id}] Worker finalizado — sesión de DB cerrada")
        # NOTA: Los archivos DICOM en temp_{job_id}/ se conservan intencionalmente.
        # Permiten re-análisis clínico y visualización posterior con DicomCanvasViewer (MPR Canvas).
