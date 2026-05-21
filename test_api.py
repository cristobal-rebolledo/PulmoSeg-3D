import requests
import json
import io

url = "http://localhost:80/api/segment"
# Create 300 dummy files
files = []
relative_paths = []
for i in range(300):
    content = b"test content" * 60000
    fname = f"00000{i}.dcm"
    files.append(("files", (fname, io.BytesIO(content), "application/dicom")))
    relative_paths.append(f"LIDC-IDRI-0020/1.3.6.1.4.1.14519.5.2.1.6279.6001.888021904600511420323095129935/1.3.6.1.4.1.14519.5.2.1.6279.6001.315214756157389122376518747372/{fname}")

data = {
    "patient_pseudo_id": "LIDC-IDRI-0020",
    "study_instance_uid": "1.3.6.1.4.1.14519.5.2.1.6279.6001.888021904600511420323095129935",
    "relative_paths": json.dumps(relative_paths)
}

try:
    print("Sending request...")
    response = requests.post(url, files=files, data=data)
    print("Status:", response.status_code)
    print("Body:", response.text)
except Exception as e:
    print("Error:", e)
