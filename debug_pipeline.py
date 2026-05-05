"""
debug_pipeline.py — Script de diagnóstico rápido para PulmoSeg 3D.

Ejecutar desde la raíz del proyecto:
    python debug_pipeline.py

Verifica:
  1. Si el archivo de pesos del modelo existe (causa principal de resultados mock).
  2. Qué pacientes/estudios hay disponibles en local_storage/inputs/dicom/.
  3. Si los archivos DICOM son válidos (conteo y tamaño).
  4. Muestra la ruta exacta que usaría el worker para un request dado.
"""

import sys
from pathlib import Path

# Asegurar que el proyecto esté en el path de Python
sys.path.insert(0, str(Path(__file__).parent))

# ─────────────────────────────────────────────────────────────────
print("\n" + "═" * 60)
print("  PulmoSeg 3D — Diagnóstico del Pipeline de Inferencia")
print("═" * 60)

# ─────────────────────────────────────────────────────────────────
# 1. Verificar pesos del modelo
# ─────────────────────────────────────────────────────────────────
print("\n📦 [1/4] Verificando pesos del modelo...")
try:
    from worker.model_config import get_active_config
    config = get_active_config()
    print(f"   Modelo activo  : {config.name}")
    print(f"   Ruta de pesos  : {config.weights_path}")

    if config.weights_path.exists():
        size_mb = config.weights_path.stat().st_size / (1024 * 1024)
        print(f"   ✅ Archivo ENCONTRADO ({size_mb:.1f} MB)")
        print("   → La inferencia REAL debería ejecutarse.")
    else:
        print(f"   ❌ Archivo NO ENCONTRADO")
        print(f"   → El pipeline usará resultados MOCK en cada ejecución.")
        print(f"   → ÉSTA ES LA CAUSA MÁS PROBABLE DE TUS RESULTADOS IDÉNTICOS.")
        print(f"\n   Para solucionar: Descarga el bundle MONAI y coloca model.pt en:")
        print(f"   {config.weights_path}")
        print(f"\n   Comando de descarga:")
        print(f'   python -c "import monai; monai.bundle.load(\\"spleen_ct_segmentation\\", bundle_dir=\\"local_storage/models\\")"')
except ImportError as e:
    print(f"   ⚠️  No se pudo importar model_config: {e}")

# ─────────────────────────────────────────────────────────────────
# 2. Inventario de DICOMs en local_storage
# ─────────────────────────────────────────────────────────────────
print("\n📁 [2/4] Inventario de archivos DICOM disponibles...")
dicom_base = Path("local_storage/inputs/dicom")
if not dicom_base.exists():
    print(f"   ❌ El directorio base no existe: {dicom_base}")
else:
    patients = [d for d in dicom_base.iterdir() if d.is_dir()]
    if not patients:
        print("   ⚠️  No hay pacientes en local_storage/inputs/dicom/")
    else:
        for patient_dir in patients:
            studies = [d for d in patient_dir.iterdir() if d.is_dir()]
            for study_dir in studies:
                all_dcm = list(study_dir.rglob("*.dcm"))
                size_mb = sum(f.stat().st_size for f in all_dcm) / (1024 * 1024)
                print(f"\n   Paciente : {patient_dir.name}")
                print(f"   Estudio  : {study_dir.name}")
                print(f"   DICOMs   : {len(all_dcm)} archivos ({size_mb:.1f} MB total)")

                # Subdirectorios (series)
                subdirs = [d for d in study_dir.iterdir() if d.is_dir()]
                for sub in subdirs:
                    sub_dcm = list(sub.glob("*.dcm"))
                    print(f"   Serie    : {sub.name} ({len(sub_dcm)} archivos)")

# ─────────────────────────────────────────────────────────────────
# 3. Simular resolución de ruta del worker
# ─────────────────────────────────────────────────────────────────
print("\n🔍 [3/4] Simulando resolución de ruta del worker...")
print("   (Usar los mismos valores que se ingresan en la interfaz)")

# Ajustar estos valores según tu prueba:
TEST_PATIENT_ID  = "LIDC-IDRI-0001"
TEST_STUDY_UID   = "1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192"
TEST_SERIES_UID  = None   # Dejar None si no se especificó en la UI

print(f"   patient_pseudo_id  = {TEST_PATIENT_ID}")
print(f"   study_instance_uid = {TEST_STUDY_UID}")
print(f"   series_instance_uid= {TEST_SERIES_UID or '(no especificado)'}")

study_path = Path("local_storage") / "inputs" / "dicom" / TEST_PATIENT_ID / TEST_STUDY_UID
print(f"\n   Ruta del estudio : {study_path}")
print(f"   Existe           : {study_path.exists()}")

if study_path.exists():
    # Intentar estrategia 1: ruta con series UID
    if TEST_SERIES_UID:
        series_path = study_path / TEST_SERIES_UID
        dcm_in_series = list(series_path.glob("*.dcm")) if series_path.exists() else []
        if dcm_in_series:
            print(f"   ✅ Estrategia 1 OK: {series_path} ({len(dcm_in_series)} DICOMs)")
        else:
            print(f"   ⚠️  Estrategia 1 falló: {series_path} no existe o sin .dcm")

    # Estrategia 2: búsqueda recursiva
    all_dcm = list(study_path.rglob("*.dcm"))
    if all_dcm:
        dirs: dict = {}
        for f in all_dcm:
            dirs[f.parent] = dirs.get(f.parent, 0) + 1
        best_dir = max(dirs, key=dirs.__getitem__)
        print(f"   ✅ Estrategia 2 OK: {best_dir} ({dirs[best_dir]} DICOMs)")
        print(f"   → El worker procesará ESTE directorio.")
    else:
        print(f"   ❌ No se encontraron .dcm en el estudio.")

# ─────────────────────────────────────────────────────────────────
# 4. Verificar MONAI disponible
# ─────────────────────────────────────────────────────────────────
print("\n🧠 [4/4] Verificando disponibilidad de MONAI y PyTorch...")
try:
    import torch
    import monai
    print(f"   ✅ PyTorch: {torch.__version__}")
    print(f"   ✅ MONAI  : {monai.__version__}")
    print(f"   ✅ CUDA disponible: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"   ✅ GPU: {torch.cuda.get_device_name(0)}")
    else:
        print("   ℹ️  Ejecutando en CPU (inferencia será lenta ~60-120s)")
except ImportError as e:
    print(f"   ❌ MONAI/PyTorch no disponibles: {e}")
    print("   → El pipeline usará resultados MOCK.")

# ─────────────────────────────────────────────────────────────────
print("\n" + "═" * 60)
print("  Diagnóstico completo.")
print("═" * 60 + "\n")
