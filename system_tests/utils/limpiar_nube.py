import requests
import subprocess
import json
import sys

API_BASE_URL = "https://pulmoseg-backend-827425626938.us-central1.run.app"
API_KEY = "7c115781a953e2d3727829143d7def141f409547a09643bb446507fa27813e24"

BUCKET_INPUTS = "gs://pulmoseg-inputs"
BUCKET_OUTPUTS = "gs://pulmoseg-outputs"

def get_active_jobs():
    print("📡 Consultando base de datos (PostgreSQL) para obtener jobs activos...")
    try:
        response = requests.get(f"{API_BASE_URL}/jobs?limit=5000", headers={"X-API-Key": API_KEY})
        response.raise_for_status()
        jobs_data = response.json()
        job_ids = {job["job_id"] for job in jobs_data.get("jobs", [])}
        print(f"✅ Se encontraron {len(job_ids)} jobs válidos en la base de datos.")
        return job_ids
    except Exception as e:
        print(f"❌ Error al consultar la API: {e}")
        sys.exit(1)

def get_gcs_files(bucket_path):
    """Obtiene una lista de rutas desde un bucket de GCP usando gcloud storage ls"""
    print(f"☁️  Listando contenido de {bucket_path}...")
    try:
        result = subprocess.run(
            "gcloud storage ls " + bucket_path,
            shell=True, capture_output=True, text=True, check=True
        )
        lines = [line.strip() for line in result.stdout.split('\n') if line.strip()]
        # Ignoramos la primera línea si es el nombre del bucket mismo
        files = [line for line in lines if line != f"{bucket_path}/"]
        return files
    except subprocess.CalledProcessError as e:
        print(f"❌ Error al listar {bucket_path}: {e.stderr}")
        return []

def delete_gcs_path(path):
    """Elimina un archivo o carpeta en GCP usando gcloud storage rm"""
    print(f"   🗑️  Eliminando: {path}")
    try:
        # Usamos -r para poder borrar carpetas (outputs) o archivos (inputs) sin problema
        subprocess.run(
            f"gcloud storage rm -r {path}",
            shell=True, capture_output=True, text=True, check=True
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"   ❌ Error al eliminar {path}: {e.stderr.strip()}")
        return False

def clean_orphaned_files():
    active_jobs = get_active_jobs()
    
    # 1. Limpiar Inputs (.zip)
    inputs_files = get_gcs_files(BUCKET_INPUTS)
    print(f"🔍 Se encontraron {len(inputs_files)} archivos en Inputs.")
    
    deleted_inputs = 0
    for file_path in inputs_files:
        # file_path tiene el formato: gs://pulmoseg-inputs/c5566b20-6f60-46c8-97bf-2c3c43b34217.zip
        filename = file_path.split('/')[-1]
        job_id = filename.replace('.zip', '')
        
        if job_id not in active_jobs:
            if delete_gcs_path(file_path):
                deleted_inputs += 1
                
    # 2. Limpiar Outputs (carpetas)
    outputs_folders = get_gcs_files(BUCKET_OUTPUTS)
    print(f"\n🔍 Se encontraron {len(outputs_folders)} carpetas en Outputs.")
    
    deleted_outputs = 0
    for folder_path in outputs_folders:
        # folder_path tiene el formato: gs://pulmoseg-outputs/c5566b20-6f60-46c8-97bf-2c3c43b34217/
        folder_name = folder_path.strip('/').split('/')[-1]
        job_id = folder_name
        
        if job_id not in active_jobs:
            if delete_gcs_path(folder_path):
                deleted_outputs += 1

    print("\n" + "="*50)
    print("🎉 LIMPIEZA FINALIZADA 🎉")
    print(f"🗑️  Inputs (.zip) eliminados  : {deleted_inputs}")
    print(f"🗑️  Outputs (masks) eliminadas: {deleted_outputs}")
    print("="*50)

if __name__ == "__main__":
    print("⚠️ ATENCIÓN: Este script requiere tener instalado y autenticado 'gcloud CLI'.")
    clean_orphaned_files()
