#!/usr/bin/env python3
"""
train_lung_tumor_segresnet.py — Entrenamiento SegResNet para Segmentación de Tumores Pulmonares
=========================================================================================
Dataset  : MSD Task06_Lung (63 casos de entrenamiento, etiqueta 1 = cancer)
Modelo   : SegResNet (MONAI)
Entrena  : 1 fold | 300 epochs | patch 96×96×96 | batch 2
Salida   : Mejor modelo por Dice de validación → gs://pulmoseg-models/trained/lung_tumor_segresnet_v1/model.pt

Uso:
    # Desde la VM (después de ejecutar setup_vm.sh):
    python training/train_lung_tumor_segresnet.py

    # Con ruta personalizada al dataset:
    python training/train_lung_tumor_segresnet.py --dataset_dir /home/datasets/Task06_Lung
"""

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

import torch
import numpy as np
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR

import monai
from monai.data import CacheDataset, DataLoader, decollate_batch
from monai.inferers import sliding_window_inference
from monai.losses import DiceCELoss
from monai.metrics import DiceMetric
from monai.networks.nets import SegResNet
from monai.transforms import (
    Activations,
    AsDiscrete,
    Compose,
    CropForegroundd,
    EnsureChannelFirstd,
    EnsureTyped,
    LoadImaged,
    Orientationd,
    RandCropByPosNegLabeld,
    RandFlipd,
    RandRotate90d,
    RandShiftIntensityd,
    ScaleIntensityRanged,
    Spacingd,
    ToTensord,
)
from monai.utils import set_determinism

# ===========================================================================
# Configuración del Entrenamiento
# ===========================================================================

# Rutas (se sobreescriben con --dataset_dir si se pasa por argumento)
DEFAULT_DATASET_DIR = Path("/home/datasets/Task06_Lung")
OUTPUT_DIR = Path("/home/training_output/lung_tumor_segresnet_v1")
GCS_MODEL_PATH = "gs://pulmoseg-models/trained/lung_tumor_segresnet_v1/model.pt"

# Hiperparámetros (según las restricciones solicitadas)
PATCH_SIZE = (96, 96, 96)
BATCH_SIZE = 2
NUM_EPOCHS = 300
VAL_INTERVAL = 10        # Validar cada N épocas
NUM_WORKERS = 4
LEARNING_RATE = 1e-4
WEIGHT_DECAY = 1e-5
VAL_SPLIT = 0.2          # 20% para validación (aprox. 12 de 63)
CACHE_RATE_TRAIN = 0.5   # Cachear 50% del set de entrenamiento en RAM
CACHE_RATE_VAL = 1.0     # Cachear 100% del set de validación en RAM

# CT: rango de Hounsfield típico para pulmones/tumores
HU_MIN = -1000
HU_MAX = 400

# Semilla para reproducibilidad
set_determinism(seed=42)


# ===========================================================================
# Logging
# ===========================================================================

def setup_logging(output_dir: Path) -> logging.Logger:
    output_dir.mkdir(parents=True, exist_ok=True)
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(output_dir / "training.log"),
    ]
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(message)s",
        handlers=handlers,
    )
    return logging.getLogger("pulmoseg.training")


# ===========================================================================
# Dataset
# ===========================================================================

def load_dataset_files(dataset_dir: Path, logger: logging.Logger):
    """
    Lee dataset.json de Task06_Lung y construye listas de dicts
    {image: ..., label: ...} con rutas absolutas.

    No usa DecathlonDataset — lee los NIfTI directamente.
    Split: los primeros 20% de casos como validación (fold fijo).
    """
    json_path = dataset_dir / "dataset.json"
    if not json_path.exists():
        raise FileNotFoundError(f"dataset.json no encontrado en: {dataset_dir}")

    with open(json_path) as f:
        meta = json.load(f)

    data_list = []
    skipped = 0
    for entry in meta["training"]:
        # Las rutas en dataset.json son relativas ("./imagesTr/lung_001.nii.gz")
        img_path = dataset_dir / entry["image"].lstrip("./")
        lbl_path = dataset_dir / entry["label"].lstrip("./")
        if img_path.exists() and lbl_path.exists():
            data_list.append({"image": str(img_path), "label": str(lbl_path)})
        else:
            logger.warning(f"Archivo no encontrado, omitiendo: {img_path.name}")
            skipped += 1

    total = len(data_list)
    logger.info(f"Casos encontrados: {total}  |  Omitidos: {skipped}")

    # Split train/val (los primeros VAL_SPLIT% como validación)
    n_val = max(1, int(total * VAL_SPLIT))
    val_files = data_list[:n_val]
    train_files = data_list[n_val:]

    logger.info(f"Entrenamiento: {len(train_files)} casos  |  Validación: {len(val_files)} casos")
    logger.info(f"Validación: {[Path(f['image']).name for f in val_files]}")

    return train_files, val_files


