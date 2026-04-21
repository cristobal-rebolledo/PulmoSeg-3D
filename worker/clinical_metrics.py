"""
clinical_metrics.py — Postprocesamiento y métricas clínicas para PulmoSeg 3D.

Traduce la salida de una red de segmentación (máscara binaria 3D) en medidas
clínicas reales: volumen (mm³ y mL) y diámetros RECIST (mayor y perpendicular).

Matemática empleada:
  - Volumen: N_voxeles × V_voxel, donde V_voxel = Πᵢ spacingᵢ
  - Diámetros: scipy.ndimage.label + skimage.measure.regionprops para obtener
    major_axis_length y minor_axis_length del componente conectado más grande.

Convención de coordenadas:
  La máscara se asume en orden (D, H, W) — como la genera SimpleITK/MONAI.
  El voxel_spacing se expresa en mm y sigue el mismo orden (D, H, W).

Ejemplo de uso:
  >>> from worker.clinical_metrics import compute_clinical_metrics
  >>> results = compute_clinical_metrics(mask_np, voxel_spacing=(1.5, 1.5, 1.5))
  >>> print(results["volume_ml"])
"""

import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger("pulmoseg.metrics")


# ---------------------------------------------------------------------------
# Imports condicionales — scipy y skimage son pesados, se validan al inicio
# ---------------------------------------------------------------------------
try:
    from scipy import ndimage
    from skimage.measure import regionprops, label as sk_label
    SKIMAGE_AVAILABLE = True
except ImportError:
    SKIMAGE_AVAILABLE = False
    logger.warning(
        "scipy/scikit-image no disponible — diámetros se calcularán "
        "con el método del bounding-box como fallback."
    )


def compute_clinical_metrics(
    mask: np.ndarray,
    voxel_spacing: tuple[float, float, float] = (1.5, 1.5, 1.5),
    lesion_id: str = "L1",
    confidence_score: float = 0.94,
    measurement_plane: str = "AXIAL",
) -> dict:
    """
    Calcula métricas clínicas a partir de una máscara binaria 3D.

    Args:
        mask:             Array 3D de NumPy (D, H, W).
                          Valores: 1 = nódulo, 0 = fondo.
        voxel_spacing:    Espaciado isotrópico en mm — (spacing_d, spacing_h, spacing_w).
                          Default: (1.5, 1.5, 1.5) mm (el spacing del pipeline).
        lesion_id:        Identificador de la lesión para la respuesta.
        confidence_score: Score de confianza del modelo (0-1).
        measurement_plane: Plano RECIST — "AXIAL", "CORONAL", "SAGITAL".

    Returns:
        dict compatible con el schema ClinicalResults del frontend:
        {
            "lesion_id": str,
            "volumetric_data": {
                "volume_mm3": float,
                "volume_ml": float,
            },
            "recist_metrics": {
                "measurement_plane": str,
                "longest_diameter_mm": float,
                "perpendicular_diameter_mm": float,
                "confidence_score": float,
            },
        }

    Raises:
        ValueError: Si la máscara no es 3D o está completamente vacía.
    """
    # ── Validaciones ─────────────────────────────────────────────
    if mask.ndim != 3:
        raise ValueError(
            f"La máscara debe ser 3D, pero tiene {mask.ndim} dimensiones "
            f"(shape: {mask.shape})"
        )

    binary_mask = (mask > 0).astype(np.uint8)
    n_voxels = int(binary_mask.sum())

    if n_voxels == 0:
        raise ValueError(
            "La máscara no contiene vóxeles de nódulo (todos son 0). "
            "No se puede calcular métricas clínicas."
        )

    logger.info(
        f"Calculando métricas: {n_voxels} vóxeles de nódulo, "
        f"spacing={voxel_spacing} mm"
    )

    # ── 1. Cálculo de Volumen ────────────────────────────────────
    #   V_voxel = spacing_d × spacing_h × spacing_w   (mm³)
    #   V_total = N_voxeles × V_voxel                  (mm³)
    #   V_ml    = V_mm3 / 1000                         (mL)
    voxel_volume_mm3 = float(np.prod(voxel_spacing))
    volume_mm3 = n_voxels * voxel_volume_mm3
    volume_ml = volume_mm3 / 1000.0

    logger.info(
        f"Volumen calculado: {volume_mm3:.2f} mm³ ({volume_ml:.4f} mL) "
        f"— {n_voxels} vóxeles × {voxel_volume_mm3:.4f} mm³/vóxel"
    )

    # ── 2. Cálculo de Diámetros 3D ──────────────────────────────
    diameters = _compute_diameters(binary_mask, voxel_spacing)

    logger.info(
        f"Diámetros: mayor={diameters['major_mm']:.2f} mm, "
        f"perpendicular={diameters['minor_mm']:.2f} mm"
    )

    # ── 3. Ensamblar resultado ───────────────────────────────────
    result = {
        "lesion_id": lesion_id,
        "volumetric_data": {
            "volume_mm3": round(volume_mm3, 2),
            "volume_ml": round(volume_ml, 4),
        },
        "recist_metrics": {
            "measurement_plane": measurement_plane,
            "longest_diameter_mm": round(diameters["major_mm"], 2),
            "perpendicular_diameter_mm": round(diameters["minor_mm"], 2),
            "confidence_score": round(confidence_score, 4),
        },
    }

    logger.info(f"Métricas clínicas generadas: {result}")
    return result


