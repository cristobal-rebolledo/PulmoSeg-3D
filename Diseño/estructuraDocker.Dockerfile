# 1. Imagen Base: NVIDIA CUDA 11.8 (Estrictamente requerida para PyTorch 2.1)
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

# Evitar prompts interactivos durante la instalación de paquetes en Ubuntu
ENV DEBIAN_FRONTEND=noninteractive

# 2. Instalar dependencias del sistema operativo
# libgl1-mesa-glx y libglib2.0-0 son OBLIGATORIAS para que SimpleITK y OpenCV procesen los NIfTI
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3-pip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Establecer el alias de python
RUN ln -s /usr/bin/python3.10 /usr/bin/python

# Establecer el directorio de trabajo
WORKDIR /app

# 3. Instalación de la capa más pesada (PyTorch)
# Se hace antes del requirements.txt para aprovechar el caché de capas de Docker.
RUN pip install --no-cache-dir torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cu118

# 4. Instalación de dependencias del proyecto
COPY requirements.txt .
# IMPORTANTE: El requirements.txt debe tener numpy==1.24.4 para evitar conflictos con PyTorch 2.1
RUN pip install --no-cache-dir -r requirements.txt

# 5. Copiar código fuente y pesos del modelo
COPY ./src ./src
COPY ./models/SegResNet_Lung_v2.1.pth ./models/

# 6. Configuración de Red y Healthcheck
ENV PORT=8080
EXPOSE 8080

# Healthcheck para que Cloud Run sepa cuándo el contenedor está listo para recibir tráfico
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl --fail http://localhost:8080/health || exit 1

# 7. Ejecución del Gateway Asíncrono
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]