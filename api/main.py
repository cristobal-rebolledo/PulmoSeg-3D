"""
main.py — Entrypoint FastAPI para PulmoSeg 3D (Entorno de Desarrollo Local).

Endpoints implementados:
  POST /segment              → Crea un Job de segmentación (HTTP 202 Accepted)
  GET  /status/{id}          → Consulta el estado actual de un Job
  POST /cancel/{id}          → Cancela un Job en QUEUED o PROCESSING
  GET  /dicom/{job_id}/{fn}  → Sirve un slice DICOM (protegido por API Key)
  GET  /nifti/{job_id}       → Sirve la máscara NIfTI de segmentación (protegido por API Key)
  GET  /volume/{job_id}      → Sirve el volumen CT isotrópico 1×1×1 mm (protegido por API Key)
  GET  /health               → Healthcheck básico

Seguridad:
  - job_id usa UUID v4 puro para URLs imposibles de adivinar por fuerza bruta.
  - Los endpoints de archivos médicos (DICOM, NIfTI) validan el header
    X-API-Key contra la variable de entorno PULMOSEG_API_KEY.
  - Los archivos DICOM se conservan en temp_{job_id}/ para re-análisis clínico.
"""

import asyncio
import logging
import os
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Header,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.database import SegmentationJob, create_tables, get_db
from api.schemas import (
    Artifacts,
    ClinicalResults,
    JobInfo,
    JobListEntry,
    JobListResponse,
    JobTimestamps,
    RecistMetrics,
    SegmentationJobResponse,
    SegmentationResultResponse,
    StateHistoryEntry,
    VolumetricData,
)
from worker.background_task import run_segmentation_job

# ---------------------------------------------------------------------------
# Cargar variables de entorno desde .env
# ---------------------------------------------------------------------------
load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("pulmoseg.api")

# ---------------------------------------------------------------------------
# Configuración de seguridad — API Key estática desde .env
# ---------------------------------------------------------------------------
API_KEY = os.environ.get("PULMOSEG_API_KEY", "")
if not API_KEY:
    logger.warning(
        "⚠️  PULMOSEG_API_KEY no está configurada. "
        "Los endpoints de archivos médicos estarán desprotegidos."
    )

# ---------------------------------------------------------------------------
# Directorios de almacenamiento local (simulan buckets de GCS)
# ---------------------------------------------------------------------------
LOCAL_STORAGE_BASE = Path("local_storage")
LOCAL_STORAGE_DIRS = [
    LOCAL_STORAGE_BASE / "inputs",   # Simula GCS bucket de entrada (DICOM)
    LOCAL_STORAGE_BASE / "outputs",  # Simula GCS bucket de salida (NIfTI)
    LOCAL_STORAGE_BASE / "models",   # Simula GCS bucket de pesos del modelo
]

# ---------------------------------------------------------------------------
# Cola FIFO de trabajos de segmentación
#
# Cada elemento es un dict con los argumentos necesarios para run_segmentation_job.
# El worker coroutine (queue_worker) procesa los jobs de uno en uno, garantizando
# que la GPU/CPU no sea compartida entre inferencias concurrentes.
# ---------------------------------------------------------------------------
job_queue: asyncio.Queue = asyncio.Queue()


