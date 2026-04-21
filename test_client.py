"""
test_client.py — Script de prueba end-to-end para PulmoSeg 3D API.

Testea el flujo completo:
  1. GET /health         → Verifica que la API esté activa.
  2. POST /segment       → Crea un Job con los datos DICOM reales de LIDC-IDRI-0001.
  3. GET /status/{id}    → Monitorea el progreso hasta COMPLETED o FAILED.
  4. Imprime resultados  → Muestra clinical_results y artifacts del job.

Requisitos:
  - La API debe estar corriendo en http://127.0.0.1:8000
    (uvicorn api.main:app --reload)
  - Los archivos DICOM deben estar en:
    local_storage/inputs/dicom/LIDC-IDRI-0001/
      1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192/
  - Instalar requests si no está disponible:
    pip install requests

Uso:
  python test_client.py
"""

import json
import sys
import time

import requests

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
BASE_URL = "http://127.0.0.1:8000"
POLL_INTERVAL_SECONDS = 3   # Segundos entre cada consulta de estado
MAX_WAIT_SECONDS = 600       # Timeout máximo (10 minutos para pipeline MONAI)

# Colores ANSI para la terminal (funciona en Windows con terminal moderna)
GREEN   = "\033[92m"
YELLOW  = "\033[93m"
RED     = "\033[91m"
CYAN    = "\033[96m"
BOLD    = "\033[1m"
RESET   = "\033[0m"

# ---------------------------------------------------------------------------
# Payload del request — espejo exacto de Diseño/CreateSegmentationJob_Request.json
# Usa los UIDs reales del dataset LIDC-IDRI-0001.
# ---------------------------------------------------------------------------
SEGMENTATION_REQUEST = {
    "idempotency_key": "req_lidc_0001_v3",
    "patient_pseudo_id": "LIDC-IDRI-0001",
    "study_instance_uid": "1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192",
    "dicom_source": {
        "gcs_bucket": "local",
        "gcs_prefix": "dicom/LIDC-IDRI-0001/1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192/",
        "series_instance_uid": "1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192",
        "expected_file_count": 133,
    },
    "target_roi": {
        "enabled": True,
        "roi_validation_mode": "STRICT",
        "coordinates": {
            "x_min": 120, "x_max": 380,
            "y_min": 100, "y_max": 400,
            "z_min": 10,  "z_max": 120,
        },
    },
    "execution_config": {
        "model_version": "SegResNet_Lung_v2.1",
        "priority": "NORMAL",
        "webhook_url": None,
    },
}


# ---------------------------------------------------------------------------
# Funciones auxiliares de impresión
# ---------------------------------------------------------------------------
def print_header(text: str):
    print(f"\n{BOLD}{CYAN}{'=' * 60}{RESET}")
    print(f"{BOLD}{CYAN}  {text}{RESET}")
    print(f"{BOLD}{CYAN}{'=' * 60}{RESET}")


def print_ok(text: str):
    print(f"  {GREEN}✅ {text}{RESET}")


def print_warn(text: str):
    print(f"  {YELLOW}⚠️  {text}{RESET}")


def print_err(text: str):
    print(f"  {RED}❌ {text}{RESET}")


def print_info(text: str):
    print(f"  {CYAN}ℹ️  {text}{RESET}")


