import { Beaker, Ruler, Target, Cpu, Info } from "lucide-react";

function getDuration(stateHistory, fromState, toState) {
  const from = stateHistory?.find((e) => e.state === fromState);
  const to   = stateHistory?.find((e) => e.state === toState);
  if (!from || !to) return null;
  return (new Date(to.time) - new Date(from.time)) / 1000;
}
function fmtSec(s) {
  if (s === null || s === undefined) return "—";
  return `${s.toFixed(1)}s`;
}

// ─── Metric Cell ─────────────────────────────────────────────────────────────
function MetricCell({ Icon, label, value, unit, sub, color, bg, tooltip }) {
  return (
    <div className="flex flex-col justify-between p-4 rounded-xl flex-1 shrink-0 min-w-[200px] relative" style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-subtle)", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: bg }}>
          <Icon style={{ color, width: "0.875rem", height: "0.875rem" }} />
        </div>
        <h4 className="text-xs font-bold uppercase tracking-wider truncate" style={{ color: "var(--text-muted)" }}>{label}</h4>
        
        {tooltip && (
          <div className="ml-auto relative flex items-center justify-center">
            <Info className="w-3.5 h-3.5 text-[var(--text-muted)] cursor-help hover:text-[var(--text-primary)] transition-colors peer" />
            <div 
              className="absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 w-64 p-4 rounded-xl text-[13px] leading-relaxed font-medium shadow-2xl opacity-0 scale-95 peer-hover:opacity-100 peer-hover:scale-100 transition-all pointer-events-none z-[100] origin-top" 
              style={{ backgroundColor: "var(--bg-sidebar)", color: "var(--text-primary)", border: "1px solid var(--border-subtle)" }}
            >
              {tooltip}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 w-2 h-2 -mb-[1px] border-t border-l transform rotate-45" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-sidebar)" }}></div>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-black tracking-tighter truncate" style={{ color }}>{value}</span>
          <span className="text-sm font-bold" style={{ color: "var(--text-muted)" }}>{unit}</span>
        </div>
        {sub ? (
          <p className="text-xs font-medium mt-1 truncate" style={{ color: "var(--text-secondary)" }}>{sub}</p>
        ) : (
          <div className="h-4 mt-1"></div>
        )}
      </div>
    </div>
  );
}

// ─── MetricsBar ───────────────────────────────────────────────────────────────
export default function MetricsBar({ clinicalResults, patientId, stateHistory, onCloseStudy }) {
  const { volumetric_data, recist_metrics } = clinicalResults;
  const totalTime = getDuration(stateHistory, "QUEUED", "COMPLETED");
  const procTime  = getDuration(stateHistory, "PROCESSING", "COMPLETED");

  const volMl  = volumetric_data?.volume_ml;
  const volMm3 = volumetric_data?.volume_mm3;
  const dLong  = recist_metrics?.longest_diameter_mm;
  const conf   = recist_metrics?.confidence_score;
  const plane  = recist_metrics?.measurement_plane;

  const confLabel = conf == null ? null
    : conf >= 0.9 ? "Alta confianza"
    : conf >= 0.7 ? "Confianza moderada"
    : "Revisar manualmente";

  return (
    <div
      className="flex flex-wrap items-center shrink-0 px-4 py-4 gap-3 relative z-[100]"
      style={{
        backgroundColor: "var(--bg-app)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div className="flex flex-wrap flex-1 gap-3 pb-1 md:pb-0">
        <MetricCell
          Icon={Beaker}
          label="Volumen del Nódulo"
          value={volMl != null ? volMl.toFixed(2) : "—"}
          unit="mL"
          sub={volMm3 != null ? `${Math.round(volMm3).toLocaleString()} mm³` : undefined}
          color="oklch(0.72 0.17 195)"
          bg="oklch(0.72 0.17 195 / 0.12)"
          tooltip="Representa el volumen tridimensional estimado de la lesión pulmonar segmentada por el modelo."
        />

        <MetricCell
          Icon={Ruler}
          label="Diámetro Mayor (RECIST)"
          value={dLong != null ? dLong.toFixed(1) : "—"}
          unit="mm"
          sub={plane ? `Plano: ${plane}` : undefined}
          color="oklch(0.80 0.16 80)"
          bg="oklch(0.80 0.16 80 / 0.12)"
          tooltip="Medida más larga del nódulo en un plano 2D (criterios RECIST para evaluación de tumores)."
        />

        <MetricCell
          Icon={Target}
          label="Confianza del Modelo"
          value={conf != null ? (conf * 100).toFixed(0) : "—"}
          unit="%"
          sub={confLabel}
          color="oklch(0.72 0.19 155)"
          bg="oklch(0.72 0.19 155 / 0.12)"
          tooltip="Nivel de certeza de la red neuronal de que la región segmentada corresponde a un nódulo real."
        />

        {procTime !== null && (
          <MetricCell
            Icon={Cpu}
            label="Tiempo Inferencia"
            value={procTime.toFixed(1)}
            unit="s"
            sub="Procesamiento IA"
            color="oklch(0.65 0.16 280)"
            bg="oklch(0.65 0.16 280 / 0.12)"
            tooltip="Tiempo neto empleado por la IA en procesar la inferencia de las imágenes."
          />
        )}
      </div>

    </div>
  );
}
