"""
Diagnóstico: Por qué Dice=0 si el volumen es correcto.
Compara origin, direction y spacing de pred vs GT.
"""
import SimpleITK as sitk
import numpy as np
from pathlib import Path

pred_path = Path("local_storage/outputs/0a835241-91f4-47ac-88a8-f33c9bbb3bf5/mask.nii.gz")
gt_path   = Path("local_storage/inputs/Task09_Spleen/Task09_Spleen/labelsTr/spleen_56.nii.gz")
vol_path  = Path("local_storage/outputs/0a835241-91f4-47ac-88a8-f33c9bbb3bf5/volume.nii.gz")
src_path  = Path("local_storage/inputs/Task09_Spleen/Task09_Spleen/imagesTr/spleen_56.nii.gz")

print("=" * 65)
print("  DIAGNÓSTICO ESPACIAL")
print("=" * 65)

for label, path in [("PREDICCION (mask)", pred_path), ("GT (label)", gt_path),
                    ("VOLUME (input pipeline)", vol_path), ("SOURCE (original NIfTI)", src_path)]:
    img = sitk.ReadImage(str(path))
    arr = sitk.GetArrayFromImage(img)
    print(f"\n  [{label}]")
    print(f"    Size      : {img.GetSize()}")
    print(f"    Spacing   : {[round(s,4) for s in img.GetSpacing()]}")
    print(f"    Origin    : {[round(o,2) for o in img.GetOrigin()]}")
    print(f"    Direction : {[round(d,3) for d in img.GetDirection()]}")
    print(f"    PixelType : {img.GetPixelIDTypeAsString()}")
    print(f"    Vóxeles>0 : {(arr>0).sum():,}")
    print(f"    Min/Max   : {arr.min()} / {arr.max()}")

# ¿Están en el mismo espacio?
pred_img = sitk.ReadImage(str(pred_path))
gt_img   = sitk.ReadImage(str(gt_path))
vol_img  = sitk.ReadImage(str(vol_path))
src_img  = sitk.ReadImage(str(src_path))

print("\n\n" + "=" * 65)
print("  COMPARACIÓN DE ESPACIOS")
print("=" * 65)
print(f"\n  Origin PRED vs GT:")
print(f"    PRED  : {[round(o,2) for o in pred_img.GetOrigin()]}")
print(f"    GT    : {[round(o,2) for o in gt_img.GetOrigin()]}")
print(f"    SOURCE: {[round(o,2) for o in src_img.GetOrigin()]}")
same_origin = pred_img.GetOrigin() == gt_img.GetOrigin()
print(f"    Iguales: {'✅' if same_origin else '❌ MISMATCH!'}")

print(f"\n  Direction PRED vs GT:")
pred_dir = [round(d,3) for d in pred_img.GetDirection()]
gt_dir   = [round(d,3) for d in gt_img.GetDirection()]
print(f"    PRED: {pred_dir}")
print(f"    GT  : {gt_dir}")
same_dir = pred_img.GetDirection() == gt_img.GetDirection()
print(f"    Iguales: {'✅' if same_dir else '❌ MISMATCH!'}")

# Overlap directo (sin resamplear)
pred_arr = sitk.GetArrayFromImage(pred_img)
gt_arr   = sitk.GetArrayFromImage(gt_img)
if pred_arr.shape == gt_arr.shape:
    intersection = np.logical_and(pred_arr > 0, gt_arr > 0).sum()
    union        = np.logical_or(pred_arr > 0, gt_arr > 0).sum()
    dice_raw     = 2 * intersection / (pred_arr.sum() + gt_arr.sum()) if (pred_arr.sum() + gt_arr.sum()) > 0 else 0
    print(f"\n  Overlap directo (sin alinear espacialmente):")
    print(f"    Intersección vóxeles : {intersection:,}")
    print(f"    Dice vóxel-por-vóxel : {dice_raw:.4f}")
    if dice_raw > 0.85:
        print("    ✅ Las máscaras se solapan bien en el array — problema es de metadatos espaciales")
    elif dice_raw > 0.3:
        print("    ⚠️  Solapamiento parcial")
    else:
        print("    ❌ Sin solapamiento — hay un offset real entre las máscaras")
