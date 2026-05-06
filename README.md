# PulmoSeg-3D 🫁
**Plataforma Médica de Segmentación 3D impulsada por IA**

PulmoSeg-3D es una solución integral para la visualización y análisis de tomografías computarizadas (CT). Utiliza modelos de Deep Learning basados en **MONAI (Medical Open Network for AI)** para realizar segmentaciones volumétricas precisas y ofrece un visor avanzado Multiplanar (MPR) para validación clínica.

---

## 🚀 Características Principales

- **Pipeline de Inferencia Real**: Procesamiento de volúmenes DICOM reales usando MONAI y PyTorch.
- **Visor MPR Avanzado**: Visualización sincronizada en planos Axial, Coronal y Sagital.
- **Arquitectura Contenerizada**: Despliegue robusto mediante Docker para Backend, Frontend y Procesamiento.
- **Alineación Medical-Grade**: Resampleado dinámico para garantizar que las máscaras de IA coincidan perfectamente con la anatomía del paciente.
- **Gestión de Trabajos**: Sistema de colas asíncronas para procesar estudios grandes sin bloquear la interfaz.

---

## 🛠️ Stack Tecnológico

- **Frontend**: React.js, Vite, HTML5 Canvas (Medical Viewports).
- **Backend**: FastAPI (Python 3.10), SQLite (Persistencia).
- **IA/Procesamiento**: MONAI, PyTorch, SimpleITK.
- **Infraestructura**: Docker & Docker Compose.

---

## 📦 Instalación y Despliegue

### Requisitos Previos
- Docker y Docker Desktop (con WSL2 en Windows).
- Pesos del modelo (`model.pt`) colocados en `local_storage/models/spleen_model/model.pt`.

### Pasos Rápidos

1. **Configurar Entorno**:
   Copia el archivo de ejemplo y configura tu API Key:
   ```bash
   cp .env.example .env
   ```

2. **Levantar el Sistema**:
   Ejecuta el siguiente comando para construir e iniciar todos los servicios:
   ```bash
   docker compose up -d --build
   ```

3. **Acceder a la Plataforma**:
   - **Frontend**: [http://localhost](http://localhost)
   - **API Docs**: [http://localhost/api/docs](http://localhost/api/docs)

---

## 📂 Estructura del Proyecto

- `/api`: Servidor FastAPI que gestiona la lógica de negocio y la base de datos.
- `/worker`: Pipeline de procesamiento MONAI e inferencia de modelos.
- `/frontend`: Aplicación React con visores médicos personalizados.
- `/local_storage`: Volumen compartido para persistencia de DICOMs, NIfTIs y modelos (No incluido en Git).

---

## 🧪 Validación Espacial

El proyecto incluye una herramienta de validación matemática para asegurar que la segmentación coincide con el espacio físico del DICOM original:
```bash
docker compose exec backend python local_storage/verify_alignment.py <ruta_dicom> <ruta_nifti>
```

---

## 👨‍💻 Autor
**Cristóbal Rebolledo** - *Proyecto de Título (Semestre 11)*