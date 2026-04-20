"""
schemas.py — Modelos Pydantic para validación de Request/Response de PulmoSeg 3D.

Modelos derivados exactamente de los JSON de diseño adjuntos:
  - CreateSegmentationJob_Request.json  → SegmentationRequest
  - GetSegmentationResult_Response.JSON → SegmentationResultResponse
  - SegmentationJob_Document.json       → Campos internos de estado

Regla 1 aplicada: Los campos que referencian GCS (gcs_bucket, gcs_prefix) se
mantienen en el schema por compatibilidad con el contrato de API, pero en el
entorno local se mapean a rutas del filesystem en /local_storage/.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ===========================================================================
# Modelos del REQUEST — POST /segment
# Basados en: Diseño/CreateSegmentationJob_Request.json
# ===========================================================================
class DicomSource(BaseModel):
    """Origen de los archivos DICOM.

    En producción apunta a un bucket GCS; en entorno local se mapea
    a /local_storage/inputs/.
    """
    gcs_bucket: str = Field(
        ..., description="Nombre del bucket GCS (o identificador local)"
    )
    gcs_prefix: str = Field(
        ..., description="Prefijo/ruta dentro del bucket donde están los DICOM"
    )
    series_instance_uid: str = Field(
        ..., description="UID de la serie DICOM a procesar"
    )
    expected_file_count: int = Field(
        ..., ge=1, description="Número esperado de archivos DICOM en la serie"
    )


class ROICoordinates(BaseModel):
    """Coordenadas del bounding box del ROI en voxels."""
    x_min: int = Field(..., ge=0)
    x_max: int = Field(..., ge=0)
    y_min: int = Field(..., ge=0)
    y_max: int = Field(..., ge=0)
    z_min: int = Field(..., ge=0)
    z_max: int = Field(..., ge=0)


class TargetROI(BaseModel):
    """Configuración del Region of Interest para el recorte volumétrico."""
    enabled: bool = Field(
        True, description="Si True, se aplica recorte ROI antes de la inferencia"
    )
    roi_validation_mode: str = Field(
        "STRICT",
        description="Modo de validación: STRICT rechaza coords fuera de rango"
    )
    coordinates: ROICoordinates


class ExecutionConfig(BaseModel):
    """Configuración de ejecución del pipeline de segmentación."""
    model_config = {"protected_namespaces": ()}

    model_version: str = Field(
        "SegResNet_Lung_v2.1",
        description="Versión del modelo de segmentación a utilizar"
    )
    priority: str = Field(
        "NORMAL",
        description="Prioridad de ejecución: LOW, NORMAL, HIGH"
    )
    webhook_url: Optional[str] = Field(
        None,
        description="URL de callback para notificar al frontend cuando termine"
    )


class SegmentationRequest(BaseModel):
    """
    Payload completo para crear un trabajo de segmentación.
    Basado en: Diseño/CreateSegmentationJob_Request.json

    Ejemplo:
    {
      "idempotency_key": "req_550e8400-e29b-41d4-a716-446655440000",
      "patient_pseudo_id": "anon_84729",
      "study_instance_uid": "1.2.840.113619.2...",
      "dicom_source": { ... },
      "target_roi": { ... },
      "execution_config": { ... }
    }
    """
    idempotency_key: str = Field(
        ...,
        description="Clave de idempotencia para evitar Jobs duplicados"
    )
    patient_pseudo_id: str = Field(
        ...,
        description="ID pseudoanonimizado del paciente"
    )
    study_instance_uid: str = Field(
        ...,
        description="UID del estudio DICOM"
    )
    dicom_source: DicomSource
    target_roi: TargetROI
    execution_config: ExecutionConfig


# ===========================================================================
# Modelos del RESPONSE — POST /segment (HTTP 202 Accepted)
# ===========================================================================
class SegmentationJobResponse(BaseModel):
    """Respuesta inmediata al crear un Job (HTTP 202 Accepted)."""
    job_id: str = Field(
        ..., description="Identificador único del trabajo de segmentación"
    )
    status: str = Field(
        "QUEUED", description="Estado inicial del Job"
    )
    message: str = Field(
        "Segmentation job queued successfully",
        description="Mensaje descriptivo"
    )


# ===========================================================================
# Modelos del RESPONSE — GET /status/{job_id}
# Basados en: Diseño/GetSegmentationResult_Response.JSON
# ===========================================================================
class VolumetricData(BaseModel):
    """Datos volumétricos de la lesión segmentada."""
    volume_mm3: float = Field(..., description="Volumen en milímetros cúbicos")
    volume_ml: float = Field(..., description="Volumen en mililitros")


class RecistMetrics(BaseModel):
    """Métricas RECIST (Response Evaluation Criteria In Solid Tumors)."""
    measurement_plane: str = Field(
        "AXIAL", description="Plano de medición (AXIAL, CORONAL, SAGITAL)"
    )
    longest_diameter_mm: float = Field(
        ..., description="Diámetro mayor de la lesión en mm"
    )
    perpendicular_diameter_mm: float = Field(
        ..., description="Diámetro perpendicular en mm"
    )
    confidence_score: float = Field(
        ..., ge=0.0, le=1.0, description="Confianza del modelo (0-1)"
    )


class ClinicalResults(BaseModel):
    """Resultados clínicos de la segmentación."""
    lesion_id: str = Field(
        ..., description="Identificador de la lesión (ej. L1_RUL)"
    )
    volumetric_data: VolumetricData
    recist_metrics: RecistMetrics


class Artifacts(BaseModel):
    """URLs/paths a los archivos generados por la segmentación."""
    segmentation_mask_nifti_url: str = Field(
        ...,
        description="Ruta al archivo NIfTI de la máscara de segmentación"
    )
    uncertainty_map_url: Optional[str] = Field(
        None,
        description="Ruta al mapa de incertidumbre (si se generó)"
    )


class JobTimestamps(BaseModel):
    """Timestamps del ciclo de vida del Job."""
    received_at: str = Field(..., description="Timestamp de recepción ISO 8601")
    completed_at: Optional[str] = Field(
        None, description="Timestamp de finalización ISO 8601"
    )


class JobInfo(BaseModel):
    """Información del estado del Job para la respuesta de status."""
    job_id: str
    status: str
    progress_percentage: int = Field(0, ge=0, le=100)
    timestamps: JobTimestamps


class StateHistoryEntry(BaseModel):
    """Entrada individual del historial de estados."""
    state: str
    time: str


class SegmentationResultResponse(BaseModel):
    """
    Respuesta completa del endpoint GET /status/{job_id}.
    Basado en: Diseño/GetSegmentationResult_Response.JSON

    Cuando el Job está COMPLETED, incluye clinical_results y artifacts.
    Cuando está QUEUED o PROCESSING, esos campos son None.
    """
    job_info: JobInfo
    clinical_results: Optional[ClinicalResults] = None
    artifacts: Optional[Artifacts] = None
    state_history: list[StateHistoryEntry] = Field(default_factory=list)
    error_message: Optional[str] = Field(
        None, description="Mensaje de error si el Job falló"
    )
