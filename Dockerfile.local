# ===========================================================================
# Dockerfile — Backend PulmoSeg-3D (FastAPI + PyTorch + MONAI + SimpleITK)
#
# Base: pytorch/pytorch:2.2.0-cuda11.8-cudnn8-runtime
#   - PyTorch 2.2.0 + CUDA 11.8 preinstalados (NO reinstalar torch via pip)
#   - Compatible con WSL2 + NVIDIA GPU via nvidia-container-toolkit
#   - Preparado para migración a Google Cloud (Cloud Run / GKE)
#
# Uso:
#   docker compose build backend
#   docker compose up backend
# ===========================================================================

FROM pytorch/pytorch:2.2.0-cuda11.8-cudnn8-runtime

# ---------------------------------------------------------------------------
# Labels de metadatos (OCI Image Spec)
# ---------------------------------------------------------------------------
LABEL maintainer="PulmoSeg-3D"
LABEL description="API FastAPI + Worker MONAI para segmentación pulmonar 3D"
LABEL version="1.1.0"

# ---------------------------------------------------------------------------
# Variables de entorno del sistema
# ---------------------------------------------------------------------------
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    # Previene que MONAI descargue datos de ejemplo en tiempo de ejecución
    MONAI_DATA_DIRECTORY=/app/local_storage/models

# ---------------------------------------------------------------------------
# Dependencias del sistema
# ---------------------------------------------------------------------------
# - curl:           Para el HEALTHCHECK de Docker
# - libglib2.0-0:   Requerido por SimpleITK/OpenCV en sistemas headless
# - libsm6, libxrender1, libxext6: Requeridos para rendering de imágenes (SimpleITK)
# - libgomp1:       OpenMP para paralelismo en MONAI transforms
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
# Dependencias Python
# ---------------------------------------------------------------------------
# Copiamos requirements ANTES que el código fuente para aprovechar el
# cache de capas Docker: si no cambian los deps, no se reinstalan.
#
# IMPORTANTE: torch, torchvision y torchaudio NO están en requirements_local.txt
# porque ya vienen preinstalados en la imagen base pytorch/pytorch.
# Incluirlos causaría un downgrade accidental a la versión CPU-only de PyPI.
# ---------------------------------------------------------------------------
COPY requirements_local.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements_local.txt

# ---------------------------------------------------------------------------
# Código fuente de la aplicación
# ---------------------------------------------------------------------------
COPY api/ ./api/
COPY worker/ ./worker/

# ---------------------------------------------------------------------------
# Estructura de directorios de almacenamiento local
# ---------------------------------------------------------------------------
# Estos directorios serán sobreescritos por el volumen Docker en runtime,
# pero crearlos aquí garantiza que existan si se ejecuta sin volumen.
RUN mkdir -p \
    local_storage/inputs \
    local_storage/outputs \
    local_storage/models

# ---------------------------------------------------------------------------
# Puerto expuesto
# ---------------------------------------------------------------------------
EXPOSE 8000

# ---------------------------------------------------------------------------
# Healthcheck
# ---------------------------------------------------------------------------
# start_period=90s: tiempo para que PyTorch/MONAI carguen en el primer arranque
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
# --workers 1: SQLite no soporta bien escrituras concurrentes.
#              BackgroundTasks de FastAPI corren en el mismo proceso del worker.
#              Para escalar horizontalmente, migrar a PostgreSQL + Celery/Redis.
# --loop uvloop: mejor rendimiento async en Linux
# ---------------------------------------------------------------------------
CMD ["uvicorn", "api.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--loop", "uvloop"]
