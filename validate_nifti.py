#!/usr/bin/env python3
"""
validate_nifti.py — Script de validación del pipeline con dataset Task09_Spleen.

Ejecutar desde la raíz del proyecto (con el servidor backend corriendo):
    python validate_nifti.py

Flujo:
  1. Verifica que el servidor FastAPI esté corriendo en localhost:8000.
  2. Selecciona automáticamente el archivo .nii.gz más pequeño disponible
     en Task09_Spleen/imagesTr/ (para agilizar la prueba).
  3. Hace POST /segment-nifti con el archivo seleccionado.
  4. Abre el frontend en el browser (localhost:5173) para ver la segmentación.
  5. Hace polling del estado del job e imprime el progreso en consola.

Requisitos previos:
  - Backend FastAPI corriendo: python -m uvicorn api.main:app --reload
  - Frontend Vite corriendo:   npm run dev (en /frontend)
  - Modelo MONAI descargado:   local_storage/models/spleen_ct_segmentation/models/model.pt
"""

import sys
import time
import webbrowser
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# Configuración
# ─────────────────────────────────────────────────────────────────────────────
API_BASE_URL    = "http://localhost:8000"
FRONTEND_URL    = "http://localhost"  # Puerto 80 en Docker
DATASET_BASE    = Path("local_storage/inputs/Task09_Spleen/Task09_Spleen/imagesTr")
PATIENT_ID      = "Task09-Spleen-Validation"
POLL_INTERVAL   = 5   # segundos entre consultas de estado
POLL_TIMEOUT    = 600  # segundos máximos esperando (10 min)

# ─────────────────────────────────────────────────────────────────────────────
# Asegurar path del proyecto
# ─────────────────────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))

# ─────────────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "═" * 65)
print("  PulmoSeg 3D — Validación de Pipeline con NIfTI (Task09_Spleen)")
print("═" * 65)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Importar requests (requerido)
# ─────────────────────────────────────────────────────────────────────────────
try:
    import requests
except ImportError:
    print("\n❌ La librería 'requests' no está instalada.")
    print("   Instálala con: pip install requests")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Verificar que el servidor esté corriendo
# ─────────────────────────────────────────────────────────────────────────────
print("\n🔌 [1/5] Verificando disponibilidad del servidor...")
try:
    resp = requests.get(f"{API_BASE_URL}/health", timeout=5)
    if resp.status_code == 200:
        print(f"   ✅ Servidor activo: {API_BASE_URL}")
    else:
        print(f"   ⚠️  Servidor responde con HTTP {resp.status_code}")
except requests.exceptions.ConnectionError:
    print(f"\n   ❌ No se puede conectar al servidor en {API_BASE_URL}")
    print("   Asegúrate de que el backend esté corriendo:")
    print("     python -m uvicorn api.main:app --reload --port 8000")
    print("   (ejecuta este comando en otra terminal desde la raíz del proyecto)")
    sys.exit(1)
except requests.exceptions.Timeout:
    print(f"   ❌ Timeout conectando a {API_BASE_URL}. ¿Está el servidor iniciando?")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Seleccionar archivo NIfTI del dataset
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n📂 [2/5] Seleccionando archivo NIfTI del dataset...")
print(f"   Buscando en: {DATASET_BASE}")

if not DATASET_BASE.exists():
    print(f"\n   ❌ Directorio del dataset no encontrado: {DATASET_BASE}")
    print("   Verifica que el dataset Task09_Spleen esté en:")
    print("   local_storage/inputs/Task09_Spleen/Task09_Spleen/imagesTr/")
    sys.exit(1)

# Filtrar archivos reales (no macOS ._* archivos)
nifti_files = sorted(
    [
        f for f in DATASET_BASE.glob("*.nii.gz")
        if not f.name.startswith("._") and f.stat().st_size > 1_000_000  # > 1 MB
    ],
    key=lambda f: f.stat().st_size,
)

if not nifti_files:
    print(f"   ❌ No se encontraron archivos .nii.gz válidos en {DATASET_BASE}")
    sys.exit(1)