async def queue_worker() -> None:
    """
    Worker coroutine que consume la job_queue de forma secuencial (FIFO).

    Se ejecuta indefinidamente en el event loop del servidor FastAPI.
    Para cada job dequeued:
      1. Lanza run_segmentation_job en el thread pool (loop.run_in_executor)
         para no bloquear el event loop mientras la inferencia MONAI se ejecuta.
      2. Espera a que el job actual termine ANTES de procesar el siguiente.
      3. Marca la tarea como completada con job_queue.task_done().

    Al recibir CancelledError (shutdown del servidor), termina limpiamente.
    """
    logger.info("🚀 Queue worker iniciado — procesando jobs en serie (FIFO).")
    loop = asyncio.get_event_loop()

    while True:
        try:
            job_payload = await job_queue.get()
        except asyncio.CancelledError:
            logger.info("⏹️  Queue worker detenido.")
            break

        job_id = job_payload.get("job_id", "unknown")
        logger.info(
            f"[{job_id}] Dequeued — "
            f"posición en cola restante: {job_queue.qsize()}"
        )

        try:
            # run_in_executor permite que run_segmentation_job (función síncrona
            # y bloqueante) corra en el thread pool sin bloquear el event loop.
            # El await asegura que el siguiente job NO empiece hasta que este termine.
            await loop.run_in_executor(
                None,
                lambda p=job_payload: run_segmentation_job(**p),
            )
        except Exception as exc:
            logger.error(
                f"[{job_id}] ❌ Error no capturado en queue_worker: {exc}",
                exc_info=True,
            )
        finally:
            job_queue.task_done()
            logger.info(f"[{job_id}] ✅ Task done — cola restante: {job_queue.qsize()}")


# ---------------------------------------------------------------------------
# Dependencia de seguridad — Verificación de API Key
# ---------------------------------------------------------------------------
def verify_api_key(x_api_key: str = Header(..., alias="X-API-Key")) -> None:
    """
    Dependencia FastAPI que verifica el header X-API-Key.

    Lanza HTTP 403 si la clave no coincide con PULMOSEG_API_KEY.
    Se aplica únicamente a los endpoints de servicio de archivos médicos
    (DICOM y NIfTI), que no deben ser públicamente accesibles.

    Uso:
        @app.get("/dicom/{job_id}/{filename}")
        async def serve_dicom(..., _=Depends(verify_api_key)):
            ...
    """
    if not API_KEY:
        # Si la clave no está configurada en .env, bloquear siempre
        raise HTTPException(
            status_code=403,
            detail="API Key no configurada en el servidor. "
                   "Agrega PULMOSEG_API_KEY al archivo .env.",
        )
    if x_api_key != API_KEY:
        raise HTTPException(
            status_code=403,
            detail="API Key inválida.",
        )


