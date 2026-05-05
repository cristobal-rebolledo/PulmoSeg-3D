# Instrucciones de Despliegue: Entorno de Desarrollo Local (Mock) - PulmoSeg 3D

## Contexto para el Agente de IA
Actúa como un Ingeniero de Software Senior. Los diagramas y archivos JSON adjuntos representan la arquitectura de producción en Google Cloud Platform (GCP). Sin embargo, el objetivo de esta iteración es construir un **Entorno de Desarrollo Local** funcional para validar la lógica del software sin incurrir en costos de nube ni requerir conectividad a servicios externos.

Debes generar el código fuente (FastAPI, SQLAlchemy, MONAI) aplicando las siguientes sustituciones y restricciones estrictas sobre el diseño original.

---

## 1. Sustitución de Infraestructura (Cloud a Local)

No utilices los SDKs de `google-cloud`. Implementa las siguientes alternativas locales:

* **Google Cloud Storage (GCS) -> Almacenamiento en Disco:**
    * Crea las siguientes carpetas en la raíz del proyecto para simular los buckets:
        * `/local_storage/inputs/` (Para archivos DICOM)
        * `/local_storage/outputs/` (Para máscaras NIfTI)
        * `/local_storage/models/` (Para pesos `.pth`)
* **Pub/Sub (Orquestación Asíncrona) -> BackgroundTasks:**
    * Sustituye la cola de mensajería asíncrona de GCP utilizando `BackgroundTasks` nativo de FastAPI para lanzar el Worker en segundo plano, o implementa un manejador de procesos multipropósito estándar de Python.
* **Firestore -> SQLite Local:**
    * Utiliza SQLAlchemy con una base de datos SQLite (`sqlite:///./local_jobs.db`).
    * El esquema de la tabla de trabajos debe reflejar exactamente la estructura del archivo `SegmentationJob_Document.json` adjunto (Campos requeridos: `job_id` [PK], `status` [Enum], `progress_percentage`, `worker_details`, `state_history`).

---

## 2. Comportamiento de la API Gateway y Mocking

Para desacoplar el desarrollo del Frontend de la ejecución del modelo de IA, la API debe implementar el siguiente comportamiento simulado (mock):

* **Endpoint `POST /segment`:**
    * Recibe la petición, valida el payload utilizando Pydantic basándose en `CreateSegmentationJob_Request.json`.
    * Crea el registro en SQLite con estado `QUEUED`.
    * Lanza la tarea en segundo plano y retorna inmediatamente un código HTTP 202 Accepted con el `job_id`.
* **Tarea en Segundo Plano (Worker Mock):**
    * Cambia el estado en SQLite a `PROCESSING`.
    * Ejecuta un `asyncio.sleep(5)` para simular la carga de cómputo.
    * Actualiza la base de datos local al estado `COMPLETED` e inyecta la estructura de resultados predefinida proporcionada en el archivo `GetSegmentationResult_Response.JSON`.
* **Endpoint `GET /status/{job_id}`:**
    * Consulta la base de datos SQLite y retorna el estado actual del procesamiento y los enlaces locales a los archivos en `/local_storage/outputs/`.

---

## 3. Restricciones de Hardware y Pipeline ML (MONAI)

El pipeline de inferencia médica debe programarse considerando restricciones estrictas de hardware local (límite máximo de 4GB de VRAM):

* **Configuración del Dispositivo:** Por defecto, el script de PyTorch (`pipeline_monai.py`) debe forzar el uso de la CPU (`device='cpu'`) o configurar variables de entorno para usar una GPU local en modo de baja memoria.
* **Gestión de Memoria (Sliding Window):** Si se utiliza la GPU para la inferencia con el modelo SegResNet, es obligatorio implementar `SlidingWindowInferer` de MONAI con un tamaño de parche (patch size) muy pequeño (ej. `[64, 64, 64]`) y `overlap` estándar, para evitar excepciones *Out Of Memory* (OOM).
* **Datos de Prueba:** El sistema debe estar preparado para ingerir e instanciar un volumen NIfTI recortado (Toy Dataset) enfocado únicamente en la lesión o nódulo, en lugar de procesar la cavidad torácica completa en un solo pase.

---

## 4. Estructura de Directorios Requerida

El agente debe organizar el código generado respetando la siguiente estructura modular:

```text
/pulmoseg-3d
├── /api
│   ├── main.py             # Entrypoint FastAPI y rutas
│   ├── schemas.py          # Modelos Pydantic (Request/Response)
│   └── database.py         # Configuración SQLAlchemy y SQLite
├── /worker
│   ├── background_task.py  # Ejecutor de tareas asíncronas
│   ├── pipeline_monai.py   # Lógica de segmentación de la lesión (CPU/Local)
│   └── mock_data.py        # Respuestas estáticas en base a los JSON
├── /local_storage
│   ├── inputs/
│   ├── outputs/
│   └── models/
└── requirements_local.txt  # Dependencias sin las librerías de GCP