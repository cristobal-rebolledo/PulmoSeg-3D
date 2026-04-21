import {
  Activity,
  CheckCircle2,
  TrendingUp,
  Zap,
  BarChart3,
  ArrowUpRight,
  Upload,
  ArrowRight,
} from "lucide-react";

/**
 * DashboardView — Enterprise KPI dashboard with metrics and weekly chart.
 *
 * @param {object} props
 * @param {number} props.totalJobs     - Total jobs submitted in session
 * @param {number} props.completedJobs - Successfully completed jobs
 * @param {number} props.failedJobs    - Failed jobs
 * @param {function} props.onNavigate  - Navigation callback
 */

// Simulated weekly data for the bar chart
const WEEKLY_DATA = [
  { day: "Lun", count: 3, label: "3 estudios" },
  { day: "Mar", count: 5, label: "5 estudios" },
  { day: "Mié", count: 2, label: "2 estudios" },
  { day: "Jue", count: 7, label: "7 estudios" },
  { day: "Vie", count: 4, label: "4 estudios" },
  { day: "Sáb", count: 1, label: "1 estudio" },
  { day: "Dom", count: 0, label: "0 estudios" },
];

const MAX_BAR_COUNT = Math.max(...WEEKLY_DATA.map((d) => d.count), 1);

