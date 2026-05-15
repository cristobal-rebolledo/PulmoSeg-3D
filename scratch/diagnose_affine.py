import numpy as np
import SimpleITK as sitk
from monai.transforms import (
    Compose, LoadImaged, EnsureChannelFirstd,
    Orientationd, Spacingd, ScaleIntensityRanged, EnsureTyped
)

nifti   = "/app/local_storage/inputs/Task09_Spleen/Task09_Spleen/imagesTr/spleen_56.nii.gz"
label_p = "/app/local_storage/inputs/Task09_Spleen/Task09_Spleen/labelsTr/spleen_56.nii.gz"

transforms = Compose([
    LoadImaged(keys=["image"]),
    EnsureChannelFirstd(keys=["image"]),
    Orientationd(keys=["image"], axcodes="RAS"),
    Spacingd(keys=["image"], pixdim=(1.5, 1.5, 2.0), mode="bilinear"),
    ScaleIntensityRanged(keys=["image"], a_min=-57.0, a_max=164.0,
                         b_min=0.0, b_max=1.0, clip=True),
    EnsureTyped(keys=["image"]),
])

data   = transforms({"image": nifti})
tensor = data["image"]
affine = tensor.meta.get("affine").numpy()

print("SHAPE:", list(tensor.shape))
print("AFFINE_RAS:")
print(np.round(affine, 3))

col_norms = np.linalg.norm(affine[:3, :3], axis=0)
print("SPACING_xyz:", np.round(col_norms, 4))
origin_ras = affine[:3, 3]
print("ORIGIN_ras:", np.round(origin_ras, 2))
flip = np.diag([-1., -1., 1.])
print("ORIGIN_lps:", np.round(flip @ origin_ras, 2))

ref = sitk.ReadImage(nifti)
print("REF_SIZE:", ref.GetSize())
print("REF_SPACING:", [round(s, 4) for s in ref.GetSpacing()])
print("REF_ORIGIN:", [round(o, 2) for o in ref.GetOrigin()])
print("REF_DIR:", [round(d, 2) for d in ref.GetDirection()])

gt  = sitk.ReadImage(label_p)
arr = sitk.GetArrayFromImage(gt)
nz  = np.argwhere(arr > 0)
print("GT_Z:", nz[:, 0].min(), nz[:, 0].max(), "ctr", round(float(nz[:, 0].mean()), 1))
print("GT_Y:", nz[:, 1].min(), nz[:, 1].max(), "ctr", round(float(nz[:, 1].mean()), 1))
print("GT_X:", nz[:, 2].min(), nz[:, 2].max(), "ctr", round(float(nz[:, 2].mean()), 1))
