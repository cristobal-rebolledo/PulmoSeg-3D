import requests

API_BASE_URL = "https://pulmoseg-backend-827425626938.us-central1.run.app"
API_KEY = "7c115781a953e2d3727829143d7def141f409547a09643bb446507fa27813e24"
HEADERS = {"X-API-Key": API_KEY}

response = requests.get(f"{API_BASE_URL}/jobs?limit=5000", headers=HEADERS)
jobs = response.json().get("jobs", [])

print(f"Borrando {len(jobs)} registros de la base de datos...")

for i, job in enumerate(jobs):
    job_id = job["job_id"]
    requests.delete(f"{API_BASE_URL}/jobs/{job_id}", headers=HEADERS)
    print(f"[{i+1}/{len(jobs)}] Eliminado de PostgreSQL: {job_id}")

print("¡Base de datos limpia!")
