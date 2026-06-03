# ===========================================================================
# Dockerfile.prod — Backend PulmoSeg-3D para Google Cloud Platform
#
# Diferencias con Dockerfile (desarrollo local):
#   - Instala requirements.txt (producción) en lugar de requirements_local.txt
#   - Incluye google-cloud-storage y asyncpg para GCS y Cloud SQL
#   - Sin volumen de local_storage (usa GCS para inputs/outputs/models)
#   - Compatible con Cloud Run GPU (NVIDIA T4)
#
# Build y push a Artifact Registry:
#   docker build -f Dockerfile.prod \
#     -t us-central1-docker.pkg.dev/pulmoseg3d/pulmoseg/backend:latest .
#   docker push us-central1-docker.pkg.dev/pulmoseg3d/pulmoseg/backend:latest
# ===========================================================================

FROM pytorch/pytorch:2.2.0-cuda11.8-cudnn8-runtime

# ---------------------------------------------------------------------------
# Labels de metadatos
# ---------------------------------------------------------------------------
LABEL maintainer="PulmoSeg-3D"
LABEL description="API FastAPI + Worker MONAI — Google Cloud Run (GPU)"
LABEL version="2.0.0-gcp"

# ---------------------------------------------------------------------------
# Variables de entorno del sistema
# ---------------------------------------------------------------------------
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    # Directorio temporal en memoria para caché del modelo descargado de GCS
    MONAI_DATA_DIRECTORY=/tmp/models \
    # Google Cloud — valores por defecto (sobreescritos por Cloud Run env vars)
    GCS_BUCKET_INPUTS=pulmoseg-inputs \
    GCS_BUCKET_OUTPUTS=pulmoseg-outputs \
    GCS_BUCKET_MODELS=pulmoseg-models

# ---------------------------------------------------------------------------
# Dependencias del sistema
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        libglib2.0-0 \
        libsm6 \
        libxrender1 \
        libxext6 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Directorio de trabajo
# ---------------------------------------------------------------------------
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencias Python (producción)
# ---------------------------------------------------------------------------
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# ---------------------------------------------------------------------------
# Código fuente
# ---------------------------------------------------------------------------
COPY api/ ./api/
COPY worker/ ./worker/

# ---------------------------------------------------------------------------
# Directorios temporales en memoria (no persisten entre requests en Cloud Run)
# ---------------------------------------------------------------------------
RUN mkdir -p /tmp/models /tmp/inputs /tmp/outputs

# ---------------------------------------------------------------------------
# Puerto expuesto
# ---------------------------------------------------------------------------
EXPOSE 8080

# ---------------------------------------------------------------------------
# Healthcheck
# ---------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8080/health || exit 1

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
# Puerto 8080: estándar de Cloud Run (sobreescribe el 8000 de desarrollo local)
# --workers 1: la cola FIFO serializa los jobs internamente
# --loop uvloop: mejor rendimiento async en Linux
CMD ["hypercorn", "api.main:app", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "1", \
     "--worker-class", "uvloop"]