def compute_clinical_metrics_flat(
    mask: np.ndarray,
    voxel_spacing: tuple[float, float, float] = (1.5, 1.5, 1.5),
    lesion_id: str = "L1",
) -> dict:
    """
    Wrapper que retorna métricas clínicas en formato plano para la UI.

    Estructura de retorno:
        {
            "lesion_id": str,
            "volume_ml": float,
            "volume_mm3": float,
            "diameter_major_mm": float,
            "diameter_minor_mm": float,
        }

    Args:
        mask:          Array 3D de NumPy (D, H, W). 1 = nódulo, 0 = fondo.
        voxel_spacing: Espaciado en mm — (spacing_d, spacing_h, spacing_w).
        lesion_id:     Identificador de la lesión.

    Returns:
        dict plano con las 5 llaves requeridas por el frontend.
    """
    full = compute_clinical_metrics(
        mask=mask,
        voxel_spacing=voxel_spacing,
        lesion_id=lesion_id,
    )
    return {
        "lesion_id": full["lesion_id"],
        "volume_ml": full["volumetric_data"]["volume_ml"],
        "volume_mm3": full["volumetric_data"]["volume_mm3"],
        "diameter_major_mm": full["recist_metrics"]["longest_diameter_mm"],
        "diameter_minor_mm": full["recist_metrics"]["perpendicular_diameter_mm"],
    }


# ===========================================================================
# Cálculo de diámetros — dos estrategias
# ===========================================================================
def _compute_diameters(
    binary_mask: np.ndarray,
    voxel_spacing: tuple[float, float, float],
) -> dict[str, float]:
    """
    Calcula el diámetro mayor (RECIST) y perpendicular de la lesión.

    Estrategia primaria (si skimage disponible):
      - scipy.ndimage.label para obtener componentes conectados.
      - Seleccionar el componente más grande.
      - skimage.measure.regionprops con spacing para major/minor axis length.

    Estrategia fallback (sin skimage):
      - Bounding box del nódulo × spacing.

    Args:
        binary_mask: Array binario 3D (1=nódulo).
        voxel_spacing: Spacing en mm (D, H, W).

    Returns:
        dict con "major_mm" y "minor_mm".
    """
    if SKIMAGE_AVAILABLE:
        return _diameters_regionprops(binary_mask, voxel_spacing)
    else:
        return _diameters_bbox_fallback(binary_mask, voxel_spacing)


def _diameters_regionprops(
    binary_mask: np.ndarray,
    voxel_spacing: tuple[float, float, float],
) -> dict[str, float]:
    """
    Diámetros via skimage.measure.regionprops (método preciso).

    regionprops calcula los ejes del ellipsoide equivalente del componente
    conectado, escalados por el spacing. major_axis_length es el diámetro
    del eje mayor del ellipsoide 3D ajustado.
    """
    # Etiquetar componentes conectados
    labeled, n_components = ndimage.label(binary_mask)
    logger.info(f"Componentes conectados encontrados: {n_components}")

    if n_components == 0:
        return {"major_mm": 0.0, "minor_mm": 0.0}

    # Si hay múltiples componentes, quedarse con el más grande
    if n_components > 1:
        component_sizes = ndimage.sum(binary_mask, labeled, range(1, n_components + 1))
        largest_label = int(np.argmax(component_sizes)) + 1
        # Aislar el componente más grande
        isolated_mask = (labeled == largest_label).astype(np.uint8)
        logger.warning(
            f"Múltiples componentes ({n_components}). "
            f"Usando el mayor (label={largest_label}, "
            f"{int(component_sizes[largest_label - 1])} vóxeles)"
        )
    else:
        isolated_mask = binary_mask

    # regionprops con spacing (skimage >= 0.18 soporta spacing en 3D)
    # El spacing escala internamente las coordenadas, así que
    # major_axis_length y minor_axis_length ya salen en mm.
    props = regionprops(isolated_mask, spacing=voxel_spacing)

    if not props:
        return {"major_mm": 0.0, "minor_mm": 0.0}

    region = props[0]  # Solo hay un componente (el aislado)

    major_mm = float(region.axis_major_length)
    minor_mm = float(region.axis_minor_length)

    return {"major_mm": major_mm, "minor_mm": minor_mm}