# ===========================================================================
# Transforms
# ===========================================================================

def get_transforms():
    """
    Transforms estándar para CT de pulmón con tumor.
    - Orientación: RAS
    - Resampling: 1.5×1.5×2.0 mm (anisótropo, optimizado para T4 16GB)
    - Intensidad: HU [-1000, 400] → [0, 1]
    - Augmentation: flips, rotaciones, shift de intensidad
    - Parches: 96×96×96 con balance pos/neg 1:1
    """
    keys = ["image", "label"]

    train_transforms = Compose([
        LoadImaged(keys=keys),
        EnsureChannelFirstd(keys=keys),
        EnsureTyped(keys=keys),
        Orientationd(keys=keys, axcodes="RAS"),
        Spacingd(
            keys=keys,
            pixdim=(1.5, 1.5, 2.0),
            mode=("bilinear", "nearest"),
        ),
        ScaleIntensityRanged(
            keys=["image"],
            a_min=HU_MIN, a_max=HU_MAX,
            b_min=0.0, b_max=1.0,
            clip=True,
        ),
        CropForegroundd(keys=keys, source_key="image"),
        RandCropByPosNegLabeld(
            keys=keys,
            label_key="label",
            spatial_size=PATCH_SIZE,
            pos=1, neg=1,
            num_samples=4,        # 4 parches por volumen por iteración
            image_key="image",
            image_threshold=0,
        ),
        RandFlipd(keys=keys, spatial_axis=[0], prob=0.5),
        RandFlipd(keys=keys, spatial_axis=[1], prob=0.5),
        RandFlipd(keys=keys, spatial_axis=[2], prob=0.5),
        RandRotate90d(keys=keys, prob=0.1, max_k=3),
        RandShiftIntensityd(keys=["image"], offsets=0.1, prob=0.5),
        ToTensord(keys=keys),
    ])

    val_transforms = Compose([
        LoadImaged(keys=keys),
        EnsureChannelFirstd(keys=keys),
        EnsureTyped(keys=keys),
        Orientationd(keys=keys, axcodes="RAS"),
        Spacingd(
            keys=keys,
            pixdim=(1.5, 1.5, 2.0),
            mode=("bilinear", "nearest"),
        ),
        ScaleIntensityRanged(
            keys=["image"],
            a_min=HU_MIN, a_max=HU_MAX,
            b_min=0.0, b_max=1.0,
            clip=True,
        ),
        CropForegroundd(keys=keys, source_key="image"),
        ToTensord(keys=keys),
    ])

    return train_transforms, val_transforms


# ===========================================================================
# Modelo
# ===========================================================================

def build_model(device: torch.device) -> SegResNet:
    """
    SegResNet configurado para 2 clases (background + tumor de pulmón).
    init_filters=16 equilibra precisión y uso de VRAM en GPU T4 de 16GB.
    """
    model = SegResNet(
        blocks_down=[1, 2, 2, 4],
        blocks_up=[1, 1, 1],
        init_filters=16,
        in_channels=1,
        out_channels=2,       # 0=background, 1=cancer
        dropout_prob=0.2,
    ).to(device)

    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return model, n_params


# ===========================================================================
# Upload a GCS
# ===========================================================================

