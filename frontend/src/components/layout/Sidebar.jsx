import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  PlusCircle,
  ClipboardList,
  Settings,
  ChevronLeft,
  ChevronRight,
  Activity,
  Plus,
} from "lucide-react";

/**
 * Sidebar — Enterprise Medical AI navigation panel for PulmoSeg 3D.
 *
 * Design principles:
 *   - w-72 (288px) fixed width, clean and spacious
 *   - py-4 px-6 nav items — wide click targets
 *   - Active: subtle bg-blue-50/slate accent + 4px left cyan bar (no heavy black bg)
 *   - Grouped: ANÁLISIS / SISTEMA with mt-8 separation and tracking-widest labels
 *   - hover:bg-slate-50 for non-active items — clear interactivity feedback
 *   - Icons w-6 h-6, text text-[15px] font-medium
 *
 * @param {object}   props
 * @param {string}   props.activeView        - Currently active view key
 * @param {function} props.onNavigate        - Callback when a nav item is clicked
 * @param {boolean}  props.collapsed         - Controlled collapsed state
 * @param {function} props.onCollapsedChange - Toggle collapsed state
 */

const NAV_GROUPS = [
  {
    label: "ANÁLISIS",
    items: [
      { key: "dashboard",        label: "Dashboard",          icon: LayoutDashboard },
      { key: "new-segmentation", label: "Nueva Segmentación", icon: PlusCircle },
    ],
  },
  {
    label: "SISTEMA",
    items: [
      { key: "history",  label: "Historial de Estudios", icon: ClipboardList },
      { key: "settings", label: "Configuración",         icon: Settings },
    ],
  },
];

export default function Sidebar({ activeView, onNavigate, collapsed, onCollapsedChange }) {
  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen flex flex-col",
        "transition-all duration-300 ease-in-out",
        collapsed ? "w-20" : "w-72"
      )}
      style={{
        backgroundColor: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
      }}
    >
      {/* ── Brand ────────────────────────────────────────── */}
      <div
        className={cn(
          "flex items-center gap-3.5 px-6 py-5 border-b shrink-0",
          collapsed && "justify-center px-0"
        )}
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {/* Logo — w-10 h-10 prominent anchor */}
        <div
          className="w-10 h-10 flex items-center justify-center rounded-xl shrink-0"
          style={{
            background: "linear-gradient(135deg, #22d3ee, #3b82f6)",
            boxShadow: "0 4px 20px oklch(0.72 0.17 195 / 0.30)",
          }}
        >
          <Activity className="w-5 h-5 text-white" />
        </div>

        {!collapsed && (
          <div className="animate-[fade-in_0.25s_ease-out] overflow-hidden">
            <h1
              className="text-[15px] font-bold tracking-tight leading-tight"
              style={{ color: "var(--text-primary)" }}
            >
              PulmoSeg 3D
            </h1>
            <p
              className="text-xs font-medium mt-0.5"
              style={{ color: "var(--text-muted)" }}
            >
              Medical Imaging AI
            </p>
          </div>
        )}
      </div>

      {/* ── Primary CTA ──────────────────────────────────── */}
      <div className={cn("px-4 py-3 shrink-0", collapsed && "px-2")}>
        <button
          id="sidebar-cta-new-analysis"
          onClick={() => onNavigate("new-segmentation")}
          className={cn(
            "w-full flex items-center justify-center gap-2 rounded-xl py-2.5 px-4",
            "text-sm font-semibold transition-all duration-200 cursor-pointer",
            "hover:brightness-110 active:scale-95"
          )}
          style={{
            backgroundColor: "#22d3ee",
            color: "oklch(0.13 0.01 260)",
            boxShadow: "0 4px 14px oklch(0.72 0.17 195 / 0.35)",
          }}
          title="Nueva Segmentación"
        >
          <Plus className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Nuevo Análisis</span>}
        </button>
      </div>

      {/* ── Navigation ───────────────────────────────────── */}
      <nav className="flex-1 pt-2 pb-4 overflow-y-auto">
        {NAV_GROUPS.map((group, groupIdx) => (
          <div key={group.label} className={groupIdx > 0 ? "mt-8" : ""}>

            {/* Section label — hidden when collapsed */}
            {!collapsed && (
              <p
                className="text-xs font-bold tracking-widest px-6 mb-1"
                style={{ color: "var(--text-muted)", opacity: 0.6 }}
              >
                {group.label}
              </p>
            )}

            {/* Nav items */}
            <div className="mt-1">
              {group.items.map((item) => {
                const isActive = activeView === item.key;
                const Icon = item.icon;

                return (
                  <button
                    key={item.key}
                    id={`nav-${item.key}`}
                    onClick={() => onNavigate(item.key)}
                    className={cn(
                      "relative w-full flex items-center gap-3.5 transition-all duration-200 cursor-pointer text-left",
                      collapsed ? "justify-center py-4 px-0" : "py-4 px-6",
                      isActive
                        ? "font-semibold"
                        : "font-medium hover:bg-[var(--bg-card-hover)]"
                    )}
                    style={{
                      fontSize: "15px",
                      color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                      backgroundColor: isActive
                        ? "oklch(0.72 0.17 195 / 0.07)"
                        : "transparent",
                    }}
                    title={collapsed ? item.label : undefined}
                  >
                    {/* Active indicator — 4px left cyan bar */}
                    <span
                      className={cn(
                        "absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full transition-all duration-300",
                        isActive ? "h-8 opacity-100" : "h-0 opacity-0"
                      )}
                      style={{ backgroundColor: "#22d3ee" /* cyan-400 */ }}
                    />

                    {/* Icon — w-6 h-6 */}
                    <Icon
                      className={cn(
                        "w-6 h-6 shrink-0 transition-all duration-200",
                        isActive ? "opacity-100" : "opacity-70"
                      )}
                      style={{
                        color: isActive ? "#22d3ee" : "var(--text-muted)",
                      }}
                    />

                    {/* Label */}
                    {!collapsed && (
                      <span className="animate-[fade-in_0.2s_ease-out] truncate">
                        {item.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Collapse Toggle ──────────────────────────────── */}
      <div
        className="px-4 py-4 border-t shrink-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <button
          id="sidebar-toggle"
          onClick={() => onCollapsedChange(!collapsed)}
          className={cn(
            "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl",
            "text-xs font-medium transition-all duration-200 cursor-pointer",
            "hover:bg-[var(--bg-card-hover)]"
          )}
          style={{ color: "var(--text-muted)" }}
          title={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <>
              <ChevronLeft className="w-4 h-4" />
              <span>Colapsar</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
