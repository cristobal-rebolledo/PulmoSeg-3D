import asyncio
import logging
from pathlib import Path
from worker.background_task import run_segmentation_job

logging.basicConfig(level=logging.INFO)

async def test():
    job_id = "test_tumor_001"
    request_data = {"patient_pseudo_id": "test", "study_instance_uid": "test"}
    nifti_path = r"D:\Semestre 11\Task06_Lung\Task06_Lung\imagesTr\lung_001.nii.gz"
    
    print(f"Testing inference on: {nifti_path}")
    
    # Run the background task directly in this process
    run_segmentation_job(
        job_id=job_id,
        request_data=request_data,
        nifti_path=nifti_path
    )
    print("Test finished. Check local_storage/outputs/test_tumor_001/mask.nii.gz")

if __name__ == '__main__':
    asyncio.run(test())
