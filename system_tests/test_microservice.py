"""
system_tests/test_microservice.py — Validación del Microservicio PulmoSeg en Cloud Run.

Prueba los endpoints principales del backend desplegado en GCP, verificando:
  1. /health      → El servicio está activo.
  2. /docs        → La documentación Swagger es accesible.
  3. /config      → La configuración del modelo es legible.
  4. /jobs        → El listado de jobs requiere API Key válida.
  5. /status/xxx  → Job inexistente retorna 404 correcto.
  6. Seguridad    → Requests sin API Key son rechazados con 403.

Uso:
    python system_tests/test_microservice.py
"""

import sys
import requests

# ===========================================================================
# CONFIGURACIÓN
# ===========================================================================
BASE_URL = "https://pulmoseg-backend-827425626938.us-central1.run.app"
API_KEY = "7c115781a953e2d3727829143d7def141f409547a09643bb446507fa27813e24"
HEADERS = {"X-API-Key": API_KEY}
TIMEOUT = 15  # segundos

# Contadores
passed = 0
failed = 0


# ===========================================================================
# HELPERS
# ===========================================================================
def ok(test_name: str, detail: str = ""):
    global passed
    passed += 1
    suffix = f" — {detail}" if detail else ""
    print(f"  ✅ PASS  {test_name}{suffix}")


def fail(test_name: str, detail: str = ""):
    global failed
    failed += 1
    suffix = f" — {detail}" if detail else ""
    print(f"  ❌ FAIL  {test_name}{suffix}")


def header(title: str):
    print(f"\n{'─' * 55}")
    print(f"  {title}")
    print(f"{'─' * 55}")


# ===========================================================================
# TESTS
# ===========================================================================
def test_health():
    header("1. Healthcheck básico")
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=TIMEOUT)
        if r.status_code == 200 and r.json().get("status") == "healthy":
            ok("/health", f"status=healthy | version={r.json().get('version')}")
        else:
            fail("/health", f"HTTP {r.status_code} | body={r.text[:80]}")
    except Exception as e:
        fail("/health", f"Excepción: {e}")


def test_docs():
    header("2. Documentación Swagger (/docs)")
    try:
        r = requests.get(f"{BASE_URL}/docs", timeout=TIMEOUT)
        if r.status_code == 200 and "swagger" in r.text.lower():
            ok("/docs", "Swagger UI accesible")
        else:
            fail("/docs", f"HTTP {r.status_code}")
    except Exception as e:
        fail("/docs", f"Excepción: {e}")


def test_config():
    header("3. Configuración del modelo (/config)")
    try:
        r = requests.get(f"{BASE_URL}/config", timeout=TIMEOUT)
        if r.status_code == 200:
            cfg = r.json()
            ok("/config", f"name={cfg.get('name')} | network={cfg.get('network_type')}")
        else:
            fail("/config", f"HTTP {r.status_code}")
    except Exception as e:
        fail("/config", f"Excepción: {e}")


def test_jobs_with_key():
    header("4. Listado de Jobs con API Key (/jobs)")
    try:
        r = requests.get(f"{BASE_URL}/jobs", headers=HEADERS, timeout=TIMEOUT)
        if r.status_code == 200:
            data = r.json()
            ok("/jobs con API Key", f"total_jobs={data.get('total', '?')}")
        else:
            fail("/jobs con API Key", f"HTTP {r.status_code} | {r.text[:80]}")
    except Exception as e:
        fail("/jobs con API Key", f"Excepción: {e}")


def test_security_no_key():
    header("5. Seguridad — Endpoints sin API Key")
    try:
        r = requests.get(f"{BASE_URL}/dicom/fake-job-id/fake.dcm", timeout=TIMEOUT)
        if r.status_code == 403:
            ok("/dicom sin API Key → 403 Forbidden", "Seguridad activa ✔")
        elif r.status_code == 422:
            ok("/dicom sin API Key → 422", "Header requerido validado ✔")
        else:
            fail("/dicom sin API Key", f"HTTP esperado 403/422, obtenido {r.status_code}")
    except Exception as e:
        fail("/dicom sin API Key", f"Excepción: {e}")

    try:
        r = requests.get(f"{BASE_URL}/nifti/fake-job-id", timeout=TIMEOUT)
        if r.status_code == 403:
            ok("/nifti sin API Key → 403 Forbidden", "Seguridad activa ✔")
        elif r.status_code == 422:
            ok("/nifti sin API Key → 422", "Header requerido validado ✔")
        else:
            fail("/nifti sin API Key", f"HTTP esperado 403/422, obtenido {r.status_code}")
    except Exception as e:
        fail("/nifti sin API Key", f"Excepción: {e}")


