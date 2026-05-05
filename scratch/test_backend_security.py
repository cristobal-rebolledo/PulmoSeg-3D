import os
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("PULMOSEG_API_KEY")
BASE_URL = "http://127.0.0.1:8000"

def test_health():
    try:
        response = requests.get(f"{BASE_URL}/health")
        print(f"Health Check: {response.status_code} - {response.json()}")
    except Exception as e:
        print(f"Health Check Failed: {e}")

def test_protected_endpoint():
    # Attempt to access /dicom without API Key
    try:
        response = requests.get(f"{BASE_URL}/dicom/test-job/test.dcm")
        print(f"Protected (No Key): {response.status_code} (Expected 403)")
    except Exception as e:
        print(f"Protected (No Key) Failed: {e}")

    # Attempt to access /dicom with correct API Key
    try:
        headers = {"X-API-Key": API_KEY}
        response = requests.get(f"{BASE_URL}/dicom/test-job/test.dcm", headers=headers)
        print(f"Protected (With Key): {response.status_code} (Expected 404 if file missing, but not 403)")
    except Exception as e:
        print(f"Protected (With Key) Failed: {e}")

if __name__ == "__main__":
    print(f"Testing with API_KEY: {API_KEY}")
    # Note: Backend must be running for this to work.
    # I will try to start the backend in the background first.
