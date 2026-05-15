"""
Inspecciona los metadatos del estudio DICOM Spleen01 para diagnosticar
por qué el modelo podría estar segmentando incorrectamente.
"""
import pydicom
import numpy as np
import SimpleITK as sitk
from pathlib import Path

dicom_dir = Path("local_storage/inputs/dicom/Spleen01")
all_dcm = sorted(dicom_dir.rglob("*.dcm"))
print(f"Total archivos .dcm: {len(all_dcm)}")
print()

# --- 1. Metadatos del estudio ---
print("=" * 60)
print("METADATOS DEL ESTUDIO (primer slice)")
print("=" * 60)
ds = pydicom.dcmread(str(all_dcm[0]), stop_before_pixels=True)
fields = [
    "PatientID", "StudyDescription", "SeriesDescription",
    "Modality", "BodyPartExamined",
    "PixelSpacing", "SliceThickness",
    "ImagePositionPatient", "ImageOrientationPatient",
    "RescaleIntercept", "RescaleSlope",
    "WindowCenter", "WindowWidth",
    "Rows", "Columns",
]
for f in fields:
    val = getattr(ds, f, "N/A")
    print(f"  {f:30s}: {val}")

# --- 2. Verificar si hay múltiples series (CT 4D) ---
print()
print("=" * 60)
print("ANÁLISIS DE SERIES (posible 4D CT)")
print("=" * 60)
series_uids = set()
temporal_positions = set()
for dcm_file in all_dcm:
    d = pydicom.dcmread(str(dcm_file), stop_before_pixels=True)
    series_uids.add(getattr(d, "SeriesInstanceUID", "?"))
    tp = getattr(d, "TemporalPositionIdentifier", None)
    if tp:
        temporal_positions.add(tp)

print(f"  Número de series únicas   : {len(series_uids)}")
print(f"  Posiciones temporales (4D): {len(temporal_positions)}")
if temporal_positions:
    print(f"  -> ADVERTENCIA: CT 4D detectado ({len(temporal_positions)} fases)")
    print(f"     El modelo fue entrenado en CTs 3D estáticos.")
else:
    print(f"  -> CT 3D estático (correcto para el modelo)")

# --- 3. Análisis de HU (Hounsfield Units) ---
print()
print("=" * 60)
print("ANÁLISIS DE VALORES HU (rango de grises del CT)")
print("=" * 60)
print("Leyendo volumen con SimpleITK...")
reader = sitk.ImageSeriesReader()
series_files = reader.GetGDCMSeriesFileNames(str(dicom_dir / list(dicom_dir.iterdir())[0]))
if series_files:
    reader.SetFileNames(series_files[:1])
    img = sitk.ReadImage(series_files[0])
    arr = sitk.GetArrayFromImage(img).astype(np.float32)
    ri = float(getattr(ds, "RescaleIntercept", 0))
    rs = float(getattr(ds, "RescaleSlope", 1))
    hu_arr = arr * rs + ri
    print(f"  Rango HU completo         : [{hu_arr.min():.0f}, {hu_arr.max():.0f}]")
    print(f"  HU media global           : {hu_arr.mean():.1f}")

    # Ventana spleen del modelo: HU [-57, 164]
    spleen_min, spleen_max = -57.0, 164.0
    in_window = np.sum((hu_arr >= spleen_min) & (hu_arr <= spleen_max))
    total = hu_arr.size
    pct = in_window / total * 100
    print(f"  Ventana del modelo ({spleen_min},{spleen_max}): {pct:.1f}% de vóxeles en rango")
    print()
    if pct < 10:
        print("  ⚠️  MUY POCOS vóxeles en la ventana HU del modelo.")
        print("     Esto sugiere que el CT tiene valores HU muy diferentes")
        print("     a los CTs de entrenamiento (posible CT de simulación RT).")
    else:
        print("  ✅ Distribución HU compatible con el modelo.")

print()
print("=" * 60)
print("DIAGNÓSTICO FINAL")
print("=" * 60)
