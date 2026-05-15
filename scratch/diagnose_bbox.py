"""
Localiza los bounding boxes de la predicción y el GT para entender el offset.
"""
import SimpleITK as sitk
import numpy as np
from pathlib import Path

pred_path = Path("local_storage/outputs/0a835241-91f4-47ac-88a8-f33c9bbb3bf5/mask.nii.gz")
gt_path   = Path("local_storage/inputs/Task09_Spleen/Task09_Spleen/labelsTr/spleen_56.nii.gz")

pred_img = sitk.ReadImage(str(pred_path))
gt_img   = sitk.ReadImage(str(gt_path))

pred_arr = sitk.GetArrayFromImage(pred_img)  # shape: (Z, Y, X)
gt_arr   = sitk.GetArrayFromImage(gt_img)

print("=" * 60)
print("  BOUNDING BOX DE CADA MÁSCARA")
print("=" * 60)

for label, arr in [("PREDICCION", pred_arr), ("GT", gt_arr)]:
    nz = np.argwhere(arr > 0)  # [[z, y, x], ...]
    if len(nz) == 0:
        print(f"\n  {label}: VACÍO")
        continue
    z_min, z_max = nz[:, 0].min(), nz[:, 0].max()
    y_min, y_max = nz[:, 1].min(), nz[:, 1].max()
    x_min, x_max = nz[:, 2].min(), nz[:, 2].max()
    print(f"\n  {label}:")
    print(f"    Z (slices)  : [{z_min}, {z_max}]  →  {z_max - z_min + 1} slices")
    print(f"    Y (filas)   : [{y_min}, {y_max}]")
    print(f"    X (columnas): [{x_min}, {x_max}]")
    print(f"    Centro Z    : {(z_min + z_max) / 2:.1f}")
    print(f"    Centro Y    : {(y_min + y_max) / 2:.1f}")
    print(f"    Centro X    : {(x_min + x_max) / 2:.1f}")

print()
print("=" * 60)
print("  DISTRIBUCIÓN POR SLICE (slices con vóxeles > 0)")
print("=" * 60)
print(f"\n  {'Slice':>6} | {'GT':>8} | {'PRED':>8} | {'Intersec':>8}")
print(f"  {'─'*40}")
for z in range(pred_arr.shape[0]):
    gt_z   = (gt_arr[z] > 0).sum()
    pred_z = (pred_arr[z] > 0).sum()
    inter  = np.logical_and(pred_arr[z] > 0, gt_arr[z] > 0).sum()
    if gt_z > 0 or pred_z > 0:
        marker = " ← PRED activo" if pred_z > 0 and gt_z == 0 else ""
        marker = " ✅" if inter > 0 else marker
        print(f"  {z:>6} | {gt_z:>8,} | {pred_z:>8,} | {inter:>8,}{marker}")
