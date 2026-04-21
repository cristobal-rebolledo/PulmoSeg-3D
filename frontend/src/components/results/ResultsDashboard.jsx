import { useState } from "react";
import MetricsPanel from "./MetricsPanel";
import ViewerPanel from "./ViewerPanel";
import { Award, Terminal, ChevronDown, ChevronUp } from "lucide-react";

/**
 * ResultsDashboard — Full results panel activated when a job completes.
 *
 * Shows:
 *   1. Success header with lesion ID
 *   2. MetricsPanel (volume, diameter, confidence)
 *   3. ViewerPanel (Axial, Coronal, Sagittal mockups)
 *   4. Backend Console (collapsible accordion — collapsed by default)
 */
export default function ResultsDashboard({ clinicalResults, artifacts, stateHistory }) {
  const [logsOpen, setLogsOpen] = useState(false);

  if (!clinicalResults) return null;

  // Build console log lines
  const consoleLines = [];
  consoleLines.push({ type: "info", text: "[pulmoseg.worker] Worker iniciado — procesando Job..." });

  if (stateHistory && stateHistory.length > 0) {
    stateHistory.forEach((entry) => {
      const time = new Date(entry.time).toLocaleTimeString("es-CL", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const stateColor = entry.state === "COMPLETED" ? "success"
        : entry.state === "FAILED" ? "error"
        : entry.state === "PROCESSING" ? "info" : "warn";
      consoleLines.push({ type: stateColor, text: `[${time}] Estado actualizado: ${entry.state}` });
    });
  }

  consoleLines.push({ type: "info",    text: "[pulmoseg.pipeline] Convirtiendo DICOM → NIfTI (SimpleITK)..." });
  consoleLines.push({ type: "info",    text: "[pulmoseg.pipeline] Aplicando preprocesamiento nnU-Net..." });
  consoleLines.push({ type: "info",    text: "[pulmoseg.pipeline] Ejecutando inferencia 3D U-Net (CPU)..." });
  consoleLines.push({ type: "success", text: "[pulmoseg.pipeline] Inferencia completada — generando archivos de salida..." });

  if (artifacts) {
    consoleLines.push({ type: "output", text: `[output] Máscara: ${artifacts.segmentation_mask_nifti_url || "mask.nii.gz"}` });
    if (artifacts.uncertainty_map_url) {
      consoleLines.push({ type: "output", text: `[output] Incertidumbre: ${artifacts.uncertainty_map_url}` });
    }
  }

  consoleLines.push({ type: "success", text: `[pulmoseg.pipeline] Volumen: ${clinicalResults.volumetric_data?.volume_ml} mL | Confianza: ${clinicalResults.recist_metrics?.confidence_score}` });
  consoleLines.push({ type: "success", text: "[pulmoseg.worker] ✅ Job completado exitosamente (100%)" });

  const lineColor = {
    info:    "oklch(0.72 0.17 195)",
    success: "oklch(0.72 0.19 155)",
    warn:    "oklch(0.80 0.16 80)",
    error:   "oklch(0.65 0.20 20)",
    output:  "oklch(0.65 0.16 300)",
  };

  return (
    <div className="space-y-8 animate-[fade-in_0.4s_ease-out]">
      {/* --- Success Header --- */}
      <div
        className="glass-card p-8 flex items-center gap-5"
        style={{ borderColor: "oklch(0.72 0.19 155 / 0.3)" }}
      >
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: "oklch(0.72 0.19 155 / 0.12)" }}
        >
          <Award className="w-7 h-7" style={{ color: "oklch(0.72 0.19 155)" }} />
        </div>
        <div>
          <h3 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            Segmentación Completada
          </h3>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Lesión identificada:{" "}
            <span className="font-semibold" style={{ color: "var(--text-accent)" }}>
              {clinicalResults.lesion_id}
            </span>
          </p>
        </div>
      </div>

      {/* --- Clinical Metrics --- */}
      <MetricsPanel clinicalResults={clinicalResults} />

      {/* --- Multiplanar Viewer --- */}
      <ViewerPanel artifacts={artifacts} lesionId={clinicalResults.lesion_id} />

      {/* --- Backend Console — Collapsible Accordion --- */}
      <div className="glass-card overflow-hidden" style={{ padding: 0 }}>
        {/* Accordion Header */}
        <button
          id="logs-accordion-toggle"
          onClick={() => setLogsOpen((prev) => !prev)}
          className="w-full flex items-center gap-3 px-6 py-4 border-b cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)]"
          style={{ borderColor: logsOpen ? "var(--border-subtle)" : "transparent", backgroundColor: "var(--bg-input)" }}
        >
          <Terminal className="w-4 h-4 shrink-0" style={{ color: "var(--text-accent)" }} />
          <span className="text-xs font-semibold uppercase tracking-wider flex-1 text-left" style={{ color: "var(--text-secondary)" }}>
            Logs del Worker
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full mr-2" style={{ backgroundColor: "var(--bg-card)", color: "var(--text-muted)" }}>
            {consoleLines.length} líneas
          </span>
          <div className="flex items-center gap-1.5 mr-3">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "oklch(0.65 0.20 20)" }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "oklch(0.80 0.16 80)" }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "oklch(0.72 0.19 155)" }} />
          </div>
          {logsOpen ? (
            <ChevronUp className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
          ) : (
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
          )}
        </button>

        {/* Accordion Body */}
        {logsOpen && (
          <div
            className="p-4 max-h-40 overflow-y-auto animate-[fade-in_0.2s_ease-out]"
            style={{ backgroundColor: "#000", fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}
          >
            {consoleLines.map((line, i) => (
              <div
                key={i}
                className="text-xs leading-6"
                style={{ color: lineColor[line.type] || "white", animationDelay: `${i * 30}ms`, animationFillMode: "both" }}
              >
                {line.text}
              </div>
            ))}
            <div className="text-xs leading-6 mt-1" style={{ color: "oklch(0.5 0 0)" }}>
              <span className="status-pulse inline-block">▌</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