# ---------------------------------------------------------------------------
# Lifespan: inicialización al arrancar el servidor
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan de FastAPI.

    Startup:
      1. Crea las tablas SQLite si no existen.
      2. Crea los directorios de local_storage si no existen.
      3. Lanza el queue_worker como tarea asyncio para procesamiento serial de jobs.

    Shutdown:
      4. Cancela el queue_worker limpiamente.
    """
    # 1. Crear tablas SQLite
    logger.info("Inicializando base de datos SQLite...")
    create_tables()
    logger.info("Base de datos lista: local_jobs.db")

    # 2. Crear directorios de almacenamiento local
    for dir_path in LOCAL_STORAGE_DIRS:
        dir_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Directorio de almacenamiento verificado: {dir_path}")

    # 3. Iniciar el worker de cola — procesa jobs en serie (FIFO)
    worker_task = asyncio.create_task(queue_worker())
    logger.info("PulmoSeg 3D API lista — queue worker activo.")

    yield

    # 4. Shutdown: cancelar el worker y esperar a que termine
    logger.info("Apagando PulmoSeg 3D API — cancelando queue worker...")
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    logger.info("Queue worker detenido. API apagada.")


# ---------------------------------------------------------------------------
# Instancia de la aplicación FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(
    title="PulmoSeg 3D — API de Segmentación Pulmonar",
    description=(
        "API Gateway para el sistema de segmentación 3D de lesiones pulmonares. "
        "Fase 1: Entorno de Desarrollo Local. "
        "Sustituye GCP (Firestore, GCS, Pub/Sub) por SQLite, filesystem y BackgroundTasks."
    ),
    version="1.1.0-local",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS Middleware — Permite al frontend React (Vite/Nginx) comunicarse con la API
#
# CORS_ORIGINS: lista de orígenes permitidos separados por coma.
# Ejemplos:
#   Desarrollo local:  CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
#   Docker (Nginx):    CORS_ORIGINS=http://localhost,http://localhost:80
#   Producción (GCP):  CORS_ORIGINS=https://pulmoseg.example.com
# ---------------------------------------------------------------------------
_raw_cors_origins = os.environ.get(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)
CORS_ORIGINS: list[str] = [
    origin.strip() for origin in _raw_cors_origins.split(",") if origin.strip()
]
logger.info(f"CORS orígenes permitidos: {CORS_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===========================================================================
# Endpoint: POST /segment
# ===========================================================================
@app.post(
    "/segment",
    response_model=SegmentationJobResponse,
    status_code=202,
    summary="Crear un Job de Segmentación (Multipart Upload)",
    description=(
        "Recibe los archivos DICOM reales via multipart/form-data, "
        "los guarda en un directorio permanente temp_{job_id}/, crea el registro "
        "en SQLite con estado QUEUED, lanza la tarea en segundo plano y retorna "
        "HTTP 202 Accepted con el job_id (UUID v4)."
    ),
)
async def create_segmentation_job(
    files: List[UploadFile] = File(
        ..., description="Archivos DICOM (.dcm) del estudio a segmentar"
    ),
    patient_pseudo_id: str = Form(
        "unknown", description="ID pseudoanonimizado del paciente"
    ),
    study_instance_uid: str = Form(
        "unknown", description="UID del estudio DICOM"
    ),
    db: Session = Depends(get_db),
):
    """
    Flujo Multipart Upload:
    1. Genera un job_id UUID v4 puro (ej: "f47ac10b-58cc-4372-a567-0e02b2c3d479").
    2. Crea directorio permanente local_storage/inputs/temp_{job_id}/.
    3. Guarda allí todos los archivos binarios recibidos.
    4. Crea registro en SQLite con estado QUEUED.
    5. Lanza BackgroundTask con la ruta al directorio.
    6. Retorna 202 Accepted inmediatamente.

    Los archivos DICOM se conservan en disco para permitir re-análisis clínico
    y visualización posterior con Cornerstone3D sin re-ejecutar el modelo.
    """
    # --- 1. Generar job_id UUID v4 puro ---
    # UUID v4 completo: 2^122 posibilidades, imposible de adivinar por fuerza bruta.
    # Sin prefijos secuenciales (ej: req_1, req_2) que faciliten la enumeración.
    job_id = str(uuid.uuid4())

    # --- 2. Crear directorio para los DICOM subidos ---
    # Se mantiene permanentemente para re-análisis y visualización con Cornerstone3D
    temp_dicom_dir = LOCAL_STORAGE_BASE / "inputs" / f"temp_{job_id}"
    temp_dicom_dir.mkdir(parents=True, exist_ok=True)

    # --- 3. Guardar archivos binarios ---
    saved_count = 0
    total_bytes = 0

    try:
        for upload_file in files:
            # Usar solo el nombre del archivo (sin ruta relativa del directorio)
            filename = Path(upload_file.filename).name if upload_file.filename else f"file_{saved_count}.dcm"
            file_path = temp_dicom_dir / filename

            content = await upload_file.read()
            with open(file_path, "wb") as out_file:
                out_file.write(content)
            total_bytes += len(content)
            saved_count += 1

        logger.info(
            f"[{job_id}] {saved_count} archivos DICOM guardados en {temp_dicom_dir} "
            f"({total_bytes / (1024 * 1024):.1f} MB total)"
        )

    except Exception as e:
        shutil.rmtree(temp_dicom_dir, ignore_errors=True)
        logger.error(f"[{job_id}] Error guardando archivos: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error guardando archivos DICOM: {e}",
        )

    if saved_count == 0:
        shutil.rmtree(temp_dicom_dir, ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail="No se recibieron archivos DICOM válidos.",
        )

    # --- 4. Construir request_data para registro en DB ---
    request_data = {
        "patient_pseudo_id": patient_pseudo_id,
        "study_instance_uid": study_instance_uid,
        "dicom_source": {
            "gcs_bucket": "local-upload",
            "gcs_prefix": str(temp_dicom_dir),
            "series_instance_uid": study_instance_uid,
            "expected_file_count": saved_count,
        },
        "dicom_temp_dir": str(temp_dicom_dir),
    }

    # --- 5. Crear registro en SQLite ---
    new_job = SegmentationJob(
        job_id=job_id,
        status="QUEUED",
        progress_percentage=0,
    )
    new_job.set_request_data(request_data)
    new_job.add_state_entry("QUEUED")

    db.add(new_job)
    db.commit()
    db.refresh(new_job)

    logger.info(f"Job creado: {job_id} | Status: QUEUED | Files: {saved_count}")

    # --- 6. Encolar job para procesamiento serial ---
    await job_queue.put({
        "job_id": job_id,
        "request_data": request_data,
        "dicom_dir": str(temp_dicom_dir),
    })

    logger.info(
        f"Job encolado: {job_id} | Posición en cola: {job_queue.qsize()}"
    )

    # --- 7. Retornar 202 Accepted ---
    return SegmentationJobResponse(
        job_id=job_id,
        status="QUEUED",
        message=f"Segmentation job queued: {saved_count} DICOM files received",
    )

# ===========================================================================
# Endpoint: POST /cancel/{job_id}
# ===========================================================================
@app.post(
    "/cancel/{job_id}",
    summary="Cancelar un Job de Segmentación",
    description=(
        "Marca el Job como CANCELLED en la base de datos si se encuentra "
        "en estado QUEUED o PROCESSING. El worker detectará el cambio en su "
        "próximo checkpoint y abortará la ejecución."
    ),
)
def cancel_job(
    job_id: str,
    db: Session = Depends(get_db),
):
    """
    Cancela un Job activo (QUEUED o PROCESSING).

    - Si el Job está QUEUED, se cancela inmediatamente antes de iniciar.
    - Si el Job está PROCESSING, se marca CANCELLED; el worker lo detecta
      en el próximo checkpoint del pipeline y lanza CancelledError.
    - Si el Job ya está COMPLETED, FAILED o CANCELLED, retorna HTTP 409.
    """
    job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()

    if not job:
        raise HTTPException(
            status_code=404,
            detail=f"Job no encontrado: {job_id}",
        )

    if job.status not in ("QUEUED", "PROCESSING"):
        raise HTTPException(
            status_code=409,
            detail=(
                f"No se puede cancelar el Job '{job_id}': "
                f"estado actual es '{job.status}' (solo se pueden cancelar "
                "jobs en QUEUED o PROCESSING)."
            ),
        )

    job.status = "CANCELLED"
    job.add_state_entry("CANCELLED")
    job.error_message = "Cancelado por el usuario."
    job.updated_at = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    )
    db.commit()

    logger.info(f"[{job_id}] Job cancelado por el usuario.")

    return {
        "job_id": job_id,
        "status": "CANCELLED",
        "message": "Job cancelado exitosamente.",
    }


# ===========================================================================
# Endpoint: POST /segment-nifti
# Recibe un archivo .nii/.nii.gz directamente (sin conversión DICOM).
# Pensado para validación del pipeline con datasets como Task09_Spleen.
# ===========================================================================
@app.post(
    "/segment-nifti",
    response_model=SegmentationJobResponse,
    status_code=202,
    summary="Crear Job de Segmentación desde NIfTI (Validación)",
    description=(
        "Recibe un archivo NIfTI (.nii o .nii.gz) directamente via multipart/form-data. "
        "Salta el paso de conversión DICOM→NIfTI y alimenta el volumen directamente "
        "al pipeline MONAI. Diseñado para validar el pipeline con datasets como "
        "Task09_Spleen (Medical Segmentation Decathlon)."
    ),
)
async def create_segmentation_job_from_nifti(
    file: UploadFile = File(
        ..., description="Archivo NIfTI (.nii o .nii.gz) del volumen CT a segmentar"
    ),
    patient_pseudo_id: str = Form(
        "validation-patient", description="ID pseudoanonimizado del paciente"
    ),
    study_instance_uid: str = Form(
        "validation-study", description="UID del estudio (puede ser libre en validación)"
    ),
    db: Session = Depends(get_db),
):
    """
    Flujo NIfTI directo (validación):
    1. Genera un job_id UUID v4.
    2. Guarda el .nii.gz en local_storage/inputs/temp_{job_id}/volume.nii.gz.
    3. Crea registro en SQLite con estado QUEUED.
    4. Lanza BackgroundTask pasando nifti_path en lugar de dicom_dir.
    5. Retorna 202 Accepted inmediatamente.
    """
    job_id = str(uuid.uuid4())

    # Crear directorio permanente para este job
    temp_nifti_dir = LOCAL_STORAGE_BASE / "inputs" / f"temp_{job_id}"
    temp_nifti_dir.mkdir(parents=True, exist_ok=True)

    # Determinar nombre del archivo de destino
    original_name = file.filename or "volume.nii.gz"
    if not (original_name.endswith(".nii.gz") or original_name.endswith(".nii")):
        original_name = "volume.nii.gz"

    nifti_dest_path = temp_nifti_dir / original_name

    try:
        content = await file.read()
        with open(nifti_dest_path, "wb") as out_f:
            out_f.write(content)

        size_mb = len(content) / (1024 * 1024)
        logger.info(
            f"[{job_id}] NIfTI recibido: {original_name} "
            f"({size_mb:.1f} MB) → {nifti_dest_path}"
        )

    except Exception as e:
        import shutil
        shutil.rmtree(temp_nifti_dir, ignore_errors=True)
        logger.error(f"[{job_id}] Error guardando NIfTI: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error guardando archivo NIfTI: {e}",
        )

    # Construir request_data
    request_data = {
        "patient_pseudo_id": patient_pseudo_id,
        "study_instance_uid": study_instance_uid,
        "dicom_source": {
            "gcs_bucket": "local-nifti-validation",
            "gcs_prefix": str(temp_nifti_dir),
            "series_instance_uid": study_instance_uid,
            "expected_file_count": 1,
        },
        "nifti_source": str(nifti_dest_path),
        "validation_mode": True,
    }

    # Crear registro en SQLite
    new_job = SegmentationJob(
        job_id=job_id,
        status="QUEUED",
        progress_percentage=0,
    )
    new_job.set_request_data(request_data)
    new_job.add_state_entry("QUEUED")
    db.add(new_job)
    db.commit()
    db.refresh(new_job)

    logger.info(f"Job NIfTI creado: {job_id} | Status: QUEUED | NIfTI: {original_name}")

    # Encolar job NIfTI para procesamiento serial
    await job_queue.put({
        "job_id": job_id,
        "request_data": request_data,
        "dicom_dir": None,
        "nifti_path": str(nifti_dest_path),
    })

    logger.info(
        f"Job NIfTI encolado: {job_id} | Posición en cola: {job_queue.qsize()}"
    )

    return SegmentationJobResponse(
        job_id=job_id,
        status="QUEUED",
        message=f"NIfTI validation job queued: {original_name} ({size_mb:.1f} MB)",
    )


# ===========================================================================
@app.get(
    "/status/{job_id}",
    response_model=SegmentationResultResponse,
    summary="Consultar estado de un Job",
    description=(
        "Consulta la base de datos SQLite y retorna el estado actual "
        "del Job. Si está COMPLETED, incluye clinical_results y artifacts "
        "(con dicom_image_ids para Cornerstone3D)."
    ),
)
def get_job_status(
    job_id: str,
    db: Session = Depends(get_db),
):
    """
    Retorna el estado actual del Job, incluyendo:
    - job_info: ID, status, timestamps, progreso
    - clinical_results: Solo si COMPLETED (volúmenes, métricas RECIST)
    - artifacts: Solo si COMPLETED (rutas a archivos + dicom_image_ids)
    - state_history: Historial completo de transiciones de estado
    - error_message: Solo si FAILED
    """
    # Buscar el Job en la base de datos
    job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()

    if not job:
        raise HTTPException(
            status_code=404,
            detail=f"Job not found: {job_id}",
        )

    # --- Construir job_info ---
    job_info = JobInfo(
        job_id=job.job_id,
        status=job.status,
        progress_percentage=job.progress_percentage,
        timestamps=JobTimestamps(
            received_at=job.created_at.isoformat() if job.created_at else "",
            completed_at=job.updated_at.isoformat()
            if job.status == "COMPLETED" and job.updated_at
            else None,
        ),
    )

    # --- Construir state_history ---
    state_history = [
        StateHistoryEntry(state=entry["state"], time=entry["time"])
        for entry in job.get_state_history()
    ]

    # --- Construir clinical_results y artifacts (solo si COMPLETED) ---
    clinical_results = None
    artifacts = None

    if job.status == "COMPLETED":
        result = job.get_result_data()
        if result:
            # Extraer clinical_results del resultado almacenado
            cr = result.get("clinical_results")
            if cr:
                clinical_results = ClinicalResults(
                    lesion_id=cr["lesion_id"],
                    volumetric_data=VolumetricData(**cr["volumetric_data"]),
                    recist_metrics=RecistMetrics(**cr["recist_metrics"]),
                )

            # Extraer artifacts del resultado almacenado
            art = result.get("artifacts")
            if art:
                artifacts = Artifacts(
                    segmentation_mask_nifti_url=art["segmentation_mask_nifti_url"],
                    uncertainty_map_url=art.get("uncertainty_map_url"),
                    dicom_image_ids=art.get("dicom_image_ids"),
                )

    # --- Extraer patient_pseudo_id desde request_data (campo JSON) ---
    patient_pseudo_id = None
    try:
        rd = job.get_request_data() if hasattr(job, "get_request_data") else {}
        if not rd:
            import json as _json
            rd = _json.loads(job.request_data) if job.request_data else {}
        patient_pseudo_id = rd.get("patient_pseudo_id")
    except Exception:
        pass

    return SegmentationResultResponse(
        job_info=job_info,
        patient_pseudo_id=patient_pseudo_id,
        clinical_results=clinical_results,
        artifacts=artifacts,
        state_history=state_history,
        error_message=job.error_message,
    )


# ===========================================================================
# Endpoint: GET /dicom/{job_id}/{filename}
# Protegido por API Key — sirve slices DICOM para Cornerstone3D
# ===========================================================================
@app.get(
    "/dicom/{job_id}/{filename}",
    summary="Servir slice DICOM",
    description=(
        "Sirve un archivo DICOM individual del directorio del job. "
        "Requiere el header X-API-Key para acceso. "
        "Cornerstone3D lo consume vía wado: URI scheme."
    ),
)
async def serve_dicom_file(
    job_id: str,
    filename: str,
    _: None = Depends(verify_api_key),
):
    """
    Sirve un archivo .dcm del directorio local_storage/inputs/temp_{job_id}/.

    Seguridad:
    - job_id es un UUID v4 opaco: imposible de enumerar por fuerza bruta.
    - Requiere X-API-Key válida en el header.
    - Valida que el filename no contenga path traversal (../).
    """
    # Prevenir path traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido.")

    dicom_path = LOCAL_STORAGE_BASE / "inputs" / f"temp_{job_id}" / filename

    if not dicom_path.exists() or not dicom_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Archivo DICOM no encontrado: {filename}",
        )

    return FileResponse(
        path=str(dicom_path),
        media_type="application/dicom",
        filename=filename,
    )


# ===========================================================================
# Endpoint: GET /nifti/{job_id}
# Protegido por API Key — sirve máscara de segmentación NIfTI
# ===========================================================================
@app.get(
    "/nifti/{job_id}",
    summary="Servir máscara de segmentación NIfTI",
    description=(
        "Sirve el archivo .nii.gz de segmentación generado para el job. "
        "Requiere el header X-API-Key para acceso. "
        "Cornerstone3D lo consume vía el nifti-volume-loader."
    ),
)
async def serve_nifti_file(
    job_id: str,
    _: None = Depends(verify_api_key),
    db: Session = Depends(get_db),
):
    """
    Sirve el archivo NIfTI de segmentación desde local_storage/outputs/{job_id}/.

    Seguridad:
    - job_id es un UUID v4 opaco.
    - Requiere X-API-Key válida en el header.
    - Verifica que el job exista en la DB antes de servir el archivo.
    """
    # Verificar que el job existe
    job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()

    if not job:
        raise HTTPException(status_code=404, detail=f"Job no encontrado: {job_id}")

    if job.status != "COMPLETED":
        raise HTTPException(
            status_code=409,
            detail=f"El job {job_id} aún no está COMPLETED (estado: {job.status}). "
                   "La segmentación debe completarse antes de acceder al NIfTI.",
        )

    # Buscar el archivo NIfTI en el directorio de salida
    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id
    nifti_candidates = list(output_dir.glob("*.nii.gz")) if output_dir.exists() else []

    if not nifti_candidates:
        # Fallback: buscar en result_data del job
        result = job.get_result_data()
        if result:
            nifti_url = result.get("artifacts", {}).get("segmentation_mask_nifti_url", "")
            nifti_path = Path(nifti_url) if nifti_url else None
            if nifti_path and nifti_path.exists():
                return FileResponse(
                    path=str(nifti_path),
                    media_type="application/gzip",
                    filename=nifti_path.name,
                )

        raise HTTPException(
            status_code=404,
            detail=f"Archivo NIfTI no encontrado para el job {job_id}.",
        )

    # Usar el primer (y normalmente único) archivo NIfTI encontrado
    nifti_path = nifti_candidates[0]

    return FileResponse(
        path=str(nifti_path),
        media_type="application/gzip",
        filename=nifti_path.name,
    )


# ===========================================================================
# Endpoint: GET /volume/{job_id}
# Protegido por API Key — sirve el volumen CT isotrópico (1×1×1 mm) en NIfTI
# ===========================================================================
@app.get(
    "/volume/{job_id}",
    summary="Servir volumen CT isotrópico (NIfTI)",
    description=(
        "Sirve el archivo volume_iso.nii.gz generado por el pipeline tras "
        "el resampling a 1×1×1 mm con SimpleITK. "
        "Si el ISO no existe, sirve volume.nii.gz (spacing original). "
        "Requiere el header X-API-Key para acceso."
    ),
)
async def serve_volume(
    job_id: str,
    _: None = Depends(verify_api_key),
    db: Session = Depends(get_db),
):
    """
    Sirve el volumen CT isotrópico para visualización MPR en el frontend.

    Prioridad de búsqueda:
    1. local_storage/outputs/{job_id}/volume_iso.nii.gz  ← remuestreado a 1 mm
    2. local_storage/outputs/{job_id}/volume.nii.gz      ← spacing original

    Seguridad:
    - job_id es un UUID v4 opaco.
    - Requiere X-API-Key válida en el header.
    - Verifica que el job exista en la DB y esté COMPLETED.
    """
    job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()

    if not job:
        raise HTTPException(status_code=404, detail=f"Job no encontrado: {job_id}")

    if job.status != "COMPLETED":
        raise HTTPException(
            status_code=409,
            detail=(
                f"El job {job_id} aún no está COMPLETED (estado: {job.status}). "
                "El volumen estará disponible cuando la segmentación finalice."
            ),
        )

    output_dir = LOCAL_STORAGE_BASE / "outputs" / job_id

    # Preferir el volumen isotrópico; fallback al original
    iso_path = output_dir / "volume_iso.nii.gz"
    raw_path = output_dir / "volume.nii.gz"

    if iso_path.exists() and iso_path.stat().st_size > 0:
        volume_path = iso_path
        logger.info(f"[{job_id}] Sirviendo volumen isotrópico: {iso_path}")
    elif raw_path.exists() and raw_path.stat().st_size > 0:
        volume_path = raw_path
        logger.info(
            f"[{job_id}] volume_iso.nii.gz no encontrado, sirviendo volume.nii.gz"
        )
    else:
        raise HTTPException(
            status_code=404,
            detail=f"Volumen CT no encontrado para el job {job_id}.",
        )

    return FileResponse(
        path=str(volume_path),
        media_type="application/gzip",
        filename=volume_path.name,
    )


# ===========================================================================
# Endpoint: GET /jobs — Listado paginado del historial de estudios
# ===========================================================================
@app.get(
    "/jobs",
    response_model=JobListResponse,
    summary="Listar historial de Jobs",
    description=(
        "Retorna la lista paginada de todos los Jobs de segmentación almacenados "
        "en SQLite, ordenados por fecha de creación descendente (más reciente primero). "
        "Soporta búsqueda por patient_pseudo_id y paginación con skip/limit."
    ),
)
def list_jobs(
    skip: int = 0,
    limit: int = 100,
    search: str = "",
    db: Session = Depends(get_db),
):
    """
    Endpoint del historial de estudios.

    Parámetros de consulta:
      - skip:   Offset para paginación (default 0).
      - limit:  Número máximo de resultados (default 100, max recomendado 200).
      - search: Filtro parcial por patient_pseudo_id (case-insensitive LIKE).

    Extrae las métricas clave (volume_ml, longest_diameter_mm) directamente
    desde el campo result_data (JSON serializado) de cada Job COMPLETED,
    sin exponer el payload completo al frontend.
    """
    import json as _json

    # ── Base query ordenada por fecha descendente ─────────────────────────
    query = db.query(SegmentationJob).order_by(SegmentationJob.created_at.desc())

    # ── Filtro de búsqueda por patient_pseudo_id ──────────────────────────
    # Se filtra sobre request_data (TEXT JSON) usando LIKE, suficientemente
    # eficiente para volúmenes < 10,000 registros sin índice extra.
    if search and search.strip():
        search_term = f"%{search.strip()}%"
        query = query.filter(
            SegmentationJob.request_data.like(search_term)
        )

    # ── Conteo total (antes de paginar) para el campo `total` ─────────────
    total = query.count()

    # ── Paginación ────────────────────────────────────────────────────────
    db_jobs = query.offset(skip).limit(limit).all()

    # ── Construir lista de JobListEntry ───────────────────────────────────
    entries = []
    for job in db_jobs:
        # Extraer patient_pseudo_id y file_count desde request_data
        patient_pseudo_id = None
        file_count = None
        try:
            rd = _json.loads(job.request_data) if job.request_data else {}
            patient_pseudo_id = rd.get("patient_pseudo_id")
            dicom_src = rd.get("dicom_source", {})
            file_count = dicom_src.get("expected_file_count")
        except (ValueError, TypeError):
            pass

        # Extraer métricas desde result_data (solo si COMPLETED)
        volume_ml = None
        longest_diameter_mm = None
        completed_at = None
        if job.status == "COMPLETED":
            try:
                res = _json.loads(job.result_data) if job.result_data else {}
                cr = res.get("clinical_results", {})
                volume_ml = cr.get("volumetric_data", {}).get("volume_ml")
                longest_diameter_mm = cr.get("recist_metrics", {}).get("longest_diameter_mm")
            except (ValueError, TypeError):
                pass
            completed_at = job.updated_at.isoformat() if job.updated_at else None

        entries.append(JobListEntry(
            job_id=job.job_id,
            patient_pseudo_id=patient_pseudo_id,
            status=job.status,
            created_at=job.created_at.isoformat() if job.created_at else "",
            completed_at=completed_at,
            file_count=file_count,
            volume_ml=volume_ml,
            longest_diameter_mm=longest_diameter_mm,
        ))

    return JobListResponse(total=total, jobs=entries)


# ===========================================================================
# Endpoint: GET /health
# ===========================================================================
@app.get(
    "/health",
    summary="Healthcheck",
    description="Verifica que la API está activa. Compatible con Docker HEALTHCHECK.",
)
def health_check():
    """Retorna un JSON simple indicando que el servicio está activo."""
    return {
        "status": "healthy",
        "service": "PulmoSeg 3D API",
        "version": "1.1.0-local",
    }
