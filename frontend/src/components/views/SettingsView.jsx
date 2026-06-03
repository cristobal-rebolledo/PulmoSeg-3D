import { useState, useEffect } from "react";
import { Settings, Cpu, Brain, Database, Server, Shield, Layers, Loader2 } from "lucide-react";
import { getConfig } from "../../api/client";

export default function SettingsView() {
  const [apiConfig, setApiConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchConfig() {
      try {
        setLoading(true);
        const data = await getConfig();
        setApiConfig(data);
        setError(null);
      } catch (err) {
        setError("Error al cargar la configuración de la API.");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    fetchConfig();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--text-accent)" }} />
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Cargando especificaciones del modelo...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
          <Shield className="w-5 h-5 text-red-500" />
        </div>
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  }

  // Build the sections dynamically based on apiConfig
  const SECTIONS = [
    {
      title: "Arquitectura del Modelo",
      icon: Brain,
      color: "oklch(0.72 0.17 195)",
      bgColor: "oklch(0.72 0.17 195 / 0.12)",
      items: [
        { label: "Nombre", value: apiConfig?.name || "Desconocido" },
        { label: "Red", value: apiConfig?.network_type || "N/A" },
        { label: "Dimensiones", value: `${apiConfig?.spatial_dims}D` },
        { label: "Canales (Out)", value: apiConfig?.out_channels },
        { label: "Normalización", value: apiConfig?.norm || "batch" },
      ],
    },
    {
      title: "Preprocesamiento",
      icon: Layers,
      color: "oklch(0.80 0.16 80)",
      bgColor: "oklch(0.80 0.16 80 / 0.12)",
      items: [
        { label: "Remuestreo (Spacing)", value: `[${apiConfig?.target_spacing?.join(", ")}] mm` },
        { label: "Orientación", value: apiConfig?.orientation || "RAS" },
        { label: "Ventana HU", value: `[${apiConfig?.hu_window_min}, ${apiConfig?.hu_window_max}]` },
      ],
    },
    {
      title: "Inferencia (Sliding Window)",
      icon: Cpu,
      color: "oklch(0.72 0.19 155)",
      bgColor: "oklch(0.72 0.19 155 / 0.12)",
      items: [
        { label: "Tamaño de Parche", value: `[${apiConfig?.roi_size?.join(", ")}]` },
        { label: "Overlap", value: `${(apiConfig?.overlap * 100).toFixed(0)}%` },
        { label: "Batch GPU", value: apiConfig?.sw_batch_size_gpu },
        { label: "Batch CPU", value: apiConfig?.sw_batch_size_cpu },
      ],
    },
    {
      title: "Postprocesamiento",
      icon: Server,
      color: "oklch(0.65 0.16 300)",
      bgColor: "oklch(0.65 0.16 300 / 0.12)",
      items: [
        { label: "Activación", value: apiConfig?.use_softmax ? "Softmax" : "Sigmoid" },
        { label: "Canal Objetivo", value: `Índice ${apiConfig?.foreground_channel}` },
        { label: "Umbral (Threshold)", value: apiConfig?.threshold || "Automático (Argmax)" },
      ],
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-[fade-in_0.4s_ease-out]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}>
          <Settings className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
        </div>
        <div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Especificaciones del Modelo</h3>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Configuración extraída dinámicamente desde el backend API</p>
        </div>
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {SECTIONS.map((section, si) => {
          const Icon = section.icon;
          return (
            <div key={section.title} className="glass-card p-8 animate-[fade-in_0.4s_ease-out]" style={{ animationDelay: `${si * 100}ms`, animationFillMode: "both" }}>
              <div className="flex items-center gap-2.5 mb-5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: section.bgColor }}>
                  <Icon className="w-4 h-4" style={{ color: section.color }} />
                </div>
                <h4 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>{section.title}</h4>
              </div>
              <div className="space-y-0">
                {section.items.map((item, i) => (
                  <div key={item.label} className="flex items-center justify-between py-3 border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                    <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{item.label}</span>
                    <span className="text-sm font-mono font-medium text-right max-w-[55%]" style={{ color: "var(--text-primary)" }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Version footer */}
      <div className="glass-card p-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4" style={{ color: "var(--text-accent)" }} />
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Sincronizado con API en Tiempo Real</span>
        </div>
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>{apiConfig?.name}</span>
      </div>
    </div>
  );
}
