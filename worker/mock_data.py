"""
mock_data.py — Respuestas estáticas para el entorno de desarrollo local.

Genera datos predefinidos basados en Diseño/GetSegmentationResult_Response.JSON
para simular los resultados de una segmentación exitosa sin ejecutar
inferencia real. Esto permite validar el flujo completo de la API
y la integración con el frontend en la Fase 1.
"""

from pathlib import Path


def get_mock_clinical_results() -> dict:
    """
    Retorna resultados clínicos simulados de una segmentación.

    Basado en: Diseño/GetSegmentationResult_Response.JSON → clinical_results
    Los valores representan una lesión típica en el lóbulo superior derecho (RUL)
    con métricas RECIST estándar.

    Returns:
        dict con lesion_id, volumetric_data y recist_metrics.
    """
    return {
        "lesion_id": "L1_RUL",
        "volumetric_data": {
            "volume_mm3": 4150.25,
            "volume_ml": 4.15,
        },
        "recist_metrics": {
            "measurement_plane": "AXIAL",
            "longest_diameter_mm": 24.3,
            "perpendicular_diameter_mm": 15.1,
            "confidence_score": 0.94,
        },
    }


def get_mock_artifacts(job_id: str) -> dict:
    """
    Retorna las rutas locales a los archivos de salida simulados.

    En producción estas serían Signed URLs de GCS. En el entorno local
    apuntan a /local_storage/outputs/{job_id}/.

    Args:
        job_id: Identificador único del Job de segmentación.

    Returns:
        dict con segmentation_mask_nifti_url y uncertainty_map_url.
    """
    output_base = Path("local_storage") / "outputs" / job_id

    return {
        "segmentation_mask_nifti_url": str(output_base / "mask.nii.gz"),
        "uncertainty_map_url": str(output_base / "uncertainty.nii.gz"),
    }


def get_mock_worker_details() -> dict:
    """
    Retorna detalles simulados del worker que procesó el Job.

    Basado en: Diseño/SegmentationJob_Document.json → worker_details
    Adaptado al entorno local: instance_id refleja ejecución local en CPU.

    Returns:
        dict con instance_id, model_hash y frameworks.
    """
    return {
        "instance_id": "local-cpu-worker-dev",
        "model_hash": (
            "sha256:e3b0c44298fc1c149afbf4c8996fb924"
            "27ae41e4649b934ca495991b7852b855"
        ),
        "frameworks": {
            "monai": "1.3.2",
            "torch": "2.2.0+cu118",
        },
    }
