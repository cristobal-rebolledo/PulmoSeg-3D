import os
import time
import csv
import requests
import concurrent.futures
from pathlib import Path

# ==============================================================================
# CONFIGURACIÓN DE LA PRUEBA DE CARGA (AUTOESCALADO)
# ==============================================================================

API_BASE_URL = "https://pulmoseg-backend-827425626938.us-central1.run.app"
API_KEY = "7c115781a953e2d3727829143d7def141f409547a09643bb446507fa27813e24"

TEST_DATA_DIR = Path("estudios_zip")
RESULTS_CSV = "resultados_carga.csv"
POLL_INTERVAL = 5  

# ------------------------------------------------------------------------------
# PARÁMETRO CLAVE: Nivel de concurrencia
# ------------------------------------------------------------------------------
# Cuántos estudios vas a simular enviar AL MISMO TIEMPO (ej. 5 o 10 doctores a la vez)
CONCURRENCY_LEVEL = 5  
# Cuántos estudios tomar de los 100 disponibles para esta prueba
MAX_STUDIES_TO_TEST = 10  

# ==============================================================================
# LÓGICA DE PROCESAMIENTO (HILO INDIVIDUAL)
# ==============================================================================
def process_single_study(zip_path, study_index):
    headers = {"X-API-Key": API_KEY}
    size_mb = zip_path.stat().st_size / (1024 * 1024)
    
    result = {
        "Archivo": zip_path.name,
        "Tamaño (MB)": f"{size_mb:.2f}",
        "Job ID": "N/A",
        "Tiempo de Subida (s)": "ERROR",
        "Tiempo de Procesamiento GPU (s)": "ERROR",
        "Tiempo Total (s)": "ERROR",
        "Estado Final": "ERROR"
    }

    t_start_upload = time.time()
    try:
        with open(zip_path, "rb") as f_zip:
            files = {"files": (zip_path.name, f_zip, "application/zip")}
            data = {
                "patient_pseudo_id": f"load_pt_{study_index}",
                "study_instance_uid": f"load_study_{study_index}"
            }
            # Se hace la petición POST. Al usar ThreadPoolExecutor, estas llamadas ocurren en paralelo
            response = requests.post(f"{API_BASE_URL}/segment", headers=headers, files=files, data=data)
            response.raise_for_status()
            job_id = response.json()["job_id"]
            result["Job ID"] = job_id
    except Exception as e:
        print(f"❌ [Doctor {study_index}] Error de red al subir {zip_path.name}: {e}")
        return result

    t_end_upload = time.time()
    upload_time = t_end_upload - t_start_upload
    result["Tiempo de Subida (s)"] = f"{upload_time:.2f}"
    print(f"✅ [Doctor {study_index}] {zip_path.name} subido en {upload_time:.2f} s. Esperando procesamiento...")

    processing_time = 0
    t_start_processing = time.time()

    # Ciclo de polling
    while True:
        try:
            res_status = requests.get(f"{API_BASE_URL}/status/{job_id}", headers=headers)
            res_status.raise_for_status()
            status_data = res_status.json()
            current_status = status_data.get("job_info", {}).get("status")
            
            if current_status == "COMPLETED":
                t_end_processing = time.time()
                processing_time = t_end_processing - t_start_processing
                result["Estado Final"] = "COMPLETED"
                print(f"🎉 [Doctor {study_index}] Inferencia completada para {zip_path.name} en {processing_time:.2f} s. Limpiando...")
                
                # Limpieza desde nuestro script (Opción B)
                requests.delete(f"{API_BASE_URL}/jobs/{job_id}", headers=headers)
                break
            
            elif current_status in ["FAILED", "CANCELLED"]:
                t_end_processing = time.time()
                processing_time = t_end_processing - t_start_processing
                result["Estado Final"] = current_status
                print(f"❌ [Doctor {study_index}] El trabajo falló. Estado: {current_status}")
                break
                
        except Exception:
            # Ignorar errores de red temporales durante el polling
            pass
        
        time.sleep(POLL_INTERVAL)

    total_time = upload_time + processing_time
    result["Tiempo de Procesamiento GPU (s)"] = f"{processing_time:.2f}"
    result["Tiempo Total (s)"] = f"{total_time:.2f}"
    return result

# ==============================================================================
# SCRIPT PRINCIPAL
# ==============================================================================
def run_load_test():
    if not TEST_DATA_DIR.exists():
        print(f"⚠️ La carpeta '{TEST_DATA_DIR}' no existe.")
        return

    # Tomar los primeros N estudios de la carpeta
    zip_files = list(TEST_DATA_DIR.glob("*.zip"))[:MAX_STUDIES_TO_TEST]
    if not zip_files:
        print(f"⚠️ No se encontraron archivos .zip en la carpeta '{TEST_DATA_DIR}'.")
        return

    print(f"🚀 INICIANDO PRUEBA DE ESTRÉS / CARGA")
    print(f"Simulando {CONCURRENCY_LEVEL} peticiones al mismo tiempo hacia Google Cloud.")
    print(f"Total de estudios a procesar: {len(zip_files)}")
    print("="*60)

    # Preparar el archivo CSV antes de lanzar los hilos
    with open(RESULTS_CSV, mode="w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Archivo", "Tamaño (MB)", "Job ID", "Tiempo de Subida (s)", 
            "Tiempo de Procesamiento GPU (s)", "Tiempo Total (s)", "Estado Final"
        ])

        # Lanzar el ThreadPoolExecutor (Simula a múltiples usuarios)
        with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY_LEVEL) as executor:
            # Map asigna cada ZIP a un hilo disponible
            futures = [
                executor.submit(process_single_study, zip_path, i+1) 
                for i, zip_path in enumerate(zip_files)
            ]
            
            # Recibir resultados a medida que los hilos terminen
            for future in concurrent.futures.as_completed(futures):
                res = future.result()
                # Guardar el resultado individual apenas llegue
                writer.writerow([
                    res["Archivo"], res["Tamaño (MB)"], res["Job ID"], 
                    res["Tiempo de Subida (s)"], res["Tiempo de Procesamiento GPU (s)"], 
                    res["Tiempo Total (s)"], res["Estado Final"]
                ])
                f.flush()

    print("="*60)
    print(f"🎉 PRUEBA DE CARGA FINALIZADA 🎉")
    print(f"Resultados guardados en: {RESULTS_CSV}")
    print(f"¡Revisa tu panel de Google Cloud Run para ver los contenedores escalando!")

if __name__ == "__main__":
    run_load_test()
