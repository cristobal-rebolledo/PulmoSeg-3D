import { cn } from "@/lib/utils";
import { FileText, Search, Eye, Download } from "lucide-react";

const STATUS_STYLES = {
  COMPLETED: { label: "Completado", color: "oklch(0.72 0.19 155)", bg: "oklch(0.72 0.19 155 / 0.1)" },
  FAILED: { label: "Error", color: "oklch(0.65 0.20 20)", bg: "oklch(0.65 0.20 20 / 0.1)" },
  PROCESSING: { label: "Procesando", color: "oklch(0.72 0.17 195)", bg: "oklch(0.72 0.17 195 / 0.1)" },
};

const MOCK_HISTORY = [
  { id: "req_lidc_0001_v3", patient: "LIDC-IDRI-0001", date: "2026-04-20T18:45:00Z", status: "COMPLETED", volume: 4.15 },
  { id: "req_lidc_0003_v1", patient: "LIDC-IDRI-0003", date: "2026-04-19T14:20:00Z", status: "COMPLETED", volume: 2.87 },
  { id: "req_lidc_0007_v2", patient: "LIDC-IDRI-0007", date: "2026-04-18T09:15:00Z", status: "COMPLETED", volume: 6.42 },
  { id: "req_lidc_0012_v1", patient: "LIDC-IDRI-0012", date: "2026-04-17T16:30:00Z", status: "FAILED", volume: null },
  { id: "req_lidc_0015_v1", patient: "LIDC-IDRI-0015", date: "2026-04-16T11:00:00Z", status: "COMPLETED", volume: 1.23 },
];

export default function HistoryView() {
  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-[fade-in_0.4s_ease-out]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}>
            <FileText className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          </div>
          <div>
            <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Registros de Segmentación</h3>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>{MOCK_HISTORY.length} estudios registrados</p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
          <Search className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
          <input type="text" placeholder="Buscar por paciente o ID..." className="bg-transparent text-sm outline-none w-48" style={{ color: "var(--text-primary)" }} />
        </div>
      </div>

      <div className="glass-card overflow-hidden" style={{ padding: 0 }}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
                {["ID Estudio", "Paciente", "Fecha", "Estado", "Volumen (mL)", "Acciones"].map((h) => (
                  <th key={h} className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MOCK_HISTORY.map((row, i) => {
                const st = STATUS_STYLES[row.status] || STATUS_STYLES.COMPLETED;
                return (
                  <tr key={row.id} className={cn("border-b transition-colors duration-150 hover:bg-[var(--bg-card-hover)] animate-[fade-in_0.3s_ease-out]")} style={{ borderColor: "var(--border-subtle)", animationDelay: `${i * 60}ms`, animationFillMode: "both" }}>
                     <td className="px-5 py-5"><span className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>{row.id}</span></td>
                    <td className="px-5 py-5"><span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{row.patient}</span></td>
                    <td className="px-5 py-5">
                      <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{new Date(row.date).toLocaleDateString("es-CL", { year: "numeric", month: "short", day: "numeric" })}</span>
                      <br /><span className="text-xs" style={{ color: "var(--text-muted)" }}>{new Date(row.date).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</span>
                    </td>
                    <td className="px-5 py-5"><span className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: st.bg, color: st.color }}>{st.label}</span></td>
                    <td className="px-5 py-5">{row.volume !== null ? <span className="text-sm font-mono font-medium" style={{ color: "var(--text-primary)" }}>{row.volume.toFixed(2)} mL</span> : <span className="text-sm" style={{ color: "var(--text-muted)" }}>—</span>}</td>
                    <td className="px-5 py-5">
                      <div className="flex items-center gap-2">
                        <button className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer hover:border-[var(--border-accent)]", row.status !== "COMPLETED" && "opacity-40 cursor-not-allowed")} style={{ borderColor: "var(--border-subtle)", color: "var(--text-accent)", backgroundColor: "var(--bg-input)" }} disabled={row.status !== "COMPLETED"}>
                          <Eye className="w-3.5 h-3.5" />Ver Detalle
                        </button>
                        <button className={cn("flex items-center justify-center w-8 h-8 rounded-lg border transition-all cursor-pointer hover:border-[var(--border-accent)]", row.status !== "COMPLETED" && "opacity-40 cursor-not-allowed")} style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)", backgroundColor: "var(--bg-input)" }} disabled={row.status !== "COMPLETED"} title="Descargar NIfTI">
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Mostrando {MOCK_HISTORY.length} de {MOCK_HISTORY.length} registros</span>
          <button className="w-7 h-7 rounded-md text-xs font-medium flex items-center justify-center" style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}>1</button>
        </div>
      </div>
    </div>
  );
}
