"""
main.py — Entrypoint FastAPI para PulmoSeg 3D (Entorno de Desarrollo Local).

Endpoints implementados:
  POST /segment      → Crea un Job de segmentación (HTTP 202 Accepted)
  GET  /status/{id}  → Consulta el estado actual de un Job
  GET  /health       → Healthcheck básico

Regla 1 aplicada:
  - Usa BackgroundTasks de FastAPI en lugar de Pub/Sub para orquestación asíncrona.
  - Crea directorios locales que simulan los buckets de GCS al arrancar.
  - Persiste el estado en SQLite vía SQLAlchemy (no Firestore).
"""

import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from sqlalchemy.orm import Session

from api.database import SegmentationJob, create_tables, get_db
from api.schemas import (
    Artifacts,
    ClinicalResults,
    JobInfo,
    JobTimestamps,
    RecistMetrics,
    SegmentationJobResponse,
    SegmentationRequest,
    SegmentationResultResponse,
    StateHistoryEntry,
    VolumetricData,
)
from worker.background_task import run_segmentation_job

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("pulmoseg.api")

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
# Lifespan: inicialización al arrancar el servidor
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Evento de startup de FastAPI.
    1. Crea las tablas SQLite si no existen.
    2. Crea los directorios de local_storage si no existen.
    """
    # 1. Crear tablas SQLite
    logger.info("Inicializando base de datos SQLite...")
    create_tables()
    logger.info("Base de datos lista: local_jobs.db")

    # 2. Crear directorios de almacenamiento local
    for dir_path in LOCAL_STORAGE_DIRS:
        dir_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Directorio de almacenamiento verificado: {dir_path}")

    logger.info("PulmoSeg 3D API lista para recibir solicitudes.")
    yield
    # Cleanup (si fuera necesario en el futuro)
    logger.info("Apagando PulmoSeg 3D API...")


# ---------------------------------------------------------------------------
# Instancia de la aplicación FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(
    title="PulmoSeg 3D — API de Segmentación Pulmonar",
    description=(
        "API Gateway para el sistema de segmentación 3D de lesiones pulmonares. "
        "Fase 1: Entorno de Desarrollo Local (Mock). "
        "Sustituye GCP (Firestore, GCS, Pub/Sub) por SQLite, filesystem y BackgroundTasks."
    ),
    version="1.0.0-local",
    lifespan=lifespan,
)


# ===========================================================================
# Endpoint: POST /segment
# ===========================================================================
@app.post(
    "/segment",
    response_model=SegmentationJobResponse,
    status_code=202,
    summary="Crear un Job de Segmentación",
    description=(
        "Recibe una solicitud de segmentación, la valida con Pydantic, "
        "crea el registro en SQLite con estado QUEUED, lanza la tarea "
        "en segundo plano y retorna HTTP 202 Accepted con el job_id."
    ),
)
def create_segmentation_job(
    request: SegmentationRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Flujo:
    1. Genera un job_id único (o usa idempotency_key si se proporciona).
    2. Crea registro en SQLite con estado QUEUED.
    3. Lanza BackgroundTask con el worker de segmentación.
    4. Retorna 202 Accepted inmediatamente.
    """
    # --- 1. Generar job_id ---
    # Usamos el idempotency_key del request como job_id para garantizar
    # idempotencia: si el mismo request se envía dos veces, se puede
    # detectar el duplicado.
    job_id = request.idempotency_key or f"req_{uuid.uuid4()}"

    # Verificar si ya existe un Job con este idempotency_key
    existing_job = db.query(SegmentationJob).filter(
        SegmentationJob.job_id == job_id
    ).first()

    if existing_job:
        logger.warning(f"Job duplicado detectado: {job_id}")
        return SegmentationJobResponse(
            job_id=existing_job.job_id,
            status=existing_job.status,
            message=f"Job already exists with status: {existing_job.status}",
        )

    # --- 2. Crear registro en SQLite ---
    new_job = SegmentationJob(
        job_id=job_id,
        status="QUEUED",
        progress_percentage=0,
    )
    # Serializar el request completo como JSON
    new_job.set_request_data(request.model_dump())
    # Inicializar historial de estados
    new_job.add_state_entry("QUEUED")

    db.add(new_job)
    db.commit()
    db.refresh(new_job)

    logger.info(f"Job creado: {job_id} | Status: QUEUED")

    # --- 3. Lanzar tarea en segundo plano ---
    # BackgroundTasks ejecuta funciones sync en un thread pool separado,
    # por lo que no bloquea el event loop de FastAPI.
    background_tasks.add_task(
        run_segmentation_job,
        job_id=job_id,
        request_data=request.model_dump(),
    )

    logger.info(f"BackgroundTask lanzada para Job: {job_id}")

    # --- 4. Retornar 202 Accepted ---
    return SegmentationJobResponse(
        job_id=job_id,
        status="QUEUED",
        message="Segmentation job queued successfully",
    )


# ===========================================================================
# Endpoint: GET /status/{job_id}
# ===========================================================================
@app.get(
    "/status/{job_id}",
    response_model=SegmentationResultResponse,
    summary="Consultar estado de un Job",
    description=(
        "Consulta la base de datos SQLite y retorna el estado actual "
        "del Job. Si está COMPLETED, incluye clinical_results y artifacts."
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
    - artifacts: Solo si COMPLETED (rutas a archivos de salida)
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
                )

    return SegmentationResultResponse(
        job_info=job_info,
        clinical_results=clinical_results,
        artifacts=artifacts,
        state_history=state_history,
        error_message=job.error_message,
    )


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
        "version": "1.0.0-local",
    }
