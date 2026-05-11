"""
worker/pipeline_monai.py — Shim de compatibilidad.

Este archivo mantiene la interfaz pública original para que cualquier código
existente que importe desde 'worker.pipeline_monai' siga funcionando sin cambios.

La lógica real ha sido modularizada en worker/pipeline/:
  - loader.py      → convert_dicom_to_nifti, resample_to_isotropic
  - transforms.py  → get_preprocessing_transforms
  - inference.py   → load_model, get_inferer
  - postprocess.py → postprocess_prediction, save_predicted_mask, save_uncertainty_map
  - manager.py     → run_inference_pipeline (orquestador principal)

Para usar las funciones directamente, importa desde el módulo específico:
  from worker.pipeline.loader import convert_dicom_to_nifti
  from worker.pipeline.inference import load_model
"""

# Re-exportar todo desde los módulos especializados
# para mantener compatibilidad con imports existentes.
from worker.pipeline.loader import convert_dicom_to_nifti, resample_to_isotropic
from worker.pipeline.transforms import get_preprocessing_transforms
from worker.pipeline.inference import load_model, get_inferer
from worker.pipeline.postprocess import (
    postprocess_prediction,
    save_predicted_mask,
    save_uncertainty_map,
)
from worker.pipeline.manager import run_inference_pipeline

__all__ = [
    "convert_dicom_to_nifti",
    "resample_to_isotropic",
    "get_preprocessing_transforms",
    "load_model",
    "get_inferer",
    "postprocess_prediction",
    "save_predicted_mask",
    "save_uncertainty_map",
    "run_inference_pipeline",
]
