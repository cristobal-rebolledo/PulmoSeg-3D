"""Bounding box del job nuevo (con fix) vs GT."""
import SimpleITK as sitk
import numpy as np
from pathlib import Path

NEW = Path("local_storage/outputs/f688232e-61fa-452c-8f49-1531080afab4/mask.nii.gz")
GT  = Path("local_storage/inputs/Task09_Spleen/Task09_Spleen/labelsTr/spleen_56.nii.gz")

for label, path in [("PREDICCION (con fix)", NEW), ("GT", GT)]:
    img = sitk.ReadImage(str(path))
    arr = sitk.GetArrayFromImage(img)
    nz  = np.argwhere(arr > 0)
    if len(nz) == 0:
        print(f"{label}: VACÍO"); continue
    print(f"\n{label}:")
    print(f"  Z  [{nz[:,0].min()}, {nz[:,0].max()}]  centro={nz[:,0].mean():.1f}")
    print(f"  Y  [{nz[:,1].min()}, {nz[:,1].max()}]  centro={nz[:,1].mean():.1f}")
    print(f"  X  [{nz[:,2].min()}, {nz[:,2].max()}]  centro={nz[:,2].mean():.1f}")
    print(f"  Vóxeles: {(arr>0).sum():,}")

# Overlap
pred_img = sitk.ReadImage(str(NEW))
gt_img   = sitk.ReadImage(str(GT))
pred_arr = sitk.GetArrayFromImage(pred_img)
gt_arr   = sitk.GetArrayFromImage(gt_img)
inter = np.logical_and(pred_arr > 0, gt_arr > 0).sum()
union = np.logical_or(pred_arr > 0, gt_arr > 0).sum()
dice  = 2 * inter / (pred_arr.sum() + gt_arr.sum())
print(f"\nIntersección: {inter:,}")
print(f"Dice directo : {dice:.4f}")
