import SimpleITK as sitk
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import generate_uid
import numpy as np
from datetime import datetime
import os
 
def nifti_to_dicom_sitk(nifti_path, output_dir, patient_id="Patient1"):
    """
    Convierte NIfTI a DICOM usando SimpleITK.
    Mantiene la información de spacing original.
    """
    # Crear directorio de salida
    os.makedirs(output_dir, exist_ok=True)
    
    # Leer imagen NIfTI
    image = sitk.ReadImage(nifti_path)
    
    # Extraer información
    array = sitk.GetArrayFromImage(image)
    spacing = image.GetSpacing()
    origin = image.GetOrigin()
    direction = image.GetDirection()
    
    print(f"Dimensiones: {image.GetSize()}")
    print(f"Spacing (voxel): {spacing}")
    print(f"Origen: {origin}")
    
    # Normalizar a rango 8-bit (0-255) para mejor visualización
    # OJO: Para datos médicos reales, usar HU normalization
    array_normalized = np.clip(array, array.min(), array.max())
    array_normalized = ((array_normalized - array_normalized.min()) / 
                        (array_normalized.max() - array_normalized.min()) * 255).astype(np.uint8)
    
    # Crear un DICOM por slice
    num_slices = array_normalized.shape[0]
    
    for i in range(num_slices):
        slice_data = array_normalized[i]
        
        # Crear archivo DICOM
        file_meta = Dataset()
        file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'  # CT Image Storage
        file_meta.MediaStorageSOPInstanceUID = generate_uid()
        file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
        
        ds = FileDataset(
            filename=os.path.join(output_dir, f'slice_{i:04d}.dcm'),
            dataset={},
            file_meta=file_meta,
            preamble=b'\x00' * 128
        )
        
        # Información del paciente
        ds.PatientName = patient_id
        ds.PatientID = patient_id
        ds.PatientBirthDate = ''
        ds.PatientSex = 'O'  # Other
        
        # Información del estudio
        ds.StudyInstanceUID = generate_uid()
        ds.SeriesInstanceUID = generate_uid()
        ds.StudyDate = datetime.now().strftime('%Y%m%d')
        ds.SeriesDate = datetime.now().strftime('%Y%m%d')
        ds.ContentDate = datetime.now().strftime('%Y%m%d')
        ds.ContentTime = datetime.now().strftime('%H%M%S.%f')
        
        # Información de la serie
        ds.Modality = 'CT'
        ds.SeriesNumber = 1
        ds.InstanceNumber = i + 1
        
        # Información de la imagen
        ds.Rows, ds.Columns = slice_data.shape
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        
        # Spacing
        ds.PixelSpacing = [str(spacing[1]), str(spacing[0])]  # [column, row]
        ds.SliceThickness = str(spacing[2])
        
        # Posición del slice
        slice_location = origin[2] + i * spacing[2]
        ds.SliceLocation = str(slice_location)
        
        # Datos de píxeles
        ds.PixelData = slice_data.tobytes()
        
        # Guardar
        ds.save_as(ds.filename, write_like_original=False)
        print(f"✓ Slice {i+1}/{num_slices} guardado")
    
    print(f"\n✓ Conversión completada: {num_slices} slices en {output_dir}")