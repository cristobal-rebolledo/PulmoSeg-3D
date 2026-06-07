#!/bin/bash
# =============================================================================
# setup_vm.sh — Configura el entorno de la VM para entrenar SegResNet
# =============================================================================
# Uso (ejecutar como usuario normal con sudo):
#   chmod +x setup_vm.sh
#   ./setup_vm.sh
#
# Lo que hace este script:
#   1. Instala los drivers NVIDIA + CUDA si no están presentes
#   2. Instala Python 3.10 y pip
#   3. Instala PyTorch 2.2 con soporte CUDA 11.8
#   4. Instala MONAI y sus dependencias médicas
#   5. Descarga el dataset Task06_Lung desde GCS
#   6. Crea la estructura de directorios de salida
# =============================================================================

set -e  # Salir si cualquier comando falla

echo "============================================================"
echo "  PulmoSeg 3D — Configuración de VM para Entrenamiento"
echo "============================================================"

# --- Variables de Entorno ---
GCS_DATASET="gs://pulmoseg-models/datasets/Task06_Lung"
LOCAL_DATASET="/home/datasets/Task06_Lung"
OUTPUT_DIR="/home/training_output/lung_tumor_segresnet_v1"
PYTHON_BIN="python3"

# ── Paso 1: Verificar GPU ──────────────────────────────────────────────────
echo ""
echo "[1/6] Verificando GPU NVIDIA..."
if command -v nvidia-smi &> /dev/null; then
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
    echo "  ✅ GPU detectada"
else
    echo "  ⚠️  nvidia-smi no encontrado. Instalando drivers NVIDIA..."
    sudo apt-get update -qq
    sudo apt-get install -y linux-headers-$(uname -r)
    # Instalar CUDA 11.8 runtime
    wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2004/x86_64/cuda-keyring_1.0-1_all.deb
    sudo dpkg -i cuda-keyring_1.0-1_all.deb
    sudo apt-get update -qq
    sudo apt-get install -y cuda-11-8
    echo "  ✅ CUDA instalado. Reinicia la VM si es necesario."
fi

# ── Paso 2: Python y pip ───────────────────────────────────────────────────
echo ""
echo "[2/6] Verificando Python..."
$PYTHON_BIN --version
pip3 --version
echo "  ✅ Python y pip listos"

# ── Paso 3: PyTorch con CUDA ───────────────────────────────────────────────
echo ""
echo "[3/6] Instalando PyTorch 2.2 + CUDA 11.8..."
pip3 install torch==2.2.0 torchvision==0.17.0 --index-url https://download.pytorch.org/whl/cu118 --quiet
echo "  ✅ PyTorch instalado"

# Verificar CUDA disponible
$PYTHON_BIN -c "
import torch
print(f'  PyTorch: {torch.__version__}')
print(f'  CUDA disponible: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'  GPU: {torch.cuda.get_device_name(0)}')
    print(f'  VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB')
"

# ── Paso 4: MONAI y dependencias médicas ──────────────────────────────────
echo ""
echo "[4/6] Instalando MONAI y dependencias..."
pip3 install \
    "monai[all]>=1.3.0" \
    nibabel \
    SimpleITK \
    scikit-image \
    matplotlib \
    tqdm \
    --quiet
echo "  ✅ MONAI instalado"

# Verificar MONAI
$PYTHON_BIN -c "import monai; print(f'  MONAI: {monai.__version__}')"

# ── Paso 5: Descargar dataset desde GCS ───────────────────────────────────
echo ""
echo "[5/6] Descargando dataset Task06_Lung desde GCS..."
mkdir -p /home/datasets

if [ -d "$LOCAL_DATASET" ] && [ "$(ls -A $LOCAL_DATASET)" ]; then
    echo "  ℹ️  Dataset ya existe en $LOCAL_DATASET — omitiendo descarga"
else
    echo "  Descargando desde $GCS_DATASET ..."
    gsutil -m cp -r "$GCS_DATASET" /home/datasets/
    echo "  ✅ Dataset descargado"
fi

# Verificar estructura del dataset
echo "  Verificando estructura del dataset:"
echo "    imagesTr: $(ls $LOCAL_DATASET/imagesTr/*.nii.gz 2>/dev/null | wc -l) archivos"
echo "    labelsTr: $(ls $LOCAL_DATASET/labelsTr/*.nii.gz 2>/dev/null | wc -l) archivos"

# ── Paso 6: Crear directorios de salida ───────────────────────────────────
echo ""
echo "[6/6] Creando directorios de salida..."
mkdir -p "$OUTPUT_DIR"
echo "  ✅ Directorio de modelos: $OUTPUT_DIR"

# ── Resumen Final ──────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  ✅ VM lista para entrenar"
echo ""
echo "  Para iniciar el entrenamiento:"
echo ""
echo "  python3 training/train_lung_tumor_segresnet.py \\"
echo "    --dataset_dir $LOCAL_DATASET"
echo ""
echo "  Para ver el progreso en tiempo real:"
echo "  tail -f $OUTPUT_DIR/training.log"
echo "============================================================"
