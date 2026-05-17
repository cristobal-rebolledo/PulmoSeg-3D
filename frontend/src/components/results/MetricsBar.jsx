import { Beaker, Ruler, Target, Timer, Cpu, User, X } from "lucide-react";

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
function MetricCell({ Icon, label, value, unit, sub, color, bg }) {
  return (
    <div className="flex flex-col justify-between p-4 rounded-xl flex-1 shrink-0 min-w-[200px]" style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-subtle)", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: bg }}>
          <Icon style={{ color, width: "0.875rem", height: "0.875rem" }} />
        </div>
        <h4 className="text-xs font-bold uppercase tracking-wider truncate" style={{ color: "var(--text-muted)" }}>{label}</h4>
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
      className="flex flex-wrap md:flex-nowrap items-center shrink-0 px-4 py-4 gap-3 relative z-10"
      style={{
        backgroundColor: "var(--bg-app)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div className="flex flex-1 gap-3 overflow-x-auto pb-1 md:pb-0" style={{ scrollbarWidth: "none" }}>
        <MetricCell
          Icon={Beaker}
          label="Volumen del Nódulo"
          value={volMl != null ? volMl.toFixed(2) : "—"}
          unit="mL"
          sub={volMm3 != null ? `${Math.round(volMm3).toLocaleString()} mm³` : undefined}
          color="oklch(0.72 0.17 195)"
          bg="oklch(0.72 0.17 195 / 0.12)"
        />

        <MetricCell
          Icon={Ruler}
          label="Diámetro Mayor (RECIST)"
          value={dLong != null ? dLong.toFixed(1) : "—"}
          unit="mm"
          sub={plane ? `Plano: ${plane}` : undefined}
          color="oklch(0.80 0.16 80)"
          bg="oklch(0.80 0.16 80 / 0.12)"
        />

        <MetricCell
          Icon={Target}
          label="Confianza del Modelo"
          value={conf != null ? (conf * 100).toFixed(0) : "—"}
          unit="%"
          sub={confLabel}
          color="oklch(0.72 0.19 155)"
          bg="oklch(0.72 0.19 155 / 0.12)"
        />
      </div>

      <div className="flex items-stretch gap-3 shrink-0">
        {(totalTime !== null || procTime !== null) && (
          <div className="flex flex-col justify-center gap-3 px-5 py-4 rounded-xl shrink-0 min-w-[160px]" style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-subtle)", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            {totalTime !== null && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Timer className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Total</span>
                </div>
                <span className="text-sm font-mono font-bold" style={{ color: "var(--text-secondary)" }}>{fmtSec(totalTime)}</span>
              </div>
            )}
            {procTime !== null && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Inferencia</span>
                </div>
                <span className="text-sm font-mono font-bold" style={{ color: "var(--text-secondary)" }}>{fmtSec(procTime)}</span>
              </div>
            )}
          </div>
        )}

        {onCloseStudy && (
          <button
            onClick={onCloseStudy}
            className="flex flex-col items-center justify-center gap-1.5 w-[110px] rounded-xl font-bold transition-all hover:brightness-110 hover:-translate-y-0.5 cursor-pointer shrink-0"
            style={{ backgroundColor: "oklch(0.65 0.20 20 / 0.1)", color: "oklch(0.65 0.20 20)", border: "1px solid oklch(0.65 0.20 20 / 0.2)" }}
            title="Cerrar estudio actual"
          >
            <X className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-bold uppercase tracking-widest leading-[1.1] text-center">Cerrar<br/>Estudio</span>
          </button>
        )}
      </div>
    </div>
  );
}
