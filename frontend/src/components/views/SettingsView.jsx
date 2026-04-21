import { Settings, Cpu, Brain, Database, Server, Shield, Layers } from "lucide-react";

const SECTIONS = [
  {
    title: "Arquitectura del Modelo",
    icon: Brain,
    color: "oklch(0.72 0.17 195)",
    bgColor: "oklch(0.72 0.17 195 / 0.12)",
    items: [
      { label: "Arquitectura", value: "nnU-Net (3D U-Net)" },
      { label: "Variante", value: "3d_fullres" },
      { label: "Framework", value: "PyTorch 2.2.0 + nnU-Net v2" },
      { label: "Modalidad", value: "CT (Tomografía Computarizada)" },
      { label: "Región Anatómica", value: "Pulmón — Nódulos / Lesiones" },
    ],
  },
  {
    title: "Preprocesamiento",
    icon: Layers,
    color: "oklch(0.80 0.16 80)",
    bgColor: "oklch(0.80 0.16 80 / 0.12)",
    items: [
      { label: "Pipeline", value: "Automático (nnU-Net pipeline)" },
      { label: "Remuestreo", value: "Isotrópico adaptativo" },
      { label: "Normalización", value: "Z-score por instancia" },
      { label: "Ventana Hounsfield", value: "[-1000, +400] HU" },
      { label: "Crop Strategy", value: "Foreground bounding box" },
    ],
  },
  {
    title: "Inferencia",
    icon: Cpu,
    color: "oklch(0.72 0.19 155)",
    bgColor: "oklch(0.72 0.19 155 / 0.12)",
    items: [
      { label: "Dispositivo", value: "CPU (modo local / desarrollo)" },
      { label: "Patch Size", value: "[64, 64, 64] (configurable)" },
      { label: "Sliding Window Overlap", value: "50% (nnU-Net default)" },
      { label: "Postprocesamiento", value: "Largest connected component" },
      { label: "Umbral de Confianza", value: "0.50 (sigmoid)" },
    ],
  },
  {
    title: "Infraestructura Local",
    icon: Server,
    color: "oklch(0.65 0.16 300)",
    bgColor: "oklch(0.65 0.16 300 / 0.12)",
    items: [
      { label: "API Gateway", value: "FastAPI 0.110.0 + Uvicorn" },
      { label: "Base de Datos", value: "SQLite 3 (SQLAlchemy ORM)" },
      { label: "Almacenamiento", value: "Filesystem local (simula GCS)" },
      { label: "Orquestación", value: "BackgroundTasks (simula Pub/Sub)" },
      { label: "Formato de Salida", value: "NIfTI (.nii.gz)" },
    ],
  },
];

export default function SettingsView() {
  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-[fade-in_0.4s_ease-out]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}>
          <Settings className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
        </div>
        <div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Parámetros del Sistema</h3>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Configuración actual del pipeline de segmentación</p>
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
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>PulmoSeg 3D — Entorno de Desarrollo Local</span>
        </div>
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>v1.0.0-local</span>
      </div>
    </div>
  );
}
