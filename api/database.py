"""
database.py — Configuración de SQLAlchemy para PulmoSeg 3D.

Soporta dos backends según la variable de entorno DATABASE_URL:
  - SQLite  (desarrollo local): sqlite:///./local_jobs.db
  - PostgreSQL (Cloud SQL GCP):  postgresql+psycopg2://user:pass@/dbname?host=/cloudsql/...

El esquema refleja exactamente la estructura de SegmentationJob_Document.json.
Los campos complejos (request_data, worker_details, state_history, result_data)
se almacenan como TEXT con serialización JSON para compatibilidad entre backends.
"""

import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Generator

# Configuración de zona horaria local (Chile)
LOCAL_TZ = ZoneInfo("America/Santiago")

from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# ---------------------------------------------------------------------------
# Configuración del Engine
# ---------------------------------------------------------------------------
# DATABASE_URL se lee desde la variable de entorno.
#
# Desarrollo local (SQLite):
#   DATABASE_URL=sqlite:///./local_jobs.db   (default)
#
# Cloud Run / Cloud SQL (PostgreSQL):
#   DATABASE_URL=postgresql+psycopg2://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
#   La conexión a Cloud SQL usa Unix socket (/cloudsql/...) en Cloud Run.
#
# check_same_thread: solo necesario para SQLite (no aplicable a PostgreSQL).
SQLALCHEMY_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite:///./local_jobs.db"
)

_is_sqlite = SQLALCHEMY_DATABASE_URL.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args=_connect_args,
    echo=False,  # Cambiar a True para debug SQL
    # Pool pre-ping verifica la conexión antes de usarla (útil para Cloud SQL)
    pool_pre_ping=not _is_sqlite,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ---------------------------------------------------------------------------
# Modelo ORM: SegmentationJob
# ---------------------------------------------------------------------------
# Mapeado desde Diseño/SegmentationJob_Document.json:
# {
#   "job_id": "req_550e8400-...",
#   "status": "PROCESSING",
#   "progress_percentage": 45,
#   "request_data": { ... },
#   "worker_details": { "instance_id": ..., "model_hash": ..., "frameworks": {...} },
#   "state_history": [ {"state": "QUEUED", "time": "..."}, ... ]
# }
class SegmentationJob(Base):
    __tablename__ = "segmentation_jobs"

    # --- Campos principales ---
    job_id = Column(String, primary_key=True, index=True)
    status = Column(String, nullable=False, default="QUEUED")
    progress_percentage = Column(Integer, nullable=False, default=0)

    # --- Campos JSON serializados como TEXT ---
    # Almacena el payload completo del CreateSegmentationJob_Request.json
    request_data = Column(Text, nullable=True)
    # Almacena detalles del worker: instance_id, model_hash, frameworks
    worker_details = Column(Text, nullable=True)
    # Lista de transiciones de estado: [{"state": "QUEUED", "time": "..."}]
    state_history = Column(Text, nullable=False, default="[]")
    # Almacena GetSegmentationResult_Response.JSON cuando el job completa
    result_data = Column(Text, nullable=True)
    # Mensaje de error si el job falla
    error_message = Column(Text, nullable=True)

    # --- Timestamps ---
    created_at = Column(
        DateTime, nullable=False, default=lambda: datetime.now(LOCAL_TZ)
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(LOCAL_TZ),
        onupdate=lambda: datetime.now(LOCAL_TZ),
    )

    # --- Helpers de serialización JSON ---
    def get_state_history(self) -> list[dict]:
        """Deserializa state_history desde JSON TEXT."""
        try:
            return json.loads(self.state_history) if self.state_history else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_state_history(self, history: list[dict]) -> None:
        """Serializa state_history a JSON TEXT."""
        self.state_history = json.dumps(history, default=str)

    def add_state_entry(self, state: str) -> None:
        """Agrega una entrada al historial de estados con timestamp actual."""
        history = self.get_state_history()
        history.append({
            "state": state,
            "time": datetime.now(LOCAL_TZ).isoformat(),
        })
        self.set_state_history(history)

    def get_request_data(self) -> dict | None:
        """Deserializa request_data desde JSON TEXT."""
        try:
            return json.loads(self.request_data) if self.request_data else None
        except (json.JSONDecodeError, TypeError):
            return None

    def set_request_data(self, data: dict) -> None:
        """Serializa request_data a JSON TEXT."""
        self.request_data = json.dumps(data, default=str)

    def get_worker_details(self) -> dict | None:
        """Deserializa worker_details desde JSON TEXT."""
        try:
            return json.loads(self.worker_details) if self.worker_details else None
        except (json.JSONDecodeError, TypeError):
            return None

    def set_worker_details(self, data: dict) -> None:
        """Serializa worker_details a JSON TEXT."""
        self.worker_details = json.dumps(data, default=str)

    def get_result_data(self) -> dict | None:
        """Deserializa result_data desde JSON TEXT."""
        try:
            return json.loads(self.result_data) if self.result_data else None
        except (json.JSONDecodeError, TypeError):
            return None

    def set_result_data(self, data: dict) -> None:
        """Serializa result_data a JSON TEXT."""
        self.result_data = json.dumps(data, default=str)

    def __repr__(self) -> str:
        return (
            f"<SegmentationJob(job_id='{self.job_id}', "
            f"status='{self.status}', "
            f"progress={self.progress_percentage}%)>"
        )


# ---------------------------------------------------------------------------
# Funciones de utilidad
# ---------------------------------------------------------------------------
def create_tables() -> None:
    """Crea todas las tablas definidas en Base si no existen."""
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    """
    Dependency injection para FastAPI.
    Provee una sesión de DB que se cierra automáticamente al finalizar el request.

    Uso en endpoints:
        @app.get("/example")
        def example(db: Session = Depends(get_db)):
            ...
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
