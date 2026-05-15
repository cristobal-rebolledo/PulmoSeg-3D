import { useState } from "react";
import DicomCanvasViewer from "@/components/viewer/DicomCanvasViewer";
import ViewerPanel from "./ViewerPanel";
import SuccessToast from "./SuccessToast";
import MetricsBar from "./MetricsBar";
import LogsAccordion from "./LogsAccordion";

const LINE_COLOR = {
  info:    "oklch(0.72 0.17 195)",
  success: "oklch(0.72 0.19 155)",
  warn:    "oklch(0.80 0.16 80)",
  error:   "oklch(0.65 0.20 20)",
  output:  "oklch(0.65 0.16 300)",
};

function buildConsoleLines(stateHistory, artifacts, clinicalResults) {
  const lines = [
    { type: "info", text: "[pulmoseg.worker] Worker iniciado — procesando Job..." },
  ];
  (stateHistory ?? []).forEach((entry) => {
    const time = new Date(entry.time).toLocaleTimeString("es-CL", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const t = entry.state === "COMPLETED" ? "success"
      : entry.state === "FAILED" ? "error"
      : entry.state === "PROCESSING" ? "info" : "warn";
    lines.push({ type: t, text: `[${time}] Estado actualizado: ${entry.state}` });
  });
  lines.push({ type: "info",    text: "[pulmoseg.pipeline] Convirtiendo DICOM → NIfTI (SimpleITK)..." });
  lines.push({ type: "info",    text: "[pulmoseg.pipeline] Preprocesamiento MONAI (Spacingd, ScaleIntensity)..." });
  lines.push({ type: "info",    text: "[pulmoseg.pipeline] Inferencia MONAI U-Net 3D (SlidingWindowInferer)..." });
  lines.push({ type: "success", text: "[pulmoseg.pipeline] Inferencia completada — generando archivos de salida..." });
  if (artifacts) {
    lines.push({ type: "output", text: `[output] Máscara: ${artifacts.segmentation_mask_nifti_url || "mask.nii.gz"}` });
    if (artifacts.uncertainty_map_url) {
      lines.push({ type: "output", text: `[output] Incertidumbre: ${artifacts.uncertainty_map_url}` });
    }
  }
  lines.push({ type: "success", text: `[pulmoseg.pipeline] Volumen: ${clinicalResults.volumetric_data?.volume_ml} mL | Confianza: ${clinicalResults.recist_metrics?.confidence_score}` });
  lines.push({ type: "success", text: "[pulmoseg.worker] ✅ Job completado exitosamente (100%)" });
  return lines;
}

/**
 * ResultsDashboard — Layout maximizado para el visor CT.
 *
 * Estructura (flex column, sin scroll):
 *   ┌─ MetricsBar (56px fijo) ──────────────────────────┐
 *   │  paciente · volumen · diámetro · confianza · timer │
 *   ├─ DicomCanvasViewer (flex-1, ocupa todo) ───────────┤
 *   └─ LogsAccordion (colapsable, empuja desde abajo) ───┘
 *   + SuccessToast (position:fixed, esquina inferior)
 */
export default function ResultsDashboard({ clinicalResults, artifacts, stateHistory, jobId, patientId }) {
  const [toastVisible, setToastVisible] = useState(true);

  if (!clinicalResults) return null;

  const consoleLines = buildConsoleLines(stateHistory, artifacts, clinicalResults);

  return (
    // Single root div — avoids Fragment breaking the flex-1 chain.
    // SuccessToast uses position:fixed so it's out of flex flow and doesn't
    // affect the layout of MetricsBar / Viewer / LogsAccordion.
    <div className="flex flex-col flex-1 overflow-hidden animate-[fade-in_0.3s_ease-out]">
      {toastVisible && (
        <SuccessToast patientId={patientId} onDismiss={() => setToastVisible(false)} />
      )}

      <MetricsBar
        clinicalResults={clinicalResults}
        patientId={patientId}
        stateHistory={stateHistory}
      />

      <div className="flex-1 overflow-hidden" style={{ backgroundColor: "#000" }}>
        {artifacts?.dicom_image_ids?.length > 0 && jobId ? (
          <DicomCanvasViewer
            jobId={jobId}
            dicomImageIds={artifacts.dicom_image_ids}
          />
        ) : (
          <ViewerPanel artifacts={artifacts} lesionId={clinicalResults.lesion_id} />
        )}
      </div>

      <LogsAccordion consoleLines={consoleLines} lineColor={LINE_COLOR} />
    </div>
  );
}
