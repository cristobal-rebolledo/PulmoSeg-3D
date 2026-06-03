import time
import csv
import zipfile
import requests
from pathlib import Path

# ==============================================================================
# CONFIGURACIÓN DE LA PRUEBA
# ==============================================================================

# URL de tu backend en producción
API_BASE_URL = "https://pulmoseg-backend-827425626938.us-central1.run.app"

# Clave de API de producción
API_KEY = "7c115781a953e2d3727829143d7def141f409547a09643bb446507fa27813e24"

# Carpeta donde están los 100 archivos .zip de los estudios
TEST_DATA_DIR = Path("estudios_zip")

# Archivo CSV donde se guardarán los resultados
RESULTS_CSV = "resultados_latencia.csv"

# Tiempo de espera (en segundos) entre cada consulta a Cloud Run
POLL_INTERVAL = 5

# Tiempo máximo (en segundos) que esperaremos por un solo estudio antes de
# marcarlo como TIMEOUT y pasar al siguiente.
# 15 minutos = 900 segundos
MAX_WAIT_SECONDS = 900

# Nombre del archivo .zip desde el cual comenzar (inclusive).
# Cambia a None para procesar todos desde el principio.
START_FROM_FILE = "LUNG1-021.zip"

# ==============================================================================
# FUNCIÓN AUXILIAR: Contar slices DICOM dentro del .zip
# ==============================================================================

def count_dicom_slices(zip_path: Path) -> int:
    """
    Abre el ZIP localmente y cuenta cuántos archivos .dcm contiene.
    Si falla (ZIP corrupto, etc.), retorna -1.
    """
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            # Cuenta archivos .dcm (sin importar mayúsculas/minúsculas)
            slices = sum(
                1 for name in zf.namelist()
                if name.lower().endswith(".dcm")
            )
            return slices
    except Exception:
        return -1

# ==============================================================================
# SCRIPT PRINCIPAL
# ==============================================================================