def _diameters_bbox_fallback(
    binary_mask: np.ndarray,
    voxel_spacing: tuple[float, float, float],
) -> dict[str, float]:
    """
    Diámetros via bounding box (fallback sin skimage).

    Menos preciso que regionprops, pero no requiere dependencias extras.
    Calcula las extensiones del bounding box en cada eje × spacing.
    """
    coords = np.argwhere(binary_mask > 0)
    if len(coords) == 0:
        return {"major_mm": 0.0, "minor_mm": 0.0}

    bbox_min = coords.min(axis=0)
    bbox_max = coords.max(axis=0)
    extents_voxels = (bbox_max - bbox_min) + 1  # +1 porque es inclusivo
    extents_mm = extents_voxels.astype(float) * np.array(voxel_spacing)

    # Ordenar extensiones de mayor a menor
    sorted_extents = np.sort(extents_mm)[::-1]

    major_mm = float(sorted_extents[0])
    minor_mm = float(sorted_extents[1]) if len(sorted_extents) > 1 else 0.0

    logger.info(
        f"Diámetros (bounding-box fallback): "
        f"extents_mm={extents_mm.tolist()}"
    )

    return {"major_mm": major_mm, "minor_mm": minor_mm}


# ===========================================================================
# Utilidades de prueba
# ===========================================================================
def generate_synthetic_sphere(
    radius_voxels: int = 10,
    volume_shape: tuple[int, int, int] = (64, 64, 64),
) -> np.ndarray:
    """
    Genera una máscara sintética con una esfera perfecta centrada.

    Útil para validar que las fórmulas de volumen y diámetro coinciden
    con la geometría teórica conocida.

    Args:
        radius_voxels: Radio de la esfera en vóxeles.
        volume_shape: Dimensiones del array 3D.

    Returns:
        Array 3D de NumPy con 1s dentro de la esfera y 0s fuera.
    """
    mask = np.zeros(volume_shape, dtype=np.uint8)
    center = np.array([s // 2 for s in volume_shape])

    # Crear grid de coordenadas
    zz, yy, xx = np.mgrid[
        0:volume_shape[0],
        0:volume_shape[1],
        0:volume_shape[2],
    ]

    # Distancia euclidiana al centro
    distances = np.sqrt(
        (zz - center[0]) ** 2 +
        (yy - center[1]) ** 2 +
        (xx - center[2]) ** 2
    )

    mask[distances <= radius_voxels] = 1

    logger.info(
        f"Esfera sintética generada: radio={radius_voxels} vóxeles, "
        f"shape={volume_shape}, vóxeles dentro={int(mask.sum())}"
    )

    return mask


# ===========================================================================
# Test de verificación geométrica
# ===========================================================================
if __name__ == "__main__":
    """
    Bloque de prueba: genera una esfera sintética y valida que los
    cálculos de volumen y diámetro coincidan con la geometría teórica.

    Geometría teórica de una esfera de radio R:
      - Volumen = (4/3) × π × R³
      - Diámetro = 2 × R
    """
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        stream=sys.stdout,
    )

    print("=" * 70)
    print("PulmoSeg 3D — Test de Métricas Clínicas")
    print("=" * 70)

    # Parámetros de la esfera de prueba
    RADIUS = 10        # vóxeles
    SPACING = (1.5, 1.5, 1.5)  # mm
    VOLUME_SHAPE = (64, 64, 64)

    # Radio real en mm
    radius_mm = RADIUS * SPACING[0]

    # Geometría teórica
    theoretical_volume_mm3 = (4.0 / 3.0) * math.pi * (radius_mm ** 3)
    theoretical_volume_ml = theoretical_volume_mm3 / 1000.0
    theoretical_diameter_mm = 2.0 * radius_mm

    print(f"\n--- Parámetros ---")
    print(f"  Radio:   {RADIUS} vóxeles ({radius_mm} mm)")
    print(f"  Spacing: {SPACING} mm")
    print(f"  Volumen: {VOLUME_SHAPE}")

    print(f"\n--- Geometría Teórica (esfera perfecta) ---")
    print(f"  Volumen:   {theoretical_volume_mm3:.2f} mm³ ({theoretical_volume_ml:.4f} mL)")
    print(f"  Diámetro:  {theoretical_diameter_mm:.2f} mm")

    # Generar esfera y calcular métricas
    sphere_mask = generate_synthetic_sphere(
        radius_voxels=RADIUS,
        volume_shape=VOLUME_SHAPE,
    )

    results = compute_clinical_metrics(
        mask=sphere_mask,
        voxel_spacing=SPACING,
        lesion_id="L1_TEST",
        confidence_score=0.99,
    )

    computed_volume_mm3 = results["volumetric_data"]["volume_mm3"]
    computed_volume_ml = results["volumetric_data"]["volume_ml"]
    computed_major = results["recist_metrics"]["longest_diameter_mm"]
    computed_minor = results["recist_metrics"]["perpendicular_diameter_mm"]

    print(f"\n--- Métricas Calculadas ---")
    print(f"  Volumen:    {computed_volume_mm3:.2f} mm³ ({computed_volume_ml:.4f} mL)")
    print(f"  Diámetro mayor: {computed_major:.2f} mm")
    print(f"  Diámetro menor: {computed_minor:.2f} mm")

    # Errores
    vol_error = abs(computed_volume_mm3 - theoretical_volume_mm3)
    vol_error_pct = (vol_error / theoretical_volume_mm3) * 100

    print(f"\n--- Validación ---")
    print(f"  Error de volumen: {vol_error:.2f} mm³ ({vol_error_pct:.2f}%)")
    print(f"  (El error de discretización ~4-5% es esperado para esferas en grids cúbicos)")

    # El diámetro de regionprops es el del eje mayor del ellipsoide equivalente.
    # Para una esfera discretizada, debería ser muy cercano al diámetro teórico.
    diam_error = abs(computed_major - theoretical_diameter_mm)
    diam_error_pct = (diam_error / theoretical_diameter_mm) * 100
    print(f"  Error de diámetro mayor: {diam_error:.2f} mm ({diam_error_pct:.2f}%)")

    # Verificar simetría de la esfera (major ≈ minor)
    axis_ratio = computed_minor / computed_major if computed_major > 0 else 0
    print(f"  Ratio minor/major: {axis_ratio:.4f} (esperado ~1.0 para una esfera)")

    print(f"\n--- Resultado completo (compatible con frontend) ---")
    for key, value in results.items():
        print(f"  {key}: {value}")

    print(f"\n{'=' * 70}")

    # Validación programática
    assert vol_error_pct < 10, f"Error de volumen demasiado alto: {vol_error_pct:.2f}%"
    assert diam_error_pct < 15, f"Error de diámetro demasiado alto: {diam_error_pct:.2f}%"
    assert axis_ratio > 0.85, f"Esfera asimétrica: ratio={axis_ratio:.4f}"

    print("✅ Todas las validaciones pasaron exitosamente.")

    # --- Test del formato plano para la UI ---
    print(f"\n{'=' * 70}")
    print("Test: Formato plano (compute_clinical_metrics_flat)")
    print("=" * 70)

    from worker.clinical_metrics import compute_clinical_metrics_flat

    flat = compute_clinical_metrics_flat(
        mask=sphere_mask,
        voxel_spacing=SPACING,
        lesion_id="L1",
    )

    print(f"\n--- Resultado plano (UI) ---")
    for key, value in flat.items():
        print(f"  {key}: {value}")

    # Validar que tiene exactamente las 5 llaves requeridas
    expected_keys = {"lesion_id", "volume_ml", "volume_mm3",
                     "diameter_major_mm", "diameter_minor_mm"}
    assert set(flat.keys()) == expected_keys, (
        f"Llaves incorrectas: {set(flat.keys())} != {expected_keys}"
    )
    print("\n✅ Formato plano validado correctamente.")
    print("=" * 70)