# Elegir el más pequeño para la validación (más rápido de procesar)
selected_nifti = nifti_files[0]
size_mb = selected_nifti.stat().st_size / (1024 * 1024)

print(f"\n   📋 Archivos disponibles (ordenados por tamaño):")
for i, f in enumerate(nifti_files[:5]):
    marker = " ← SELECCIONADO" if i == 0 else ""
    size = f.stat().st_size / (1024 * 1024)
    print(f"      [{i+1}] {f.name:30s}  {size:6.1f} MB{marker}")
if len(nifti_files) > 5:
    print(f"      ... y {len(nifti_files) - 5} archivos más")

print(f"\n   ✅ Archivo seleccionado: {selected_nifti.name} ({size_mb:.1f} MB)")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Verificar modelo MONAI
# ─────────────────────────────────────────────────────────────────────────────
print("\n🧠 [3/5] Verificando modelo MONAI...")
try:
    from worker.model_config import get_active_config
    config = get_active_config()
    if config.weights_path.exists():
        model_size_mb = config.weights_path.stat().st_size / (1024 * 1024)
        print(f"   ✅ Pesos del modelo encontrados: {config.weights_path}")
        print(f"      Tamaño: {model_size_mb:.1f} MB | Modelo: {config.name}")
        print("   → La inferencia REAL se ejecutará.")
    else:
        print(f"   ⚠️  Pesos NO encontrados en: {config.weights_path}")
        print("   → El pipeline FALLARÁ. Descarga el modelo primero:")
        print('   python -c "import monai; monai.bundle.load(\\"spleen_ct_segmentation\\", bundle_dir=\\"local_storage/models\\")"')
        resp = input("\n   ¿Continuar de todas formas? (s/N): ").strip().lower()
        if resp != "s":
            print("   Abortando.")
            sys.exit(0)
