#!/usr/bin/env python3
"""
evaluate_segmentation.py — Evaluación cuantitativa del pipeline PulmoSeg-3D.

Calcula métricas estándar de segmentación comparando la máscara predicha
por el modelo contra el ground truth del dataset Task09_Spleen (MSD).

Métricas calculadas:
  - Dice Score (DSC): métrica principal, rango [0, 1], 1 = perfecto
  - IoU / Jaccard Index: superposición relativa
  - Sensitivity (Recall): fracción de bazo real que el modelo detectó
  - Specificity: fracción de fondo que el modelo clasificó correctamente
  - Precision: fracción de la predicción que es bazo real
  - Hausdorff Distance 95%: error máximo de borde (percentil 95), en mm
  - Volume Similarity: diferencia relativa de volumen

Uso:
  python evaluate_segmentation.py
  python evaluate_segmentation.py --case spleen_10
  python evaluate_segmentation.py --job-id <uuid>
  python evaluate_segmentation.py --all   # evalúa todos los casos disponibles
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import SimpleITK as sitk

# ─────────────────────────────────────────────────────────────────────────────
# Configuración de rutas
# ─────────────────────────────────────────────────────────────────────────────
PROJECT_ROOT  = Path(__file__).parent
DATASET_IMGS  = PROJECT_ROOT / "local_storage" / "inputs" / "Task09_Spleen" / "Task09_Spleen" / "imagesTr"
DATASET_LBLS  = PROJECT_ROOT / "local_storage" / "inputs" / "Task09_Spleen" / "Task09_Spleen" / "labelsTr"
OUTPUTS_BASE  = PROJECT_ROOT / "local_storage" / "outputs"

# Job de validación más reciente con NIfTI (spleen_56)
DEFAULT_JOB_ID   = "0a835241-91f4-47ac-88a8-f33c9bbb3bf5"
DEFAULT_CASE     = "spleen_56"


# ─────────────────────────────────────────────────────────────────────────────
# Funciones de métricas
# ─────────────────────────────────────────────────────────────────────────────

def compute_dice(pred: np.ndarray, gt: np.ndarray) -> float:
    """Dice Similarity Coefficient (F1 de segmentación)."""
    pred_b = (pred > 0).astype(bool)
    gt_b   = (gt   > 0).astype(bool)
    intersection = np.logical_and(pred_b, gt_b).sum()
    total = pred_b.sum() + gt_b.sum()
    if total == 0:
        return 1.0  # ambos vacíos → coincidencia perfecta
    return 2.0 * intersection / total


def compute_iou(pred: np.ndarray, gt: np.ndarray) -> float:
    """Intersection over Union (Jaccard Index)."""
    pred_b = (pred > 0).astype(bool)
    gt_b   = (gt   > 0).astype(bool)
    inter  = np.logical_and(pred_b, gt_b).sum()
    union  = np.logical_or(pred_b,  gt_b).sum()
    return inter / union if union > 0 else 1.0


def compute_sensitivity(pred: np.ndarray, gt: np.ndarray) -> float:
    """Sensibilidad / Recall: TP / (TP + FN)."""
    pred_b = (pred > 0).astype(bool)
    gt_b   = (gt   > 0).astype(bool)
    tp = np.logical_and(pred_b,  gt_b).sum()
    fn = np.logical_and(~pred_b, gt_b).sum()
    return tp / (tp + fn) if (tp + fn) > 0 else 1.0


def compute_specificity(pred: np.ndarray, gt: np.ndarray) -> float:
    """Especificidad: TN / (TN + FP)."""
    pred_b = (pred > 0).astype(bool)
    gt_b   = (gt   > 0).astype(bool)
    tn = np.logical_and(~pred_b, ~gt_b).sum()
    fp = np.logical_and(pred_b,  ~gt_b).sum()
    return tn / (tn + fp) if (tn + fp) > 0 else 1.0


def compute_precision(pred: np.ndarray, gt: np.ndarray) -> float:
    """Precisión: TP / (TP + FP)."""
    pred_b = (pred > 0).astype(bool)
    gt_b   = (gt   > 0).astype(bool)
    tp = np.logical_and(pred_b,  gt_b).sum()
    fp = np.logical_and(pred_b, ~gt_b).sum()
    return tp / (tp + fp) if (tp + fp) > 0 else 1.0


def compute_volume_similarity(pred: np.ndarray, gt: np.ndarray) -> float:
    """
    Volume Similarity = 1 - |V_pred - V_gt| / (V_pred + V_gt).
    Rango [0, 1], 1 = volúmenes idénticos.
    """
    v_pred = (pred > 0).sum()
    v_gt   = (gt   > 0).sum()
    total  = v_pred + v_gt
    if total == 0:
        return 1.0
    return 1.0 - abs(v_pred - v_gt) / total


def compute_hausdorff_95(pred_img: sitk.Image, gt_img: sitk.Image) -> float:
    """
    Hausdorff Distance al percentil 95 (HD95), en mm.
    Usa SimpleITK HausdorffDistanceImageFilter, que es robusto a outliers.
    Retorna NaN si alguna máscara está vacía.
    """
    pred_arr = sitk.GetArrayFromImage(pred_img)
    gt_arr   = sitk.GetArrayFromImage(gt_img)

    if pred_arr.sum() == 0 or gt_arr.sum() == 0:
        print("    ⚠️  HD95 no calculable: una máscara está vacía.")
        return float("nan")

    try:
        hd_filter = sitk.HausdorffDistanceImageFilter()
        hd_filter.Execute(
            sitk.Cast(pred_img > 0, sitk.sitkUInt8),
            sitk.Cast(gt_img   > 0, sitk.sitkUInt8),
        )
        # SimpleITK calcula HD máximo; estimamos HD95 con distancias de superficie
        # Usamos el mapa de distancias para el percentil 95
        dist_pred_to_gt = sitk.GetArrayFromImage(
            sitk.SignedMaurerDistanceMap(sitk.Cast(gt_img > 0, sitk.sitkUInt8),
                                        squaredDistance=False, useImageSpacing=True)
        )
        dist_gt_to_pred = sitk.GetArrayFromImage(
            sitk.SignedMaurerDistanceMap(sitk.Cast(pred_img > 0, sitk.sitkUInt8),
                                        squaredDistance=False, useImageSpacing=True)
        )

        pred_surface = (pred_arr > 0)
        gt_surface   = (gt_arr   > 0)

        d1 = np.abs(dist_pred_to_gt[pred_surface])
        d2 = np.abs(dist_gt_to_pred[gt_surface])

        all_distances = np.concatenate([d1, d2])
        return float(np.percentile(all_distances, 95))

    except Exception as e:
        print(f"    ⚠️  HD95 no calculable: {e}")
        return float("nan")


def compute_volumes_ml(pred: np.ndarray, gt: np.ndarray, spacing_mm: tuple) -> tuple:
    """Calcula volumen en mL a partir del conteo de vóxeles y el spacing."""
    voxel_vol_mm3 = spacing_mm[0] * spacing_mm[1] * spacing_mm[2]
    voxel_vol_ml  = voxel_vol_mm3 / 1000.0
    vol_pred = (pred > 0).sum() * voxel_vol_ml
    vol_gt   = (gt   > 0).sum() * voxel_vol_ml
    return vol_pred, vol_gt


# ─────────────────────────────────────────────────────────────────────────────
# Función principal de evaluación de un caso
# ─────────────────────────────────────────────────────────────────────────────

def evaluate_case(case_name: str, job_id: str) -> dict | None:
    """
    Evalúa un caso: compara mask.nii.gz del pipeline contra el ground truth.

    Args:
        case_name: Nombre del caso, ej. 'spleen_56'
        job_id:    UUID del job que generó la máscara predicha

    Returns:
        dict con todas las métricas, o None si faltan archivos.
    """
    print(f"\n{'─' * 60}")
    print(f"  Caso     : {case_name}")
    print(f"  Job ID   : {job_id[:8]}...")
    print(f"{'─' * 60}")

    # Rutas
    pred_path = OUTPUTS_BASE / job_id / "mask.nii.gz"
    gt_path   = DATASET_LBLS / f"{case_name}.nii.gz"
    vol_path  = OUTPUTS_BASE / job_id / "volume.nii.gz"

    # Verificar existencia
    for label, path in [("Predicción (mask)", pred_path), ("Ground Truth", gt_path)]:
        if not path.exists():
            print(f"  ❌ {label} no encontrado: {path}")
            return None
        size_mb = path.stat().st_size / (1024 * 1024)
        print(f"  ✅ {label}: {path.name}  ({size_mb:.1f} MB)")

    # Cargar imágenes
    print("\n  Cargando imágenes...")
    pred_img = sitk.ReadImage(str(pred_path))
    gt_img   = sitk.ReadImage(str(gt_path))

    print(f"  Predicción — size: {pred_img.GetSize()}, spacing: {[f'{s:.3f}' for s in pred_img.GetSpacing()]}")
    print(f"  Ground truth — size: {gt_img.GetSize()}, spacing: {[f'{s:.3f}' for s in gt_img.GetSpacing()]}")

    # Resamplear ground truth al espacio de la predicción (si difieren)
    # La predicción ya fue resampleada al espacio original del volumen por postprocess.py
    pred_size = pred_img.GetSize()
    gt_size   = gt_img.GetSize()

    if pred_size != gt_size or pred_img.GetSpacing() != gt_img.GetSpacing():
        print("\n  ⚠️  Tamaños distintos — resampleando GT al espacio de la predicción...")
        resampler = sitk.ResampleImageFilter()
        resampler.SetReferenceImage(pred_img)
        resampler.SetInterpolator(sitk.sitkNearestNeighbor)
        resampler.SetDefaultPixelValue(0)
        gt_img = resampler.Execute(gt_img)
        print(f"  GT resampleado — nuevo size: {gt_img.GetSize()}")

    # Convertir a arrays NumPy
    pred_arr = sitk.GetArrayFromImage(pred_img).astype(np.uint8)
    gt_arr   = sitk.GetArrayFromImage(gt_img).astype(np.uint8)

    spacing = pred_img.GetSpacing()  # (x, y, z) en mm

    # ── Calcular métricas ────────────────────────────────────────────────────
    print("\n  Calculando métricas...")
    dice        = compute_dice(pred_arr, gt_arr)
    iou         = compute_iou(pred_arr, gt_arr)
    sensitivity = compute_sensitivity(pred_arr, gt_arr)
    specificity = compute_specificity(pred_arr, gt_arr)
    precision   = compute_precision(pred_arr, gt_arr)
    vol_sim     = compute_volume_similarity(pred_arr, gt_arr)

    print("  Calculando HD95 (puede tardar 5-10 s)...")
    hd95 = compute_hausdorff_95(pred_img, gt_img)

    vol_pred_ml, vol_gt_ml = compute_volumes_ml(
        pred_arr, gt_arr, (spacing[2], spacing[1], spacing[0])  # z, y, x
    )
    vol_error_pct = abs(vol_pred_ml - vol_gt_ml) / vol_gt_ml * 100 if vol_gt_ml > 0 else 0

    # ── Imprimir resultados ──────────────────────────────────────────────────
    print(f"\n  {'═' * 50}")
    print(f"  {'RESULTADOS DE EVALUACIÓN':^50}")
    print(f"  {'═' * 50}")
    print(f"  {'Métrica':<30} {'Valor':>12}  {'Referencia'}")
    print(f"  {'─' * 56}")
    print(f"  {'Dice Score (DSC)':<30} {dice:>11.4f}  [≥0.94 = excelente]")
    print(f"  {'IoU / Jaccard':<30} {iou:>11.4f}  [≥0.88 = excelente]")
    print(f"  {'Sensitivity (Recall)':<30} {sensitivity:>11.4f}  [≥0.93 = bueno]")
    print(f"  {'Precision':<30} {precision:>11.4f}  [≥0.93 = bueno]")
    print(f"  {'Specificity':<30} {specificity:>11.4f}  [≥0.999 = normal]")
    print(f"  {'Volume Similarity':<30} {vol_sim:>11.4f}  [≥0.95 = bueno]")
    if not np.isnan(hd95):
        print(f"  {'HD95 (mm)':<30} {hd95:>11.2f}  [≤5mm = excelente]")
    else:
        print(f"  {'HD95 (mm)':<30} {'N/A':>12}")
    print(f"  {'─' * 56}")
    print(f"  {'Volumen predicho (mL)':<30} {vol_pred_ml:>11.1f}")
    print(f"  {'Volumen ground truth (mL)':<30} {vol_gt_ml:>11.1f}")
    print(f"  {'Error de volumen (%)':<30} {vol_error_pct:>10.1f}%")
    print(f"  {'Vóxeles predichos':<30} {(pred_arr > 0).sum():>12,}")
    print(f"  {'Vóxeles ground truth':<30} {(gt_arr   > 0).sum():>12,}")
    print(f"  {'═' * 50}")

    # ── Interpretación ───────────────────────────────────────────────────────
    print(f"\n  📊 INTERPRETACIÓN:")
    if dice >= 0.94:
        print(f"  ✅ Dice={dice:.4f} — Rendimiento EXCELENTE (nivel publicación MICCAI)")
    elif dice >= 0.85:
        print(f"  ✅ Dice={dice:.4f} — Rendimiento BUENO para uso clínico")
    elif dice >= 0.70:
        print(f"  ⚠️  Dice={dice:.4f} — Rendimiento ACEPTABLE, requiere revisión")
    else:
        print(f"  ❌ Dice={dice:.4f} — Rendimiento BAJO, revisar pipeline")

    if sensitivity >= 0.93:
        print(f"  ✅ Sensitivity={sensitivity:.4f} — Detecta bien el tejido real del bazo")
    else:
        print(f"  ⚠️  Sensitivity={sensitivity:.4f} — Sub-segmentando (pierde bazo real)")

    if precision >= 0.93:
        print(f"  ✅ Precision={precision:.4f} — Pocas falsas alarmas")
    else:
        print(f"  ⚠️  Precision={precision:.4f} — Sobre-segmentando (incluye tejido no bazo)")

    return {
        "case":            case_name,
        "job_id":          job_id,
        "dice":            round(dice, 4),
        "iou":             round(iou, 4),
        "sensitivity":     round(sensitivity, 4),
        "specificity":     round(specificity, 4),
        "precision":       round(precision, 4),
        "volume_similarity": round(vol_sim, 4),
        "hd95_mm":         round(hd95, 2) if not np.isnan(hd95) else None,
        "vol_pred_ml":     round(vol_pred_ml, 2),
        "vol_gt_ml":       round(vol_gt_ml, 2),
        "vol_error_pct":   round(vol_error_pct, 1),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Función: evaluar todos los casos disponibles
# ─────────────────────────────────────────────────────────────────────────────

def find_all_evaluable_cases() -> list[tuple[str, str]]:
    """
    Busca todos los jobs en local_storage/outputs que tengan mask.nii.gz
    y cuyo volumen.nii.gz corresponda a un caso con ground truth en labelsTr.
    Retorna lista de (case_name, job_id).
    """
    cases = []
    for job_dir in OUTPUTS_BASE.iterdir():
        if not job_dir.is_dir():
            continue
        mask_path  = job_dir / "mask.nii.gz"
        vol_path   = job_dir / "volume.nii.gz"
        if not mask_path.exists() or not vol_path.exists():
            continue

        # Intentar deducir el case_name desde el volumen (mismo nombre que imagesTr)
        # Buscamos si hay algún label cuyo nombre coincida
        for lbl_file in DATASET_LBLS.glob("spleen_*.nii.gz"):
            if lbl_file.name.startswith("._"):
                continue
            img_file = DATASET_IMGS / lbl_file.name
            if not img_file.exists():
                continue
            # El volume.nii.gz del job debería tener el mismo tamaño que imagesTr
            # Comparamos dimensiones
            try:
                vol_img = sitk.ReadImage(str(vol_path))
                src_img = sitk.ReadImage(str(img_file))
                if vol_img.GetSize() == src_img.GetSize():
                    cases.append((lbl_file.stem.replace(".nii", ""), str(job_dir.name)))
                    break
            except Exception:
                continue
    return cases


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Evaluación cuantitativa del pipeline PulmoSeg-3D (Task09_Spleen)"
    )
    parser.add_argument("--case",   default=DEFAULT_CASE,   help=f"Caso a evaluar (default: {DEFAULT_CASE})")
    parser.add_argument("--job-id", default=DEFAULT_JOB_ID, help="UUID del job con la máscara predicha")
    parser.add_argument("--all",    action="store_true",    help="Evaluar todos los casos disponibles automáticamente")
    args = parser.parse_args()

    print("\n" + "═" * 62)
    print("  PulmoSeg-3D — Evaluación Cuantitativa de Segmentación")
    print("  Dataset: Task09_Spleen (Medical Segmentation Decathlon)")
    print("═" * 62)

    if args.all:
        print("\n🔍 Buscando todos los casos evaluables...")
        cases = find_all_evaluable_cases()
        if not cases:
            print("  ❌ No se encontraron casos evaluables.")
            print("     Ejecuta primero: python validate_nifti.py")
            sys.exit(1)
        print(f"  Encontrados: {len(cases)} caso(s)")
        results = []
        for case_name, job_id in cases:
            r = evaluate_case(case_name, job_id)
            if r:
                results.append(r)

        if results:
            print(f"\n\n{'═' * 62}")
            print(f"  RESUMEN — {len(results)} caso(s) evaluados")
            print(f"{'═' * 62}")
            print(f"  {'Caso':<15} {'Dice':>7} {'IoU':>7} {'Sens':>7} {'Prec':>7} {'HD95':>8} {'VolErr':>8}")
            print(f"  {'─' * 58}")
            for r in results:
                hd = f"{r['hd95_mm']:.1f}" if r['hd95_mm'] else "  N/A"
                print(f"  {r['case']:<15} {r['dice']:>7.4f} {r['iou']:>7.4f} "
                      f"{r['sensitivity']:>7.4f} {r['precision']:>7.4f} "
                      f"{hd:>8} {r['vol_error_pct']:>7.1f}%")
            if len(results) > 1:
                avg_dice = np.mean([r["dice"] for r in results])
                avg_iou  = np.mean([r["iou"]  for r in results])
                print(f"  {'─' * 58}")
                print(f"  {'PROMEDIO':<15} {avg_dice:>7.4f} {avg_iou:>7.4f}")
    else:
        r = evaluate_case(args.case, args.job_id)
        if not r:
            print("\n  💡 Para generar una predicción, ejecuta primero:")
            print("     python validate_nifti.py")
            sys.exit(1)

    print(f"\n{'═' * 62}")
    print("  Evaluación completada.")
    print(f"{'═' * 62}\n")


if __name__ == "__main__":
    main()