def upload_to_gcs(local_path: Path, gcs_path: str, logger: logging.Logger):
    """Sube el modelo entrenado a Google Cloud Storage usando gsutil."""
    logger.info(f"Subiendo modelo a GCS: {local_path} → {gcs_path}")
    result = subprocess.run(
        ["gsutil", "cp", str(local_path), gcs_path],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        logger.info(f"✅ Modelo subido exitosamente: {gcs_path}")
    else:
        logger.error(f"❌ Error al subir modelo: {result.stderr}")


# ===========================================================================
# Bucle principal de entrenamiento
# ===========================================================================

def train(dataset_dir: Path):
    logger = setup_logging(OUTPUT_DIR)

    logger.info("=" * 65)
    logger.info("  PulmoSeg 3D — Entrenamiento Tumor Pulmonar (SegResNet)")
    logger.info(f"  MONAI v{monai.__version__}  |  PyTorch v{torch.__version__}")
    logger.info("=" * 65)

    # Dispositivo
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info(f"Dispositivo: {device}")
    if device.type == "cuda":
        props = torch.cuda.get_device_properties(0)
        logger.info(f"GPU: {props.name}  |  VRAM: {props.total_memory / 1e9:.1f} GB")

    # Dataset
    train_files, val_files = load_dataset_files(dataset_dir, logger)
    train_transforms, val_transforms = get_transforms()

    logger.info(f"Cargando dataset con caché (train={CACHE_RATE_TRAIN}, val={CACHE_RATE_VAL})...")
    train_ds = CacheDataset(
        data=train_files,
        transform=train_transforms,
        cache_rate=CACHE_RATE_TRAIN,
        num_workers=NUM_WORKERS,
    )
    val_ds = CacheDataset(
        data=val_files,
        transform=val_transforms,
        cache_rate=CACHE_RATE_VAL,
        num_workers=NUM_WORKERS,
    )

    train_loader = DataLoader(
        train_ds, batch_size=BATCH_SIZE, shuffle=True,
        num_workers=NUM_WORKERS, pin_memory=torch.cuda.is_available(),
    )
    val_loader = DataLoader(
        val_ds, batch_size=1, num_workers=NUM_WORKERS,
        pin_memory=torch.cuda.is_available(),
    )

    # Modelo
    model, n_params = build_model(device)
    logger.info(f"Modelo: SegResNet | Parámetros: {n_params:,}")

    # Pérdida, optimizador, scheduler
    loss_fn = DiceCELoss(to_onehot_y=True, softmax=True)
    optimizer = AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    scheduler = CosineAnnealingLR(optimizer, T_max=NUM_EPOCHS, eta_min=1e-6)

    # Métrica
    dice_metric = DiceMetric(include_background=False, reduction="mean")

    # Post-procesado para validación
    post_pred = Compose([Activations(softmax=True), AsDiscrete(argmax=True, to_onehot=2)])
    post_label = AsDiscrete(to_onehot=True, n_classes=2)

    logger.info("-" * 65)
    logger.info(f"  Epochs       : {NUM_EPOCHS}")
    logger.info(f"  Patch size   : {PATCH_SIZE}")
    logger.info(f"  Batch size   : {BATCH_SIZE}")
    logger.info(f"  LR inicial   : {LEARNING_RATE} (CosineAnnealing hasta 1e-6)")
    logger.info(f"  Fold         : 1 de 1  (split fijo 80/20)")
    logger.info(f"  Val interval : cada {VAL_INTERVAL} epochs")
    logger.info(f"  Output       : {OUTPUT_DIR}")
    logger.info("-" * 65)

    best_metric = -1.0
    best_metric_epoch = -1
    start_time = time.time()

    for epoch in range(NUM_EPOCHS):
        epoch_start = time.time()
        model.train()
        epoch_loss = 0.0
        step = 0

        for batch_data in train_loader:
            step += 1
            inputs = batch_data["image"].to(device)
            labels = batch_data["label"].to(device)

            optimizer.zero_grad()
            outputs = model(inputs)
            loss = loss_fn(outputs, labels)
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()

        scheduler.step()
        epoch_loss /= step
        epoch_time = time.time() - epoch_start

        # ── Validación cada VAL_INTERVAL épocas ──────────────────────────
        if (epoch + 1) % VAL_INTERVAL == 0:
            model.eval()
            with torch.no_grad():
                for val_data in val_loader:
                    val_inputs = val_data["image"].to(device)
                    val_labels = val_data["label"].to(device)

                    val_outputs = sliding_window_inference(
                        inputs=val_inputs,
                        roi_size=PATCH_SIZE,
                        sw_batch_size=4,
                        predictor=model,
                    )

                    # Post-procesar: logits → máscaras discretas one-hot
                    val_outputs_list = decollate_batch(val_outputs)
                    val_labels_list = decollate_batch(val_labels)

                    val_preds = [post_pred(p) for p in val_outputs_list]
                    val_lbls = [post_label(l) for l in val_labels_list]

                    dice_metric(y_pred=val_preds, y=val_lbls)

            metric = dice_metric.aggregate().item()
            dice_metric.reset()

            elapsed_h = (time.time() - start_time) / 3600
            remaining_epochs = NUM_EPOCHS - epoch - 1
            eta_h = elapsed_h / (epoch + 1) * remaining_epochs

            logger.info(
                f"Epoch [{epoch+1:>3}/{NUM_EPOCHS}]  "
                f"Loss: {epoch_loss:.4f}  |  "
                f"Val Dice: {metric:.4f}  |  "
                f"Tiempo: {epoch_time:.1f}s  |  "
                f"Transcurrido: {elapsed_h:.1f}h  |  "
                f"ETA: {eta_h:.1f}h"
            )

            # Guardar si es el mejor modelo hasta ahora
            if metric > best_metric:
                best_metric = metric
                best_metric_epoch = epoch + 1
                best_path = OUTPUT_DIR / "best_model.pt"
                torch.save(model.state_dict(), best_path)
                logger.info(
                    f"  ✅ Nuevo mejor modelo guardado — "
                    f"Dice: {best_metric:.4f} (epoch {best_metric_epoch})"
                )
        else:
            logger.info(
                f"Epoch [{epoch+1:>3}/{NUM_EPOCHS}]  "
                f"Loss: {epoch_loss:.4f}  |  "
                f"Tiempo: {epoch_time:.1f}s"
            )

    # ── Resultados finales ─────────────────────────────────────────────────
    total_time_h = (time.time() - start_time) / 3600

    logger.info("=" * 65)
    logger.info("  ENTRENAMIENTO COMPLETADO")
    logger.info(f"  Tiempo total         : {total_time_h:.2f} horas")
    logger.info(f"  Mejor Dice (val)     : {best_metric:.4f}  ({best_metric*100:.2f}%)")
    logger.info(f"  Mejor época          : {best_metric_epoch} / {NUM_EPOCHS}")
    logger.info("=" * 65)

    # Copiar best_model.pt → model.pt (el nombre que espera la API de producción)
    import shutil
    final_path = OUTPUT_DIR / "model.pt"
    shutil.copy(OUTPUT_DIR / "best_model.pt", final_path)
    logger.info(f"Modelo final: {final_path}")

    # Subir a GCS
    upload_to_gcs(final_path, GCS_MODEL_PATH, logger)

    # ── Imprimir resultado limpio en consola ────────────────────────────────
    print("\n" + "=" * 65)
    print("  RESULTADO FINAL DEL ENTRENAMIENTO")
    print("=" * 65)
    print(f"  Dice Score de Validación : {best_metric:.4f}  ({best_metric*100:.2f}%)")
    print(f"  Mejor época              : {best_metric_epoch} de {NUM_EPOCHS}")
    print(f"  Tiempo total             : {total_time_h:.2f} horas")
    print(f"  Modelo guardado en       : {GCS_MODEL_PATH}")
    print("=" * 65)


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Entrena SegResNet para segmentación de tumores pulmonares (Task06_Lung)"
    )
    parser.add_argument(
        "--dataset_dir",
        type=str,
        default=str(DEFAULT_DATASET_DIR),
        help=f"Ruta al directorio Task06_Lung (default: {DEFAULT_DATASET_DIR})",
    )
    args = parser.parse_args()

    dataset_path = Path(args.dataset_dir)
    if not dataset_path.exists():
        print(f"ERROR: dataset_dir no existe: {dataset_path}")
        sys.exit(1)

    train(dataset_path)