def test_status_not_found():
    header("6. Job inexistente → 404 esperado (/status)")
    fake_job_id = "00000000-0000-0000-0000-000000000000"
    try:
        r = requests.get(f"{BASE_URL}/status/{fake_job_id}", timeout=TIMEOUT)
        if r.status_code == 404:
            ok(f"/status/{fake_job_id}", "404 Not Found correcto")
        else:
            fail(f"/status/{fake_job_id}", f"HTTP inesperado: {r.status_code}")
    except Exception as e:
        fail("/status/fake", f"Excepción: {e}")


def test_segment_nifti(nifti_path: str):
    import time
    header("7. Segmentación completa via /segment-nifti")

    if not nifti_path or not __import__("os").path.exists(nifti_path):
        fail("/segment-nifti", f"Archivo no encontrado: {nifti_path}")
        return

    filename = __import__("os").path.basename(nifti_path)
    size_mb = __import__("os").path.getsize(nifti_path) / (1024 * 1024)
    print(f"  📂 Archivo: {filename} ({size_mb:.1f} MB)")

    # 1. Subir el NIfTI
    try:
        with open(nifti_path, "rb") as f:
            r = requests.post(
                f"{BASE_URL}/segment-nifti",
                files={"file": (filename, f, "application/gzip")},
                data={"patient_pseudo_id": "test-script", "study_instance_uid": "test-001"},
                timeout=120,
            )
        if r.status_code != 202:
            fail("/segment-nifti upload", f"HTTP {r.status_code} | {r.text[:100]}")
            return

        job_id = r.json().get("job_id")
        ok("/segment-nifti upload", f"Job creado: {job_id}")
    except Exception as e:
        fail("/segment-nifti upload", f"Excepción: {e}")
        return

    # 2. Polling del estado hasta COMPLETED, FAILED o timeout
    print(f"  ⏳ Esperando resultado (máx. 10 min)...")
    max_wait = 600  # 10 minutos
    poll_interval = 10
    elapsed = 0
    final_status = None

    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval
        try:
            sr = requests.get(f"{BASE_URL}/status/{job_id}", timeout=TIMEOUT)
            if sr.status_code != 200:
                continue
            data = sr.json()
            status = data.get("job_info", {}).get("status", "?")
            pct = data.get("job_info", {}).get("progress_percentage", 0)
            print(f"    [{elapsed:3d}s] Status: {status} ({pct}%)")

            if status in ("COMPLETED", "FAILED", "CANCELLED"):
                final_status = status
                final_data = data
                break
        except Exception:
            pass

    # 3. Evaluar resultado
    if final_status == "COMPLETED":
        cr = final_data.get("clinical_results") or {}
        vol = (cr.get("volumetric_data") or {}).get("volume_ml", "N/A")
        dia = (cr.get("recist_metrics") or {}).get("longest_diameter_mm", "N/A")
        ok("/segment-nifti COMPLETED", f"volume={vol} ml | longest_diameter={dia} mm")
    elif final_status == "FAILED":
        err = final_data.get("error_message", "sin detalle")
        fail("/segment-nifti FAILED", f"Error del pipeline: {err}")
    elif final_status is None:
        fail("/segment-nifti TIMEOUT", f"Sin resultado en {max_wait}s")
    else:
        fail("/segment-nifti", f"Estado inesperado: {final_status}")


# ===========================================================================
# MAIN
# ===========================================================================
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Validación del microservicio PulmoSeg.")
    parser.add_argument("--nifti", type=str, default=None, help="Ruta a un archivo .nii.gz para probar /segment-nifti")
    args = parser.parse_args()

    print("\n" + "=" * 55)
    print(f"  PulmoSeg 3D — Validación del Microservicio en GCP")
    print(f"  URL: {BASE_URL}")
    print("=" * 55)

    test_health()
    test_docs()
    test_config()
    test_jobs_with_key()
    test_security_no_key()
    test_status_not_found()

    if args.nifti:
        test_segment_nifti(args.nifti)

    print(f"\n{'=' * 55}")
    print(f"  RESULTADO FINAL: {passed} pasaron | {failed} fallaron")
    if failed == 0:
        print("  🎉 Microservicio funcionando correctamente.")
    else:
        print("  ⚠️  Algunos tests fallaron. Revisar output anterior.")
    print("=" * 55 + "\n")

    sys.exit(0 if failed == 0 else 1)