def print_json(data: dict):
    print(json.dumps(data, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# PASO 1: Healthcheck
# ---------------------------------------------------------------------------
def check_health() -> bool:
    print_header("PASO 1 — Healthcheck  GET /health")
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        print_ok(f"API activa: {data.get('service')} v{data.get('version')}")
        print_ok(f"Status: {data.get('status')}")
        return True
    except requests.exceptions.ConnectionError:
        print_err(
            "No se pudo conectar a la API. Verifica que esté corriendo:\n"
            "    uvicorn api.main:app --reload"
        )
        return False
    except Exception as e:
        print_err(f"Error inesperado: {e}")
        return False


# ---------------------------------------------------------------------------
# PASO 2: Crear Job de Segmentación
# ---------------------------------------------------------------------------
def create_job() -> str | None:
    print_header("PASO 2 — Crear Job  POST /segment")
    print_info("Payload enviado:")
    print_json(SEGMENTATION_REQUEST)

    try:
        resp = requests.post(
            f"{BASE_URL}/segment",
            json=SEGMENTATION_REQUEST,
            timeout=10,
        )

        print(f"\n  HTTP Status: {resp.status_code}")

        if resp.status_code == 202:
            data = resp.json()
            job_id = data.get("job_id")
            print_ok(f"Job creado exitosamente")
            print_ok(f"Job ID:  {BOLD}{job_id}{RESET}")
            print_ok(f"Estado:  {data.get('status')}")
            print_ok(f"Mensaje: {data.get('message')}")
            return job_id

        elif resp.status_code == 200:
            # Job ya existía (idempotencia)
            data = resp.json()
            job_id = data.get("job_id")
            print_warn(f"Job ya existía (idempotencia). Job ID: {job_id}")
            print_warn(f"Estado actual: {data.get('status')}")
            return job_id

        else:
            print_err(f"Error HTTP {resp.status_code}")
            print_err(f"Respuesta: {resp.text}")
            return None

    except Exception as e:
        print_err(f"Error al crear el Job: {e}")
        return None


# ---------------------------------------------------------------------------
# PASO 3: Monitorear el estado del Job
# ---------------------------------------------------------------------------
def poll_job_status(job_id: str) -> dict | None:
    print_header(f"PASO 3 — Monitorear Estado  GET /status/{job_id}")
    print_info(f"Consultando cada {POLL_INTERVAL_SECONDS}s (timeout: {MAX_WAIT_SECONDS}s)...\n")

    elapsed = 0
    last_status = ""
    last_progress = -1

    while elapsed < MAX_WAIT_SECONDS:
        try:
            resp = requests.get(f"{BASE_URL}/status/{job_id}", timeout=10)
            resp.raise_for_status()
            data = resp.json()

            job_info    = data.get("job_info", {})
            status      = job_info.get("status", "UNKNOWN")
            progress    = job_info.get("progress_percentage", 0)
            error_msg   = data.get("error_message")

            # Solo imprimir si algo cambió
            if status != last_status or progress != last_progress:
                timestamp = time.strftime("%H:%M:%S")
                bar_filled = int(progress / 5)   # Barra de 20 caracteres
                bar = "█" * bar_filled + "░" * (20 - bar_filled)

                status_color = {
                    "QUEUED":     YELLOW,
                    "PROCESSING": CYAN,
                    "COMPLETED":  GREEN,
                    "FAILED":     RED,
                }.get(status, RESET)

                print(
                    f"  [{timestamp}] {status_color}{BOLD}{status:<12}{RESET}"
                    f"  [{bar}] {progress:3d}%"
                )

                last_status   = status
                last_progress = progress

            # --- Fin del ciclo ---
            if status == "COMPLETED":
                print()
                print_ok("Job completado exitosamente.")
                return data

            elif status == "FAILED":
                print()
                print_err(f"El Job falló.")
                if error_msg:
                    print_err(f"Mensaje de error: {error_msg}")
                return data

        except requests.exceptions.RequestException as e:
            print_warn(f"Error al consultar estado: {e}. Reintentando...")

        time.sleep(POLL_INTERVAL_SECONDS)
        elapsed += POLL_INTERVAL_SECONDS

    print_err(f"Timeout: El Job no terminó en {MAX_WAIT_SECONDS} segundos.")
    return None


# ---------------------------------------------------------------------------
# PASO 4: Mostrar resultados finales
# ---------------------------------------------------------------------------
def print_results(result_data: dict):
    print_header("PASO 4 — Resultados Finales")

    job_info = result_data.get("job_info", {})
    clinical = result_data.get("clinical_results")
    artifacts = result_data.get("artifacts")
    history  = result_data.get("state_history", [])

    # --- Job Info ---
    print(f"\n  {BOLD}📋 Información del Job:{RESET}")
    print(f"     Job ID:    {job_info.get('job_id')}")
    print(f"     Estado:    {job_info.get('status')}")
    print(f"     Progreso:  {job_info.get('progress_percentage')}%")
    ts = job_info.get("timestamps", {})
    print(f"     Recibido:  {ts.get('received_at', 'N/A')}")
    print(f"     Completado:{ts.get('completed_at', 'N/A')}")

    # --- Historial de estados ---
    if history:
        print(f"\n  {BOLD}🕐 Historial de Estados:{RESET}")
        for entry in history:
            print(f"     {entry.get('time', '')}  →  {entry.get('state', '')}")

    # --- Resultados Clínicos ---
    if clinical:
        print(f"\n  {BOLD}🫁 Resultados Clínicos:{RESET}")
        print(f"     Lesión ID:         {clinical.get('lesion_id')}")

        vol = clinical.get("volumetric_data", {})
        print(f"     Volumen:           {vol.get('volume_ml')} mL  ({vol.get('volume_mm3')} mm³)")

        recist = clinical.get("recist_metrics", {})
        print(f"     Diámetro mayor:    {recist.get('longest_diameter_mm')} mm")
        print(f"     Diámetro perpend.: {recist.get('perpendicular_diameter_mm')} mm")
        print(f"     Confianza modelo:  {recist.get('confidence_score'):.2f}")
        print(f"     Plano medición:    {recist.get('measurement_plane')}")
    else:
        print_warn("No hay resultados clínicos disponibles.")

    # --- Artifacts ---
    if artifacts:
        print(f"\n  {BOLD}📁 Archivos Generados:{RESET}")
        print(f"     Máscara NIfTI:     {artifacts.get('segmentation_mask_nifti_url')}")
        unc = artifacts.get("uncertainty_map_url")
        if unc:
            print(f"     Mapa incertidumbre:{unc}")
    else:
        print_warn("No hay artifacts disponibles.")

    print(f"\n{BOLD}{GREEN}{'=' * 60}{RESET}")
    print(f"{BOLD}{GREEN}  TEST COMPLETADO{RESET}")
    print(f"{BOLD}{GREEN}{'=' * 60}{RESET}\n")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main():
    print(f"\n{BOLD}PulmoSeg 3D — Test Cliente E2E{RESET}")
    print(f"API: {BASE_URL}")

    # Paso 1: Healthcheck
    if not check_health():
        sys.exit(1)

    # Paso 2: Crear Job
    job_id = create_job()
    if not job_id:
        sys.exit(1)

    # Paso 3: Monitorear estado
    result = poll_job_status(job_id)
    if not result:
        sys.exit(1)

    # Paso 4: Mostrar resultados
    print_results(result)


if __name__ == "__main__":
    main()
