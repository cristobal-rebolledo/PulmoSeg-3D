import { cn } from "@/lib/utils";
import { Clock, Loader2, CheckCircle2, XCircle, User, ChevronRight } from "lucide-react";

/**
 * STATUS_CONFIG — Visual configuration for each job status.
 */
const STATUS_CONFIG = {
  QUEUED: {
    label: "En Cola",
    color: "oklch(0.80 0.16 80)",        // amber
    bgColor: "oklch(0.80 0.16 80 / 0.1)",
    icon: Clock,
    pulse: false,
  },
  PROCESSING: {
    label: "Procesando",
    color: "oklch(0.72 0.17 195)",        // cyan
    bgColor: "oklch(0.72 0.17 195 / 0.1)",
    icon: Loader2,
    pulse: true,
  },
  COMPLETED: {
    label: "Completado",
    color: "oklch(0.72 0.19 155)",        // green
    bgColor: "oklch(0.72 0.19 155 / 0.1)",
    icon: CheckCircle2,
    pulse: false,
  },
  FAILED: {
    label: "Error",
    color: "oklch(0.65 0.20 20)",         // red
    bgColor: "oklch(0.65 0.20 20 / 0.1)",
    icon: XCircle,
    pulse: false,
  },
};

/**
 * JobCard — Individual job card with progress bar and status badge.
 *
 * @param {object} props
 * @param {object}  props.job      - Job object { id, patientId, status, progress }
 * @param {boolean} props.isActive - Whether this card is currently selected
 * @param {function} props.onClick - Click handler
 */
export default function JobCard({ job, isActive, onClick }) {
  const config = STATUS_CONFIG[job.status] || STATUS_CONFIG.QUEUED;
  const StatusIcon = config.icon;

  return (
    <button
      id={`job-card-${job.id}`}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 p-3.5 rounded-xl",
        "border transition-all duration-250 cursor-pointer text-left",
        "hover:border-[var(--border-accent)]",
        isActive && "ring-1"
      )}
      style={{
        borderColor: isActive ? "var(--border-accent)" : "var(--border-subtle)",
        backgroundColor: isActive ? "var(--bg-card-hover)" : "var(--bg-input)",
        ringColor: isActive ? "var(--border-accent)" : undefined,
      }}
    >
      {/* Status icon */}
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: config.bgColor }}
      >
        <StatusIcon
          className={cn(
            "w-5 h-5",
            config.pulse && "animate-spin"
          )}
          style={{
            color: config.color,
            animationDuration: config.pulse ? "1.5s" : undefined,
          }}
        />
      </div>

      {/* Job info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <User className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
            <span
              className="text-sm font-medium truncate"
              style={{ color: "var(--text-primary)" }}
            >
              {job.patientId || "Paciente"}
            </span>
          </div>
          {/* Status badge */}
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold",
              config.pulse && "status-pulse"
            )}
            style={{
              backgroundColor: config.bgColor,
              color: config.color,
            }}
          >
            {config.label}
          </span>
        </div>

        {/* Job ID (truncated) */}
        <p
          className="text-xs mb-2 truncate"
          style={{ color: "var(--text-muted)" }}
        >
          ID: {job.id}
        </p>

        {/* Progress bar */}
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--bg-card)" }}>
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              job.status === "PROCESSING" && "progress-bar-animated"
            )}
            style={{
              width: `${job.progress}%`,
              backgroundColor: job.status !== "PROCESSING" ? config.color : undefined,
            }}
          />
        </div>

        {/* Progress text */}
        <p
          className="text-xs mt-1 text-right"
          style={{ color: "var(--text-muted)" }}
        >
          {job.progress}%
        </p>
      </div>

      {/* Arrow for completed jobs */}
      {job.status === "COMPLETED" && (
        <ChevronRight
          className="w-4 h-4 shrink-0"
          style={{ color: "var(--text-muted)" }}
        />
      )}
    </button>
  );
}
