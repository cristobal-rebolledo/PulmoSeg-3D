# PulmoSeg-3D 🫁
**Plataforma Médica de Segmentación 3D impulsada por IA**

PulmoSeg-3D es una solución integral para la visualización y análisis de tomografías computarizadas (CT). Utiliza modelos de Deep Learning basados en **MONAI (Medical Open Network for AI)** para realizar segmentaciones volumétricas precisas y ofrece un visor avanzado Multiplanar (MPR) para validación clínica.

---

## 🚀 Características Principales

- **Pipeline de Inferencia en la Nube**: Inferencia usando `SegResNet` optimizado con `Sliding Window` ejecutado en aceleradores **NVIDIA L4** a través de Google Cloud Run.
- **Visor MPR Avanzado**: Visualización sincronizada en planos Axial, Coronal y Sagital, cargando artefactos DICOM directamente desde la nube.
- **Arquitectura Serverless y Escalable**: El sistema es totalmente "stateless" (sin estado), escalando horizontalmente según la demanda de los usuarios.
- **Alineación Medical-Grade**: Resampleado dinámico para garantizar que las máscaras de IA coincidan perfectamente con la anatomía del paciente original.
- **Configuración Dinámica**: Ficha técnica e interfaz adaptativa sincronizada en tiempo real mediante un endpoint `/config` desde el motor del modelo.

---

## 🛠️ Stack Tecnológico Actualizado

### 🖥️ Frontend
- **Framework**: React.js + Vite.
- **Visualización**: HTML5 Canvas (Medical Viewports adaptativos).
- **Despliegue**: Google Cloud Run (contenedores serverless tanto para Backend como Frontend).

### ⚙️ Backend
- **Framework**: FastAPI (Python 3.10) + Uvicorn.
- **Inferencia**: MONAI 1.x, PyTorch 2.2.0, SimpleITK.
- **Base de Datos**: PostgreSQL alojado en Google Cloud SQL (reemplaza a SQLite).
- **Almacenamiento (Storage)**: Google Cloud Storage (GCS) usando los buckets `pulmoseg-inputs`, `pulmoseg-outputs` y `pulmoseg-models`.
- **Despliegue**: Google Cloud Run (Instancias de 2ª Generación, 4 vCPU, 16GiB RAM, 1x NVIDIA L4).

---

## 📦 Despliegue en la Nube (Google Cloud Platform)

### 1. Configuración de Variables de Entorno (Backend)
El servicio Cloud Run inyecta los secretos de forma segura a través de `Secret Manager`. Se requiere configurar las siguientes variables:
- `DATABASE_URL`: URI de conexión a tu instancia Cloud SQL (PostgreSQL).
- `PULMOSEG_API_KEY`: Clave de seguridad del sistema.
- `GCS_BUCKET_INPUTS`: `pulmoseg-inputs`
- `GCS_BUCKET_OUTPUTS`: `pulmoseg-outputs`
- `GCS_BUCKET_MODELS`: `pulmoseg-models`

### 2. Despliegue del Backend (Cloud Run)
Se debe compilar la imagen Docker localmente o mediante Cloud Build, especificando el acelerador L4 y desactivando la redundancia zonal para la GPU:
```bash
gcloud run deploy pulmoseg-backend \
  --source . \
  --project pulmoseg3d \
  --region us-central1 \
  --cpu=4 \
  --memory=16Gi \
  --concurrency=1 \
  --max-instances=3 \
  --set-env-vars="GCS_BUCKET_INPUTS=pulmoseg-inputs,GCS_BUCKET_OUTPUTS=pulmoseg-outputs" \
  --set-secrets="DATABASE_URL=pulmoseg-db-url:latest,PULMOSEG_API_KEY=pulmoseg-api-key:latest" \
  --allow-unauthenticated
### 3. Despliegue del Frontend (Cloud Run)
El frontend se sirve mediante Nginx y se compila automáticamente en Google Cloud Build. El sistema leerá automáticamente el archivo `.env.production` (asegúrate de que esté configurado) para inyectar la URL del backend.

Ejecuta el siguiente comando para compilar y desplegar el frontend en Cloud Run:
```bash
gcloud run deploy pulmoseg-frontend \
  --source ./frontend \
  --project pulmoseg3d \
  --region us-central1 \
  --allow-unauthenticated
```

---

## 💻 Entorno de Desarrollo Local (Docker Compose)

Si deseas probar el sistema en tu propia máquina (requiere Docker Desktop con soporte GPU WSL2 en Windows o Linux nativo):

1. **Configurar Entorno**:
   Copia el archivo `.env.example` a `.env` y ajusta `PULMOSEG_API_KEY`.
2. **Levantar el Sistema**:
   ```bash
   docker compose up -d --build
   ```
3. **Acceso**:
   - Web: [http://localhost](http://localhost)
   - Swagger API: [http://localhost:8000/docs](http://localhost:8000/docs)

---

## 📂 Estructura del Proyecto

- `/api`: Controlador FastAPI, gestión de base de datos (PostgreSQL/SQLite) e integración con GCS.
- `/worker`: Pipeline de procesamiento MONAI `SegResNet`, inferencia y transformaciones volumétricas.
- `/frontend`: Aplicación React orientada a componentes.
- `/system_tests`: Scripts de validación automatizada (Pruebas de Carga, Latencia y limpieza de buckets en la nube).

---

## 👨‍💻 Autor
**Cristóbal Rebolledo** - *Proyecto de Título (Semestre 11)*