"""
worker/pipeline/__init__.py — Punto de entrada del paquete pipeline modular.

Re-exporta run_inference_pipeline para mantener compatibilidad con el código
existente que importa desde worker.pipeline_monai.
"""

from worker.pipeline.manager import run_inference_pipeline

__all__ = ["run_inference_pipeline"]