def run_latency_test():
    # 1. Validar que la carpeta exista
    if not TEST_DATA_DIR.exists():
        print(f"⚠️ ¡ATENCIÓN! La carpeta '{TEST_DATA_DIR}' no existe.")
        TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)
        return

    # 2. Buscar y ordenar archivos .zip
    zip_files = sorted(TEST_DATA_DIR.glob("*.zip"))
    if not zip_files:
        print(f"⚠️ No se encontraron archivos .zip en la carpeta '{TEST_DATA_DIR}'.")
        return

    # 3. Filtrar desde START_FROM_FILE si está configurado
    if START_FROM_FILE:
        start_names = [f.name for f in zip_files]
        if START_FROM_FILE in start_names:
            start_index = start_names.index(START_FROM_FILE)
            zip_files = zip_files[start_index:]
            print(f"▶️  Reanudando desde: {START_FROM_FILE} ({len(zip_files)} estudios restantes)")
        else:
            print(f"⚠️ Archivo de inicio '{START_FROM_FILE}' no encontrado. Comenzando desde el principio.")

    print(f"🚀 Iniciando Prueba de Latencia con {len(zip_files)} estudios...")
    print(f"⏱️  Timeout por estudio: {MAX_WAIT_SECONDS // 60} minutos")

    headers = {"X-API-Key": API_KEY}

    # 4. Determinar si el CSV ya existe para decidir si escribir cabeceras
    csv_exists = Path(RESULTS_CSV).exists()

    with open(RESULTS_CSV, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)

        # Escribir cabeceras solo si el archivo es nuevo
        if not csv_exists:
            writer.writerow([
                "Archivo",
                "Tamaño (MB)",
                "Slices DICOM",
                "Job ID",
                "Tiempo de Subida (s)",
                "Tiempo de Procesamiento GPU (s)",
                "Tiempo Total (s)",
                "Estado Final"
            ])

        total = len(zip_files)
        for i, zip_path in enumerate(zip_files):
            print(f"\n" + "="*50)
            print(f"[{i+1}/{total}] Procesando: {zip_path.name}")

            size_mb = zip_path.stat().st_size / (1024 * 1024)
            print(f"📦 Tamaño: {size_mb:.2f} MB")

            # Contar slices DICOM dentro del ZIP (sin descomprimir)
            num_slices = count_dicom_slices(zip_path)
            if num_slices >= 0:
                print(f"🩻 Slices DICOM: {num_slices}")
            else:
                print(f"🩻 Slices DICOM: (no se pudo determinar)")

            # A. Enviar a la API
            t_start_upload = time.time()
            job_id = None
            upload_time = 0
            try:
                with open(zip_path, "rb") as f_zip:
                    files = {"files": (zip_path.name, f_zip, "application/zip")}
                    data = {
                        "patient_pseudo_id": f"test_lat_{zip_path.stem}",
                        "study_instance_uid": f"test_lat_{zip_path.stem}"
                    }
                    print("⬆️ Subiendo a la nube...")
                    response = requests.post(
                        f"{API_BASE_URL}/segment",
                        headers=headers,
                        files=files,
                        data=data,
                        timeout=120
                    )
                    response.raise_for_status()
                    job_data = response.json()
                    job_id = job_data["job_id"]
            except Exception as e:
                print(f"❌ Error al subir: {e}")
                writer.writerow([
                    zip_path.name, f"{size_mb:.2f}", num_slices if num_slices >= 0 else "N/A",
                    "N/A", "ERROR", "ERROR", "ERROR", str(e)
                ])
                f.flush()
                continue

            t_end_upload = time.time()
            upload_time = t_end_upload - t_start_upload
            print(f"✅ Subida exitosa en {upload_time:.2f} segundos. (Job ID: {job_id})")

            # B. Polling con TIMEOUT
            print(f"⏳ Esperando inferencia... (máx. {MAX_WAIT_SECONDS // 60} min)")
            processing_time = 0
            final_status = "UNKNOWN"
            t_start_processing = time.time()

            while True:
                elapsed = time.time() - t_start_processing

                # Verificar timeout
                if elapsed > MAX_WAIT_SECONDS:
                    processing_time = elapsed
                    final_status = "TIMEOUT"
                    print(f"⏰ TIMEOUT: El estudio tardó más de {MAX_WAIT_SECONDS // 60} min. Pasando al siguiente.")
                    # Intentar limpiar el job huérfano de la base de datos
                    try:
                        requests.delete(f"{API_BASE_URL}/jobs/{job_id}", headers=headers, timeout=10)
                    except Exception:
                        pass
                    break

                try:
                    res_status = requests.get(
                        f"{API_BASE_URL}/status/{job_id}",
                        headers=headers,
                        timeout=15
                    )
                    res_status.raise_for_status()
                    status_data = res_status.json()
                    # El estado está anidado dentro de job_info
                    current_status = status_data.get("job_info", {}).get("status")

                    # Mostrar progreso si está disponible
                    progress = status_data.get("job_info", {}).get("progress_percentage")
                    if progress is not None:
                        print(f"   ↳ Estado: {current_status} | Progreso: {progress}% | Transcurrido: {elapsed:.0f}s")

                    if current_status == "COMPLETED":
                        processing_time = time.time() - t_start_processing
                        final_status = "COMPLETED"
                        print(f"✅ ¡Inferencia completada en {processing_time:.2f} segundos!")

                        # C. Limpiar basura de Google Cloud
                        print("🧹 Eliminando registros de la nube para ahorrar espacio...")
                        try:
                            requests.delete(f"{API_BASE_URL}/jobs/{job_id}", headers=headers, timeout=10)
                        except Exception:
                            pass
                        break

                    elif current_status in ["FAILED", "CANCELLED"]:
                        processing_time = time.time() - t_start_processing
                        final_status = current_status
                        error_msg = status_data.get("error_message", "Error desconocido")
                        print(f"❌ El procesamiento falló. Estado: {current_status}. Detalle: {error_msg}")
                        break

                except Exception as e:
                    print(f"⚠️ Advertencia al consultar estado (se reintentará): {e}")

                time.sleep(POLL_INTERVAL)

            # 5. Guardar fila en CSV
            total_time = upload_time + processing_time
            writer.writerow([
                zip_path.name,
                f"{size_mb:.2f}",
                num_slices if num_slices >= 0 else "N/A",
                job_id,
                f"{upload_time:.2f}",
                f"{processing_time:.2f}",
                f"{total_time:.2f}",
                final_status
            ])
            # Guardado inmediato a disco en cada iteración
            f.flush()

    print(f"\n" + "="*50)
    print(f"🎉 PRUEBA FINALIZADA 🎉")
    print(f"📊 Resultados guardados en: {RESULTS_CSV}")
    print(f"Ya puedes abrirlo en Excel para graficar Tiempo vs Tamaño.")


if __name__ == "__main__":
    run_latency_test()
