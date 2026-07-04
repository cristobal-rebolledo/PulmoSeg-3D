import torch

ckpt = torch.load(r"D:\Semestre 11\Desarrollo Proyecto de Título\Proyecto\PulmoSeg-3D\local_storage\models\lung_tumor_segresnet_v1\model.pt", map_location='cpu')

if isinstance(ckpt, dict) and "state_dict" in ckpt:
    sd = ckpt["state_dict"]
elif isinstance(ckpt, dict) and "model" in ckpt:
    sd = ckpt["model"]
else:
    sd = ckpt

print("Keys:", list(sd.keys())[:10])
