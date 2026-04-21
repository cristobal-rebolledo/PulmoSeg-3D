import { cn } from "@/lib/utils";
import { Beaker, Ruler, Target } from "lucide-react";

/**
 * MetricsPanel — Displays 3 clinical metric cards.
 *
 * Metrics shown:
 *   1. Volumen del nódulo (mL)
 *   2. Diámetro mayor (mm)
 *   3. Confianza del modelo (%)
 *
 * @param {object} props
 * @param {object} props.clinicalResults - From API: { volumetric_data, recist_metrics }
 */
export default function MetricsPanel({ clinicalResults }) {
  if (!clinicalResults) return null;

  const { volumetric_data, recist_metrics } = clinicalResults;

  const metrics = [
    {
      id: "metric-volume",
      icon: Beaker,
      label: "Volumen del Nódulo",
      value: volumetric_data?.volume_ml?.toFixed(2) || "—",
      unit: "mL",
      subtext: `${volumetric_data?.volume_mm3?.toFixed(1) || "—"} mm³`,
      color: "oklch(0.72 0.17 195)",
      bgColor: "oklch(0.72 0.17 195 / 0.1)",
    },
    {
      id: "metric-diameter",
      icon: Ruler,
      label: "Diámetro Mayor",
      value: recist_metrics?.longest_diameter_mm?.toFixed(1) || "—",
      unit: "mm",
      subtext: `Perpendicular: ${recist_metrics?.perpendicular_diameter_mm?.toFixed(1) || "—"} mm`,
      color: "oklch(0.80 0.16 80)",
      bgColor: "oklch(0.80 0.16 80 / 0.1)",
    },
    {
      id: "metric-confidence",
      icon: Target,
      label: "Confianza del Modelo",
      value: recist_metrics?.confidence_score
        ? `${(recist_metrics.confidence_score * 100).toFixed(0)}`
        : "—",
      unit: "%",
      subtext: `Plano: ${recist_metrics?.measurement_plane || "—"}`,
      color: "oklch(0.72 0.19 155)",
      bgColor: "oklch(0.72 0.19 155 / 0.1)",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      {metrics.map((metric, index) => {
        const Icon = metric.icon;
        return (
          <div
            key={metric.id}
            id={metric.id}
            className={cn("glass-card p-6 animate-[fade-in_0.4s_ease-out]")}
            style={{ animationDelay: `${index * 100}ms`, animationFillMode: "both" }}
          >
            {/* Icon + Label */}
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: metric.bgColor }}
              >
                <Icon className="w-5 h-5" style={{ color: metric.color }} />
              </div>
              <span
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-secondary)" }}
              >
                {metric.label}
              </span>
            </div>

            {/* Value */}
            <div className="flex items-baseline gap-1.5">
              <span
                className="text-4xl font-semibold tracking-tight"
                style={{ color: metric.color }}
              >
                {metric.value}
              </span>
              <span
                className="text-base font-medium"
                style={{ color: "var(--text-muted)" }}
              >
                {metric.unit}
              </span>
            </div>

            {/* Subtext */}
            <p
              className="text-xs mt-2.5"
              style={{ color: "var(--text-muted)" }}
            >
              {metric.subtext}
            </p>
          </div>
        );
      })}
    </div>
  );
}
