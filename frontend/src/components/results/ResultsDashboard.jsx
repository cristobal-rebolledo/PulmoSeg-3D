import { useState } from "react";
import MetricsPanel from "./MetricsPanel";
import ViewerPanel from "./ViewerPanel";
import { Award, Terminal, ChevronDown, ChevronUp, Timer, Cpu, FlaskConical, User } from "lucide-react";
import DicomCanvasViewer from "@/components/viewer/DicomCanvasViewer";

/**
 * Calculates duration in seconds between two state labels in stateHistory.
 * Returns null if either state is not found.
 */
function getDuration(stateHistory, fromState, toState) {
  const from = stateHistory?.find((e) => e.state === fromState);
  const to   = stateHistory?.find((e) => e.state === toState);
  if (!from || !to) return null;
  return (new Date(to.time) - new Date(from.time)) / 1000;
}

/** Format seconds → "00.0s" */
function fmtSec(s) {
  if (s === null || s === undefined) return "—";
  return `${s.toFixed(1)}s`;
}

/**
 * ResultsDashboard — Full results panel activated when a job completes.
 *
 * Shows:
 *   1. Success header with lesion ID
 *   2. MetricsPanel (volume, diameter, confidence)
 *   3. DicomCanvasViewer (MPR) when dicom_image_ids are available,
 *      or static ViewerPanel as fallback
 *   4. Backend Console (collapsible accordion — collapsed by default)
 */
export default function ResultsDashboard({ clinicalResults, artifacts, stateHistory, jobId, patientId }) {
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
  consoleLines.push({ type: "info",    text: "[pulmoseg.pipeline] Aplicando preprocesamiento MONAI (Spacingd, ScaleIntensity)..." });
  consoleLines.push({ type: "info",    text: "[pulmoseg.pipeline] Ejecutando inferencia MONAI U-Net 3D (SlidingWindowInferer)..." });
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
          {patientId && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <User className="w-3.5 h-3.5" style={{ color: "var(--text-accent)" }} />
              <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>
                Paciente:
              </span>
              <span
                className="text-sm font-mono font-semibold px-2 py-0.5 rounded"
                style={{
                  color: "var(--text-accent)",
                  backgroundColor: "oklch(0.72 0.17 195 / 0.1)",
                  border: "1px solid oklch(0.72 0.17 195 / 0.2)",
                }}
              >
                {patientId}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* --- Clinical Metrics --- */}
      <MetricsPanel clinicalResults={clinicalResults} />

      {/* --- Processing Time Bar --- */}
      {stateHistory?.length > 0 && (() => {
        const totalTime   = getDuration(stateHistory, "QUEUED",      "COMPLETED");
        const procTime    = getDuration(stateHistory, "PROCESSING",  "COMPLETED");
        const queuedTime  = getDuration(stateHistory, "QUEUED",      "PROCESSING");
        return (
          <div
            className="glass-card animate-[fade-in_0.5s_ease-out]"
            style={{ padding: "1rem 1.25rem", animationDelay: "350ms", animationFillMode: "both" }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Timer className="w-4 h-4" style={{ color: "var(--text-accent)" }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
                Tiempo de Procesamiento
              </span>
              {totalTime !== null && (
                <span
                  className="ml-auto text-xs font-mono font-semibold"
                  style={{ color: "oklch(0.72 0.19 155)" }}
                >
                  Total: {fmtSec(totalTime)}
                </span>
              )}
            </div>

            <div className="flex gap-3">
              {/* Queue wait */}
              <div
                className="flex items-center gap-2 flex-1 rounded-lg px-3 py-2"
                style={{ backgroundColor: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
              >
                <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: "oklch(0.60 0.10 270 / 0.15)" }}>
                  <Timer size={12} style={{ color: "oklch(0.60 0.10 270)" }} />
                </div>
                <div>
                  <p className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>En Cola</p>
                  <p className="text-sm font-mono font-semibold" style={{ color: "oklch(0.60 0.10 270)" }}>
                    {fmtSec(queuedTime)}
                  </p>
                </div>
              </div>

              {/* Inference */}
              <div
                className="flex items-center gap-2 flex-1 rounded-lg px-3 py-2"
                style={{ backgroundColor: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
              >
                <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.15)" }}>
                  <Cpu size={12} style={{ color: "oklch(0.72 0.17 195)" }} />
                </div>
                <div>
                  <p className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>Inferencia + Post-proc.</p>
                  <p className="text-sm font-mono font-semibold" style={{ color: "oklch(0.72 0.17 195)" }}>
                    {fmtSec(procTime)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- Multiplanar Viewer --- */}
      {/* Si el backend proveyó dicom_image_ids, usar el visor DicomCanvasViewer real.
          De lo contrario, mantener el ViewerPanel estático como fallback. */}
      {artifacts?.dicom_image_ids?.length > 0 && jobId ? (
        <DicomCanvasViewer
          jobId={jobId}
          dicomImageIds={artifacts.dicom_image_ids}
        />
      ) : (
        <ViewerPanel artifacts={artifacts} lesionId={clinicalResults.lesion_id} />
      )}

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
