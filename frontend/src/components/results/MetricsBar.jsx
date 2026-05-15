import { Beaker, Ruler, Target, Timer, Cpu, User } from "lucide-react";

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
// flex-1 so all three share the space equally
function MetricCell({ id, Icon, label, description, value, unit, sub, color, bg }) {
  return (
    <div
      id={id}
      className="flex-1 flex items-center gap-4 px-6"
      style={{ borderRight: "1px solid var(--border-subtle)" }}
    >
      {/* Icon badge */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ backgroundColor: bg }}
      >
        <Icon style={{ color, width: "1.2rem", height: "1.2rem" }} />
      </div>

      {/* Text */}
      <div className="min-w-0">
        <p
          className="text-xs font-bold uppercase tracking-wider leading-none"
          style={{ color: "var(--text-muted)" }}
        >
          {label}
        </p>
        {description && (
          <p
            className="text-[10px] leading-none mt-1"
            style={{ color: "var(--text-muted)", opacity: 0.65 }}
          >
            {description}
          </p>
        )}
        <p className="text-2xl font-extrabold leading-none mt-2" style={{ color }}>
          {value}
          <span
            className="text-sm font-medium ml-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            {unit}
          </span>
        </p>
        {sub && (
          <p
            className="text-xs leading-none mt-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── MetricsBar ───────────────────────────────────────────────────────────────
export default function MetricsBar({ clinicalResults, patientId, stateHistory }) {
  const { volumetric_data, recist_metrics } = clinicalResults;
  const totalTime = getDuration(stateHistory, "QUEUED", "COMPLETED");
  const procTime  = getDuration(stateHistory, "PROCESSING", "COMPLETED");

  const volMl  = volumetric_data?.volume_ml;
  const volMm3 = volumetric_data?.volume_mm3;
  const dLong  = recist_metrics?.longest_diameter_mm;
  const dPerp  = recist_metrics?.perpendicular_diameter_mm;
  const conf   = recist_metrics?.confidence_score;
  const plane  = recist_metrics?.measurement_plane;

  const confLabel = conf == null ? null
    : conf >= 0.9 ? "Alta confianza"
    : conf >= 0.7 ? "Confianza moderada"
    : "Revisar manualmente";

  return (
    <div
      className="flex items-stretch shrink-0"
      style={{
        height: "76px",
        backgroundColor: "var(--bg-input)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >


      {/* ── Three metric cells — evenly distributed ─────────── */}
      <MetricCell
        id="mb-volume"
        Icon={Beaker}
        label="Volumen del Nódulo"
        description="Tejido segmentado total"
        value={volMl != null ? volMl.toFixed(2) : "—"}
        unit="mL"
        sub={volMm3 != null ? `${Math.round(volMm3).toLocaleString()} mm³` : undefined}
        color="oklch(0.72 0.17 195)"
        bg="oklch(0.72 0.17 195 / 0.12)"
      />

      <MetricCell
        id="mb-diameter"
        Icon={Ruler}
        label="Diámetro Mayor (RECIST)"
        description={dPerp != null ? `Perpendicular: ${dPerp.toFixed(1)} mm` : "Eje largo máximo"}
        value={dLong != null ? dLong.toFixed(1) : "—"}
        unit="mm"
        sub={plane ? `Plano: ${plane}` : undefined}
        color="oklch(0.80 0.16 80)"
        bg="oklch(0.80 0.16 80 / 0.12)"
      />

      <MetricCell
        id="mb-confidence"
        Icon={Target}
        label="Confianza del Modelo"
        description="Certeza de la segmentación IA"
        value={conf != null ? (conf * 100).toFixed(0) : "—"}
        unit="%"
        sub={confLabel}
        color="oklch(0.72 0.19 155)"
        bg="oklch(0.72 0.19 155 / 0.12)"
      />

      {/* ── Timing — fixed right anchor ─────────────────────── */}
      {(totalTime !== null || procTime !== null) && (
        <div
          className="flex flex-col justify-center gap-2 px-6 shrink-0"
          style={{
            borderLeft: "1px solid var(--border-subtle)",
            minWidth: "14rem",
          }}
        >
          {totalTime !== null && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Timer className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  Total
                </span>
              </div>
              <span
                className="text-sm font-mono font-bold"
                style={{ color: "var(--text-secondary)" }}
              >
                {fmtSec(totalTime)}
              </span>
            </div>
          )}
          {procTime !== null && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  Inferencia
                </span>
              </div>
              <span
                className="text-sm font-mono font-bold"
                style={{ color: "var(--text-secondary)" }}
              >
                {fmtSec(procTime)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
