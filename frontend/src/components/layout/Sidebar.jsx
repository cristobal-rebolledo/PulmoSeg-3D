import { useState, useCallback } from "react";
import {
  ClipboardList,
  Settings,
  ChevronLeft,
  ChevronRight,
  Activity,
  Stethoscope,
  ChevronDown,
} from "lucide-react";
import CompactDropzone from "@/components/upload/CompactDropzone";

/**
 * Sidebar — Rediseñado para el layout de dos paneles permanentes.
 *
 * Estructura:
 *   Brand
 *   ─────────────────────────────
 *   CompactDropzone (siempre visible)
 *   ─────────────────────────────
 *   ESTUDIOS (lista de jobs de la sesión)
 *     StudyItem × N (max 5 visibles)
 *     [Ver X más] si hay más de 5
 *   ─────────────────────────────
 *   Nav: Historial de Estudios / Configuración
 *   ─────────────────────────────
 *   Modelo Activo widget
 *   Colapsar panel
 */

// Status visual config for study dots + badges
const STATUS_CFG = {
  COMPLETED:  { dot: "#4ade80",  badge: "Listo",     badgeBg: "#4ade8020" },
  PROCESSING: { dot: "#22d3ee",  badge: null,         badgeBg: "#22d3ee20" }, // uses progress%
  QUEUED:     { dot: "#f59e0b",  badge: "Cola",       badgeBg: "#f59e0b20" },
  FAILED:     { dot: "#f87171",  badge: "Error",      badgeBg: "#f8717120" },
  CANCELLED:  { dot: "#6b7280",  badge: "Cancelado",  badgeBg: "#6b728020" },
  UPLOADING:  { dot: "#a855f7",  badge: "Subiendo",   badgeBg: "#a855f720" },
};

const NAV_ITEMS = [
  { key: "history",  label: "Historial de Estudios", icon: ClipboardList },
  { key: "settings", label: "Configuración",         icon: Settings },
];

const MAX_VISIBLE = 5;

