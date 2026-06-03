#!/usr/bin/env python3
"""
run_auto3dseg.py — Entrenamiento con MONAI Auto3DSeg para MSD Task06_Lung
================================================================================
Este script implementa el pipeline de Auto3DSeg con las siguientes restricciones:
- Arquitectura: solo SegResNet
- Folds: 1 (fold 0)
- Epochs: 300
- Patch Size: 96x96x96
- Batch Size: 2

Lee directamente el dataset.json original de Task06_Lung, genera un datalist.json 
compatible con Auto3DSeg y lanza el entrenamiento.
"""

import json
import os
import shutil
import sys
from pathlib import Path

from monai.apps.auto3dseg import AutoRunner

# ===========================================================================
# Configuración
# ===========================================================================
DATASET_DIR = Path.home() / "datasets" / "Task06_Lung"
WORK_DIR = Path.home() / "training_output" / "auto3dseg_tumor"
DATALIST_PATH = WORK_DIR / "datalist.json"
GCS_MODEL_PATH = "gs://pulmoseg-models/trained/tumor_segresnet_auto/model.pt"

# Hiperparámetros solicitados
EPOCHS = 300
PATCH_SIZE = [96, 96, 96]
BATCH_SIZE = 2


def prepare_datalist():
    """
    Lee dataset.json original de Task06_Lung y genera datalist.json para Auto3DSeg.
    Asigna el 20% de los datos al fold 0 (validación en el fold 0) y el 80% a los folds 1-4.
    """
    orig_json_path = DATASET_DIR / "dataset.json"
    if not orig_json_path.exists():
        print(f"❌ Error: No se encontró el dataset en {orig_json_path}")
        sys.exit(1)

    with open(orig_json_path, "r") as f:
        meta = json.load(f)

    training_files = meta.get("training", [])
    if not training_files:
        print("❌ Error: No hay datos de entrenamiento en dataset.json")
        sys.exit(1)

    print(f"✅ Encontrados {len(training_files)} casos en dataset.json original.")

    # Generar split para 5 folds (para que AutoRunner haga el fold 0 correctamente)
    # Auto3DSeg usa el fold especificado como validación, y el resto como entrenamiento.
    datalist_entries = []
    for idx, item in enumerate(training_files):
        # Resolver rutas absolutas
        img_path = str(DATASET_DIR / item["image"].lstrip("./"))
        lbl_path = str(DATASET_DIR / item["label"].lstrip("./"))
        
        # Distribuir en 5 folds (0, 1, 2, 3, 4)
        fold_idx = idx % 5
        
        datalist_entries.append({
            "fold": fold_idx,
            "image": img_path,
            "label": lbl_path
        })

    datalist = {
        "testing": [],
        "training": datalist_entries
    }

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    with open(DATALIST_PATH, "w") as f:
        json.dump(datalist, f, indent=4)
        
    print(f"✅ Archivo datalist.json generado en {DATALIST_PATH} con {len(datalist_entries)} registros.")


def run_auto3dseg():
    """
    Inicia AutoRunner con las restricciones de SegResNet, épocas, parche y batch.
    """
    # El archivo de configuración de entrada para Auto3DSeg
    input_config = {
        "name": "Task06_Lung",
        "task": "segmentation",
        "modality": "CT",
        "datalist": str(DATALIST_PATH),
        "dataroot": "/",  # Las rutas en datalist.json ya son absolutas
    }

    # Restricciones para los algoritmos (sobreescribimos los valores por defecto)
    train_params = {
        "num_epochs": EPOCHS,
        "patch_size": PATCH_SIZE,
        "batch_size": BATCH_SIZE,
    }

    print("\n🚀 Iniciando AutoRunner de MONAI...")
    runner = AutoRunner(
        work_dir=str(WORK_DIR),
        input=input_config,
        algos=["segresnet"]  # Filtrar explícitamente para usar SOLO la plantilla SegResNet
    )
    
    # 1. Limitar hiperparámetros
    runner.set_training_params(params=train_params)
    
    # Solo ejecutar Fold 0
    runner.set_num_fold(1)
    
    # Preparar el entorno y generar los scripts de entrenamiento
    runner.run()
    
    print("✅ Auto3DSeg finalizó correctamente.")


if __name__ == "__main__":
    prepare_datalist()
    run_auto3dseg()