export default function DashboardView({
  totalJobs = 0,
  completedJobs = 0,
  failedJobs = 0,
  onNavigate,
}) {
  const successRate =
    totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 98;
  const avgInference = "47.3";

  const KPI_CARDS = [
    {
      id: "kpi-total",
      icon: BarChart3,
      label: "Total de Estudios",
      value: totalJobs > 0 ? totalJobs.toString() : "24",
      change: "+3 esta semana",
      color: "oklch(0.72 0.17 195)",
      bgColor: "oklch(0.72 0.17 195 / 0.1)",
    },
    {
      id: "kpi-success",
      icon: CheckCircle2,
      label: "Tasa de Éxito",
      value: `${successRate}%`,
      change: "+2.1% vs. mes anterior",
      color: "oklch(0.72 0.19 155)",
      bgColor: "oklch(0.72 0.19 155 / 0.1)",
    },
    {
      id: "kpi-inference",
      icon: Zap,
      label: "Tiempo Promedio",
      value: `${avgInference}s`,
      change: "Inferencia por estudio",
      color: "oklch(0.80 0.16 80)",
      bgColor: "oklch(0.80 0.16 80 / 0.1)",
    },
    {
      id: "kpi-active",
      icon: Activity,
      label: "En Procesamiento",
      value: totalJobs - completedJobs - failedJobs > 0
        ? (totalJobs - completedJobs - failedJobs).toString()
        : "0",
      change: "Workers activos",
      color: "oklch(0.65 0.16 300)",
      bgColor: "oklch(0.65 0.16 300 / 0.1)",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-[fade-in_0.4s_ease-out]">
      {/* --- KPI Cards Grid --- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {KPI_CARDS.map((kpi, index) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.id}
              id={kpi.id}
              className="glass-card p-8 animate-[fade-in_0.4s_ease-out]"
              style={{
                animationDelay: `${index * 80}ms`,
                animationFillMode: "both",
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: kpi.bgColor }}
                >
                  <Icon className="w-5 h-5" style={{ color: kpi.color }} />
                </div>
                <ArrowUpRight
                  className="w-4 h-4"
                  style={{ color: "var(--text-muted)" }}
                />
              </div>
              <p
                className="text-xs font-medium uppercase tracking-wider mb-1"
                style={{ color: "var(--text-secondary)" }}
              >
                {kpi.label}
              </p>
              <p
                className="text-4xl font-semibold tracking-tight"
                style={{ color: "var(--text-primary)" }}
              >
                {kpi.value}
              </p>
              <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
                {kpi.change}
              </p>
            </div>
          );
        })}
      </div>

      {/* --- Weekly Chart --- */}
      <div className="glass-card p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}
            >
              <TrendingUp className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
            </div>
            <div>
              <h3
                className="text-base font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                Estudios Procesados
              </h3>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Última semana
              </p>
            </div>
          </div>
          <span
            className="text-xs font-medium px-3 py-1.5 rounded-full"
            style={{
              backgroundColor: "oklch(0.72 0.19 155 / 0.1)",
              color: "oklch(0.72 0.19 155)",
            }}
          >
            22 total
          </span>
        </div>

        {/* Bar Chart (pure CSS) */}
        <div className="flex items-end justify-between gap-3 h-48 px-2">
          {WEEKLY_DATA.map((day, index) => {
            const heightPercent = MAX_BAR_COUNT > 0
              ? (day.count / MAX_BAR_COUNT) * 100
              : 0;

            return (
              <div
                key={day.day}
                className="flex-1 flex flex-col items-center gap-2"
              >
                {/* Count label */}
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {day.count}
                </span>

                {/* Bar */}
                <div className="w-full flex-1 flex items-end">
                  <div
                    className="w-full rounded-t-lg transition-all duration-700 ease-out"
                    style={{
                      height: `${Math.max(heightPercent, 4)}%`,
                      background: day.count > 0
                        ? "linear-gradient(to top, var(--color-accent-600), var(--color-accent-400))"
                        : "var(--bg-input)",
                      animationDelay: `${index * 100}ms`,
                      opacity: day.count === 0 ? 0.3 : 1,
                    }}
                  />
                </div>

                {/* Day label */}
                <span
                  className="text-xs font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  {day.day}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* --- Hero Quick Action Card --- */}
      <div
        className="relative overflow-hidden rounded-2xl min-h-[200px] flex flex-col justify-between p-8 cursor-pointer group"
        style={{
          background: "linear-gradient(135deg, oklch(0.16 0.02 250) 0%, oklch(0.20 0.08 220) 100%)",
          boxShadow: "0 8px 32px oklch(0 0 0 / 0.30), inset 0 1px 0 oklch(1 0 0 / 0.06)",
          border: "1px solid oklch(0.72 0.17 195 / 0.15)",
        }}
        onClick={() => onNavigate?.("new-segmentation")}
      >
        {/* Decorative radial glow */}
        <div
          className="absolute -top-12 -right-12 w-48 h-48 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 195 / 0.12) 0%, transparent 70%)" }}
        />
        <div
          className="absolute -bottom-8 -left-8 w-36 h-36 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, oklch(0.55 0.18 220 / 0.10) 0%, transparent 70%)" }}
        />

        {/* Top row: icon + badge */}
        <div className="flex items-start justify-between relative z-10">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
            style={{
              background: "linear-gradient(135deg, #22d3ee, #3b82f6)",
              boxShadow: "0 4px 16px oklch(0.72 0.17 195 / 0.35)",
            }}
          >
            <Upload className="w-6 h-6 text-white" />
          </div>
          <span
            className="text-[10px] font-bold tracking-widest px-2.5 py-1 rounded-full uppercase"
            style={{
              backgroundColor: "oklch(0.72 0.17 195 / 0.15)",
              color: "#22d3ee",
              border: "1px solid oklch(0.72 0.17 195 / 0.25)",
            }}
          >
            nnU-Net v2
          </span>
        </div>

        {/* Bottom row: headline + button */}
        <div className="flex items-end justify-between gap-4 relative z-10">
          <div>
            <p
              className="text-xl font-bold leading-tight"
              style={{ color: "oklch(0.96 0.005 260)" }}
            >
              Iniciar Nuevo Análisis
            </p>
            <p
              className="text-sm mt-1.5"
              style={{ color: "oklch(0.68 0.01 260)" }}
            >
              Procesa un nuevo estudio CT con el motor nnU-Net v2
            </p>
          </div>

          {/* Primary CTA button */}
          <button
            id="hero-cta-new-analysis"
            className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 group-hover:scale-105 group-hover:shadow-lg"
            style={{
              backgroundColor: "#22d3ee",
              color: "oklch(0.13 0.01 260)",
              boxShadow: "0 4px 16px oklch(0.72 0.17 195 / 0.40)",
            }}
          >
            Comenzar
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
