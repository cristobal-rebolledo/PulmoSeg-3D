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


def get_worker_details() -> dict:
    """
    Retorna detalles del worker que procesó el Job, detectando el hardware real
    y calculando la huella digital (hash) real del modelo cargado.
    """
    import torch
    import hashlib
    from worker.model_config import get_config_by_name

    # Calcular y cachear el hash del modelo para no penalizar cada request
    if not hasattr(get_worker_details, "_cached_hash"):
        config = get_config_by_name()
        if config.weights_path.exists():
            sha256 = hashlib.sha256()
            with open(config.weights_path, 'rb') as f:
                while chunk := f.read(8192 * 1024):  # 8MB chunks
                    sha256.update(chunk)
            get_worker_details._cached_hash = "sha256:" + sha256.hexdigest()
        else:
            get_worker_details._cached_hash = "sha256:unknown_not_found"

    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0).replace(" ", "-").lower()
        instance_id = f"cloud-run-gpu-{gpu_name}"
    else:
        instance_id = "cloud-run-cpu-worker"
        
    return {
        "instance_id": instance_id,
        "model_hash": get_worker_details._cached_hash,
        "frameworks": {
            "monai": "1.3.2",
            "torch": "2.2.0" + ("+cu118" if torch.cuda.is_available() else "+cpu"),
        },
    }