// ─── StudyItem ────────────────────────────────────────────────────────────────
function StudyItem({ job, isActive, onSelect, queuePosition, onCancel }) {
  const [confirming, setConfirming] = useState(false);
  const cfg = STATUS_CFG[job.status] || STATUS_CFG.QUEUED;
  const isCompleted   = job.status === "COMPLETED";
  const isProcessing  = job.status === "PROCESSING";
  const isQueued      = job.status === "QUEUED";
  const isUploading   = job.status === "UPLOADING";
  const isCancellable = isQueued || isProcessing; // No se puede cancelar en frontend puro la subida fácilmente

  const badgeLabel = isProcessing ? `${job.progress ?? 0}%` : cfg.badge;

  let subtitle = "";
  if (isCompleted && job.volumeMl != null) {
    subtitle = `${Number(job.volumeMl).toFixed(1)} mL · ${Number(job.diameterMm).toFixed(1)} mm`;
  } else if (isProcessing) {
    subtitle = `Procesando · ${job.progress ?? 0}%`;
  } else if (isQueued) {
    subtitle = `En cola · posición ${queuePosition}`;
  } else if (isUploading) {
    subtitle = `Transfiriendo archivos...`;
  }

  const handleCancelClick = (e) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
    } else {
      setConfirming(false);
      onCancel?.(job.id);
    }
  };

  return (
    <div style={{
      borderRadius: 12,
      border: `1px solid ${isActive ? "#22d3ee" : "var(--border-subtle)"}`,
      backgroundColor: isActive ? "oklch(0.72 0.17 195 / 0.10)" : "var(--bg-input)",
      overflow: "hidden",
      transition: "border-color 150ms ease, background-color 150ms ease",
    }}>
      {/* ── Clickable study header ── */}
      <button
        onClick={() => isCompleted && onSelect?.(job.id)}
        title={job.patientId || "Paciente"}
        style={{
          width: "100%", display: "flex", flexDirection: "column",
          padding: "10px 12px", border: "none", background: "none",
          cursor: isCompleted ? "pointer" : "default", textAlign: "left",
        }}
        onMouseEnter={(e) => {
          if (isCompleted && !isActive) e.currentTarget.style.backgroundColor = "var(--bg-card-hover)";
        }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
      >
      {/* Top row: dot + name + badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%",
            backgroundColor: cfg.dot, flexShrink: 0,
          }}
        />
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600,
          color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {job.patientId || "Paciente"}
        </span>
        {badgeLabel && (
          <span style={{
            fontSize: 11, fontWeight: 700, flexShrink: 0,
            color: cfg.dot, backgroundColor: cfg.badgeBg,
            padding: "2px 8px", borderRadius: 20,
          }}>
            {badgeLabel}
          </span>
        )}
      </div>

      {/* Subtitle */}
      {subtitle && (
        <p style={{
          fontSize: 11, color: "var(--text-muted)",
          margin: "4px 0 0 16px",
        }}>
          {subtitle}
        </p>
      )}

      {/* Progress bar (PROCESSING / UPLOADING) */}
      {(isProcessing || isUploading) && (
        <div style={{
          marginTop: 7, marginLeft: 16,
          height: 3, borderRadius: 4,
          backgroundColor: "var(--bg-card)", overflow: "hidden",
        }}>
          {isUploading ? (
            <div style={{
              height: "100%", borderRadius: 4,
              width: "100%",
              background: "linear-gradient(90deg, transparent, #a855f7, transparent)",
              animation: "shimmer 1.5s infinite linear",
              backgroundSize: "200% 100%",
            }} />
          ) : (
            <div style={{
              height: "100%", borderRadius: 4,
              width: `${job.progress ?? 0}%`,
              background: "linear-gradient(90deg, #22d3ee, #3b82f6)",
              transition: "width 500ms ease",
            }} />
          )}
        </div>
      )}
      </button>

      {/* ── Cancel button (QUEUED / PROCESSING only) ── */}
      {isCancellable && onCancel && (
        <div style={{ padding: "0 12px 10px", display: "flex", justifyContent: "flex-end" }}>
          <button
            id={`cancel-study-${job.id}`}
            onClick={handleCancelClick}
            title={confirming ? "Haz clic de nuevo para confirmar" : "Cancelar segmentación"}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 8, cursor: "pointer",
              fontSize: 11, fontWeight: 600,
              color: "oklch(0.65 0.20 20)",
              backgroundColor: confirming ? "oklch(0.65 0.20 20 / 0.10)" : "transparent",
              border: `1px solid ${confirming ? "oklch(0.65 0.20 20)" : "oklch(0.65 0.20 20 / 0.35)"}`,
              transition: "all 150ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "oklch(0.65 0.20 20 / 0.15)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = confirming ? "oklch(0.65 0.20 20 / 0.10)" : "transparent"; }}
          >
            ⛔ {confirming ? "¿Confirmar?" : "Cancelar"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
export default function Sidebar({
  activeView,
  onNavigate,
  jobs = [],
  onSubmit,
  isSubmitting,
  activeJobId,
  onSelectJob,
  onCancel,
  collapsed,
  onCollapsedChange,
}) {
  const [expanded, setExpanded] = useState(false);

  const SIDEBAR_W   = 304;
  const SIDEBAR_W_C = 80;
  const PAD_H       = 20;
  const PAD_H_C     = 12;
  const w = collapsed ? SIDEBAR_W_C : SIDEBAR_W;

  // Queue positions (1-indexed among QUEUED jobs)
  const queuedJobs = jobs.filter((j) => j.status === "QUEUED");
  const getQueuePos = (jobId) => queuedJobs.findIndex((j) => j.id === jobId) + 1;

  // Visible jobs in sidebar list (max 5 unless expanded)
  const visibleJobs = expanded ? jobs : jobs.slice(0, MAX_VISIBLE);
  const hiddenCount = jobs.length - MAX_VISIBLE;

  return (
    <aside
      style={{
        position: "fixed",
        left: 0, top: 0, zIndex: 40,
        height: "100vh",
        width: w,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
        transition: "width 300ms ease-in-out",
        overflow: "hidden",
      }}
    >
      {/* ── Brand ──────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: collapsed ? `18px ${PAD_H_C}px` : `18px ${PAD_H}px`,
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        justifyContent: collapsed ? "center" : "flex-start",
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          background: "linear-gradient(135deg, #22d3ee, #3b82f6)",
          boxShadow: "0 4px 20px oklch(0.72 0.17 195 / 0.35)",
        }}>
          <Activity style={{ width: 20, height: 20, color: "white" }} />
        </div>
        {!collapsed && (
          <div style={{ overflow: "hidden" }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", margin: 0, lineHeight: 1.2 }}>
              PulmoSeg 3D
            </h1>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
              Medical Imaging AI
            </p>
          </div>
        )}
      </div>

      {/* ── Scrollable body ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>

        {!collapsed ? (
          <>
            {/* ── Compact Dropzone ─────────────────────────────────────────── */}
            <div style={{ padding: `16px ${PAD_H}px 0` }}>
              <CompactDropzone onSubmit={onSubmit} isSubmitting={isSubmitting} />
            </div>

            {/* ── Divider ──────────────────────────────────────────────────── */}
            <div style={{
              height: 1, margin: `16px ${PAD_H}px 0`,
              backgroundColor: "var(--border-subtle)",
            }} />

            {/* ── Studies list ─────────────────────────────────────────────── */}
            <div style={{ padding: `12px ${PAD_H}px 0` }}>
              <p style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.14em",
                textTransform: "uppercase", color: "var(--text-secondary)",
                margin: "0 0 10px 2px",
              }}>
                ESTUDIOS
              </p>

              {jobs.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "16px 0" }}>
                  Sin estudios en esta sesión
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {visibleJobs.map((job) => (
                    <StudyItem
                      key={job.id}
                      job={job}
                      isActive={job.id === activeJobId}
                      onSelect={onSelectJob}
                      queuePosition={getQueuePos(job.id)}
                      onCancel={onCancel}
                    />
                  ))}

                  {/* Ver X más / Ver menos */}
                  {hiddenCount > 0 && (
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 4, padding: "8px 0", border: "none", background: "none",
                        cursor: "pointer", fontSize: 12, fontWeight: 600,
                        color: "var(--text-accent)",
                      }}
                    >
                      <ChevronDown
                        style={{
                          width: 14, height: 14,
                          transform: expanded ? "rotate(180deg)" : "none",
                          transition: "transform 200ms ease",
                        }}
                      />
                      {expanded ? "Ver menos" : `Ver ${hiddenCount} más`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ── Divider ──────────────────────────────────────────────────── */}
            <div style={{
              height: 1, margin: `16px ${PAD_H}px 0`,
              backgroundColor: "var(--border-subtle)",
            }} />

            {/* ── Nav: Historial + Configuración ───────────────────────────── */}
            <nav style={{ padding: `10px ${PAD_H}px 0` }}>
              <p style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.14em",
                textTransform: "uppercase", color: "var(--text-secondary)",
                margin: "0 0 8px 2px",
              }}>
                SISTEMA
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {NAV_ITEMS.map((item) => {
                  const isActive = activeView === item.key;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      id={`nav-${item.key}`}
                      onClick={() => onNavigate(item.key)}
                      title={item.label}
                      style={{
                        position: "relative",
                        width: "100%",
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "11px 12px",
                        borderRadius: 10, border: "none", cursor: "pointer",
                        fontSize: 14, fontWeight: isActive ? 600 : 500,
                        color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                        backgroundColor: isActive ? "oklch(0.72 0.17 195 / 0.10)" : "transparent",
                        textAlign: "left", transition: "background-color 150ms ease",
                      }}
                      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-card-hover)"; }}
                      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      {isActive && (
                        <span style={{
                          position: "absolute", left: 0,
                          top: "50%", transform: "translateY(-50%)",
                          width: 3, height: 24, borderRadius: "0 4px 4px 0",
                          backgroundColor: "#22d3ee",
                        }} />
                      )}
                      <Icon style={{
                        width: 20, height: 20, flexShrink: 0,
                        color: isActive ? "#22d3ee" : "var(--text-muted)",
                      }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </nav>
          </>
        ) : (
          /* ── Collapsed: icon-only nav ──────────────────────────────────── */
          <nav style={{
            flex: 1, padding: `12px ${PAD_H_C}px`,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
          }}>
            {NAV_ITEMS.map((item) => {
              const isActive = activeView === item.key;
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  id={`nav-${item.key}`}
                  onClick={() => onNavigate(item.key)}
                  title={item.label}
                  style={{
                    position: "relative",
                    width: 48, height: 48,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    borderRadius: 12, border: "none", cursor: "pointer",
                    backgroundColor: isActive ? "oklch(0.72 0.17 195 / 0.10)" : "transparent",
                    transition: "background-color 150ms ease",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-card-hover)"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = isActive ? "oklch(0.72 0.17 195 / 0.10)" : "transparent"; }}
                >
                  {isActive && (
                    <span style={{
                      position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
                      width: 3, height: 24, borderRadius: "0 4px 4px 0", backgroundColor: "#22d3ee",
                    }} />
                  )}
                  <Icon style={{ width: 22, height: 22, color: isActive ? "#22d3ee" : "var(--text-muted)" }} />
                </button>
              );
            })}
          </nav>
        )}

      </div>

      {/* ── Collapse Toggle ─────────────────────────────────────────────────── */}
      <div style={{
        padding: `10px ${collapsed ? PAD_H_C : PAD_H}px 12px`,
        borderTop: "1px solid var(--border-subtle)", flexShrink: 0,
      }}>
        <button
          id="sidebar-toggle"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "Expandir panel" : "Colapsar panel"}
          style={{
            width: "100%",
            display: "flex", alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            gap: 10, padding: "8px 10px", borderRadius: 8,
            border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
            color: "var(--text-secondary)", backgroundColor: "transparent",
            transition: "background-color 150ms ease, color 150ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-card-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          {collapsed
            ? <ChevronRight style={{ width: 18, height: 18 }} />
            : <><ChevronLeft style={{ width: 18, height: 18, flexShrink: 0 }} /><span>Colapsar panel</span></>
          }
        </button>
      </div>
    </aside>
  );
}