except Exception as e:
    print(f"   ⚠️  No se pudo verificar el modelo: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# 5. Enviar el NIfTI al endpoint /segment-nifti
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n🚀 [4/5] Enviando NIfTI al pipeline...")
print(f"   Archivo : {selected_nifti.name}")
print(f"   Endpoint: POST {API_BASE_URL}/segment-nifti")
print(f"   (Esto puede tomar unos segundos mientras se sube el archivo...)\n")

job_id = None
try:
    with open(selected_nifti, "rb") as nifti_file:
        response = requests.post(
            f"{API_BASE_URL}/segment-nifti",
            files={"file": (selected_nifti.name, nifti_file, "application/gzip")},
            data={
                "patient_pseudo_id": PATIENT_ID,
                "study_instance_uid": f"validation-{selected_nifti.stem}",
            },
            timeout=120,
        )

    if response.status_code == 202:
        data = response.json()
        job_id = data["job_id"]
        print(f"   ✅ Job creado exitosamente!")
        print(f"      Job ID : {job_id}")
        print(f"      Status : {data['status']}")
        print(f"      Mensaje: {data['message']}")
    else:
        print(f"   ❌ Error del servidor: HTTP {response.status_code}")
        print(f"   Respuesta: {response.text}")
        sys.exit(1)

except requests.exceptions.Timeout:
    print("   ❌ Timeout enviando el archivo. El archivo puede ser demasiado grande.")
    sys.exit(1)
except Exception as e:
    print(f"   ❌ Error enviando el NIfTI: {e}")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Abrir el frontend en el browser
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n🌐 [5/5] Abriendo interfaz en el browser...")
frontend_job_url = f"{FRONTEND_URL}?job={job_id}"
print(f"   URL: {frontend_job_url}")

try:
    webbrowser.open(FRONTEND_URL)
    print("   ✅ Browser abierto. Navega al Job Monitor para ver el progreso.")
    print(f"      Job ID: {job_id}")
except Exception as e:
    print(f"   ⚠️  No se pudo abrir el browser automáticamente: {e}")
    print(f"   Abre manualmente: {FRONTEND_URL}")


# ─────────────────────────────────────────────────────────────────────────────
# 7. Polling del estado del job
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n" + "─" * 65)
print(f"  📊 Monitoreando progreso del Job: {job_id}")
print(f"  (Ctrl+C para salir — el job continuará en segundo plano)")
print(f"─" * 65 + "\n")

start_time = time.time()
last_progress = -1

try:
    while True:
        elapsed = time.time() - start_time
        if elapsed > POLL_TIMEOUT:
            print(f"\n⏰ Timeout de {POLL_TIMEOUT}s alcanzado. El job puede seguir en segundo plano.")
            break

        try:
            status_resp = requests.get(
                f"{API_BASE_URL}/status/{job_id}",
                timeout=10,
            )
            if status_resp.status_code != 200:
                print(f"  ⚠️  Error consultando estado: HTTP {status_resp.status_code}")
                time.sleep(POLL_INTERVAL)
                continue

            status_data = status_resp.json()
            job_info = status_data.get("job_info", {})
            current_status = job_info.get("status", "UNKNOWN")
            progress = job_info.get("progress_percentage", 0)

            # Imprimir solo si hay cambio de progreso
            if progress != last_progress:
                bar_filled = int(progress / 5)
                bar = "█" * bar_filled + "░" * (20 - bar_filled)
                elapsed_str = f"{int(elapsed // 60):02d}:{int(elapsed % 60):02d}"
                print(f"  [{elapsed_str}] [{bar}] {progress:3d}%  {current_status}")
                last_progress = progress

            if current_status == "COMPLETED":
                cr = status_data.get("clinical_results")
                print(f"\n  ✅ SEGMENTACIÓN COMPLETADA!")
                print(f"  {'─' * 55}")
                if cr:
                    vd = cr.get("volumetric_data", {})
                    rm = cr.get("recist_metrics", {})
                    print(f"  📐 Volumen del órgano  : {vd.get('volume_ml', 'N/A')} mL")
                    print(f"  📏 Diámetro RECIST     : {rm.get('longest_diameter_mm', 'N/A')} mm")
                    print(f"  🎯 Confianza del modelo: {rm.get('confidence_score', 'N/A')}")
                    v_count = vd.get('voxel_count', 'N/A')
                    v_count_str = f"{v_count:,}" if isinstance(v_count, (int, float)) else str(v_count)
                    print(f"  📦 Vóxeles foreground  : {v_count_str}")
                art = status_data.get("artifacts", {})
                if art:
                    print(f"\n  📁 Archivos generados:")
                    print(f"     Máscara NIfTI  : {art.get('segmentation_mask_nifti_url', 'N/A')}")
                    print(f"     Incertidumbre  : {art.get('uncertainty_map_url', 'N/A')}")
                print(f"\n  🌐 Visualiza el resultado en: {FRONTEND_URL}")
                print(f"     Job ID: {job_id}")
                break

            elif current_status == "FAILED":
                error = status_data.get("error_message", "Sin detalles")
                print(f"\n  ❌ JOB FALLIDO")
                print(f"  Error: {error}")
                print(f"\n  Revisa los logs del servidor para más detalles.")
                break

            elif current_status == "CANCELLED":
                print(f"\n  ⏹️  Job cancelado por el usuario.")
                break

        except requests.exceptions.Timeout:
            print(f"  ⚠️  Timeout al consultar estado (reintentando...)")
        except KeyboardInterrupt:
            print(f"\n\n  ⏸️  Monitoreo interrumpido por el usuario.")
            print(f"  El job continúa en segundo plano.")
            print(f"  Job ID: {job_id}")
            print(f"  Consulta el estado en: {FRONTEND_URL}")
            break

        time.sleep(POLL_INTERVAL)

except KeyboardInterrupt:
    print(f"\n\n  ⏸️  Monitoreo interrumpido.")
    print(f"  Job ID: {job_id}")

print("\n" + "═" * 65)
print("  Validación del pipeline finalizada.")
print("═" * 65 + "\n")
