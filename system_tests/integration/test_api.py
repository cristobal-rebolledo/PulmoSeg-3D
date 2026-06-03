import requests

url = "http://localhost:8000/segment-nifti"
file_path = r"D:\Semestre 11\Task06_Lung\Task06_Lung\imagesTr\lung_001.nii.gz"

with open(file_path, "rb") as f:
    files = {"file": ("lung_001.nii.gz", f, "application/octet-stream")}
    data = {
        "patient_pseudo_id": "test_patient_1",
        "study_instance_uid": "test_study_1"
    }
    print("Sending POST request to /segment-nifti...")
    response = requests.post(url, files=files, data=data)

print(f"Status Code: {response.status_code}")
print(f"Response: {response.text}")
