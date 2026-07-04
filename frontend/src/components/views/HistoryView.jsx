import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  FileText, Search, AlertTriangle,
  RefreshCw, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight,
  Copy, Check, ClipboardList
} from "lucide-react";
import { listJobs } from "@/api/client";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const STATUS_STYLES = {
  COMPLETED:  { label: "Completado",  color: "var(--text-secondary)", dot: "oklch(0.72 0.19 155)", bg: "transparent" },
  FAILED:     { label: "Error",       color: "oklch(0.65 0.20 20)",   dot: "oklch(0.65 0.20 20)", bg: "oklch(0.65 0.20 20 / 0.1)"  },
  PROCESSING: { label: "Procesando",  color: "var(--text-secondary)", dot: "oklch(0.72 0.17 195)", bg: "transparent" },
  QUEUED:     { label: "En Cola",     color: "var(--text-secondary)", dot: "oklch(0.80 0.16 80)", bg: "transparent"  },
  CANCELLED:  { label: "Cancelado",   color: "var(--text-muted)",     dot: "oklch(0.55 0.05 260)", bg: "transparent" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "—";
  const d = iso.endsWith("Z") ? iso : iso + "Z";
  return new Date(d).toLocaleDateString("es-CL", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = iso.endsWith("Z") ? iso : iso + "Z";
  return new Date(d).toLocaleTimeString("es-CL", {
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------
function useDebounce(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Componente Botón de Copiar
// ---------------------------------------------------------------------------
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all active:scale-95"
      title="Copiar ID completo"
    >
      {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Paginador
// ---------------------------------------------------------------------------
function Paginator({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;

  const delta = 2;
  const range = [];
  const rangeWithDots = [];

  for (let i = Math.max(2, page - delta); i <= Math.min(totalPages - 1, page + delta); i++) {
    range.push(i);
  }

  rangeWithDots.push(1);
  if (range[0] > 2) rangeWithDots.push("…");
  range.forEach((p) => rangeWithDots.push(p));
  if (range[range.length - 1] < totalPages - 1) rangeWithDots.push("…");
  if (totalPages > 1) rangeWithDots.push(totalPages);

  const btnBase = "flex items-center justify-center min-w-[2rem] h-8 px-1.5 rounded text-xs font-medium border transition-all duration-150 cursor-pointer select-none";
  const btnActive = { backgroundColor: "#22d3ee", borderColor: "#22d3ee", color: "oklch(0.13 0.01 260)" };
  const btnNormal = { borderColor: "var(--border-subtle)", color: "var(--text-secondary)", backgroundColor: "var(--bg-input)" };
  const btnDisabled = { borderColor: "var(--border-subtle)", color: "var(--text-muted)", backgroundColor: "transparent", opacity: 0.4, cursor: "not-allowed" };

  return (
    <div className="flex items-center gap-1 flex-wrap justify-end">
      <button className={btnBase} style={page === 1 ? btnDisabled : btnNormal} disabled={page === 1} onClick={() => onPage(1)} title="Primera página"><ChevronFirst className="w-3.5 h-3.5" /></button>
      <button className={btnBase} style={page === 1 ? btnDisabled : btnNormal} disabled={page === 1} onClick={() => onPage(page - 1)} title="Página anterior"><ChevronLeft className="w-3.5 h-3.5" /></button>
      {rangeWithDots.map((p, i) =>
        p === "…" ? (
          <span key={`dots-${i}`} className="flex items-center justify-center w-8 h-8 text-xs select-none" style={{ color: "var(--text-muted)" }}>···</span>
        ) : (
          <button key={p} className={btnBase} style={p === page ? btnActive : btnNormal} onClick={() => onPage(p)}>{p}</button>
        )
      )}
      <button className={btnBase} style={page === totalPages ? btnDisabled : btnNormal} disabled={page === totalPages} onClick={() => onPage(page + 1)} title="Página siguiente"><ChevronRight className="w-3.5 h-3.5" /></button>
      <button className={btnBase} style={page === totalPages ? btnDisabled : btnNormal} disabled={page === totalPages} onClick={() => onPage(totalPages)} title="Última página"><ChevronLast className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------
export default function HistoryView({ onViewJob }) {
  const [jobs,     setJobs]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [search,   setSearch]   = useState("");
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(10); 

  const debouncedSearch = useDebounce(search, 400);
  const searchRef = useRef(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ── Fetch server-side ────────────────────────────────────────────────────
  const fetchJobs = useCallback(async (searchTerm, currentPage, size) => {
    setLoading(true);
    setError(null);
    try {
      const skip = (currentPage - 1) * size;
      const data = await listJobs({ skip, limit: size, search: searchTerm });
      setJobs(data.jobs ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err.message ?? "Error al cargar el historial.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs(debouncedSearch, page, pageSize);
  }, [debouncedSearch, page, pageSize, fetchJobs]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow  = Math.min(page * pageSize, total);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1200px] mx-auto px-6 animate-[fade-in_0.4s_ease-out] pb-16 pt-8 flex flex-col gap-10 w-full min-w-0">
      
      {/* ── Encabezado y Buscador ── */}
      <div 
        className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 glass-card px-8 py-6 shadow-sm border rounded-2xl w-full" 
        style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)" }}
      >
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-xl" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}>
            <ClipboardList className="w-7 h-7" style={{ color: "var(--text-accent)" }} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
              Buscador de Estudios
            </h2>
            <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
              Búsqueda e historial de pacientes
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full lg:w-[480px]">
          <div 
            className="flex-1 flex items-center gap-3 px-5 py-3 rounded-xl border transition-all focus-within:border-[var(--text-accent)] focus-within:shadow-[0_0_15px_rgba(34,211,238,0.15)]" 
            style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
          >
            <Search className="w-5 h-5 shrink-0" style={{ color: "var(--text-muted)" }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por ID o paciente..."
              className="bg-transparent text-[15px] outline-none w-full font-medium placeholder:font-normal"
              style={{ color: "var(--text-primary)" }}
            />
            {search && (
              <button onClick={() => setSearch("")} className="opacity-50 hover:opacity-100 transition-opacity p-1">✕</button>
            )}
          </div>
          <button
            onClick={() => fetchJobs(debouncedSearch, page, pageSize)}
            disabled={loading}
            className="p-3 rounded-xl border transition-colors hover:bg-[var(--bg-card-hover)] shrink-0"
            style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
            title="Sincronizar datos"
          >
            <RefreshCw className={cn("w-5 h-5", loading && "animate-spin")} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div
          className="glass-card p-5 flex items-start gap-4 animate-[fade-in_0.3s_ease-out]"
          style={{ borderColor: "oklch(0.65 0.20 20 / 0.4)", backgroundColor: "oklch(0.65 0.20 20 / 0.06)" }}
        >
          <AlertTriangle className="w-6 h-6 shrink-0 mt-0.5" style={{ color: "oklch(0.65 0.20 20)" }} />
          <div>
            <p className="text-base font-bold" style={{ color: "oklch(0.65 0.20 20)" }}>
              Error de conexión
            </p>
            <p className="text-sm mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{error}</p>
          </div>
        </div>
      )}

      {/* ── Tabla Clínica (Minimalista) ──────────────────────────────────────────────────────── */}
      <div 
        className="glass-card shadow-sm border rounded-2xl w-full overflow-hidden" 
        style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)" }}
      >
        {/* Contenedor responsivo con scroll horizontal para monitores pequeños o pantallas divididas */}
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left border-collapse table-fixed min-w-[1100px]">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
                <th className="py-5 pr-4 text-xs font-semibold uppercase text-left" style={{ color: "var(--text-muted)", width: "16%", paddingLeft: "2rem" }}>Paciente</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-left" style={{ color: "var(--text-muted)", width: "12%" }}>Modelo</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-left" style={{ color: "var(--text-muted)", width: "14%" }}>Fecha</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-center" style={{ color: "var(--text-muted)", width: "10%" }}>Imágenes</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-right" style={{ color: "var(--text-muted)", width: "11%" }}>Volumen</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-right" style={{ color: "var(--text-muted)", width: "12%" }}>Diámetro</th>
                <th className="py-5 px-4 text-xs font-semibold uppercase text-center" style={{ color: "var(--text-muted)", width: "13%" }}>Estado</th>
                <th className="py-5 pl-4 text-xs font-semibold uppercase text-center" style={{ color: "var(--text-muted)", width: "12%", paddingRight: "2rem" }}>Acción</th>
              </tr>
            </thead>
            
            <tbody>
              {/* Cargando */}
              {loading && (
                <tr>
                  <td colSpan={8} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <RefreshCw className="w-8 h-8 animate-spin" style={{ color: "var(--text-accent)" }} />
                      <span className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
                        Cargando registros...
                      </span>
                    </div>
                  </td>
                </tr>
              )}

              {/* Sin resultados */}
              {!loading && !error && jobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-20 text-center">
                    <div className="flex flex-col items-center gap-4">
                      <div className="p-4 rounded-full" style={{ backgroundColor: "var(--bg-input)" }}>
                        <FileText className="w-10 h-10 opacity-30" style={{ color: "var(--text-muted)" }} />
                      </div>
                      <p className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>
                        {search ? `No hay resultados para "${search}"` : "La base de datos está vacía."}
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Filas */}
              {!loading && jobs.map((row) => {
                const st = STATUS_STYLES[row.status] ?? STATUS_STYLES.FAILED;
                const isCompleted = row.status === "COMPLETED";

                return (
                  <tr
                    key={row.job_id}
                    className="border-b transition-colors duration-150 hover:bg-[var(--bg-card-hover)]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    {/* Paciente */}
                    <td className="py-4 pr-4 align-middle text-left" style={{ paddingLeft: "2rem" }}>
                      <span className="text-[15px] font-bold" style={{ color: "var(--text-primary)" }}>
                        {row.patient_pseudo_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </span>
                    </td>

                    {/* Modelo */}
                    <td className="px-4 py-4 align-middle text-left">
                      <div className="flex items-center gap-2">
                        <span 
                          className="text-[13px] font-medium" 
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {row.model_name === "lung_tumor" ? "Pulmón" : row.model_name === "spleen" ? "Bazo" : row.model_name || "—"}
                        </span>
                      </div>
                    </td>

                    {/* Fecha */}
                    <td className="px-4 py-4 align-middle text-left">
                      <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{fmtDate(row.created_at)}</div>
                      <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{fmtTime(row.created_at)}</div>
                    </td>

                    {/* Imágenes */}
                    <td className="px-4 py-4 align-middle text-center">
                      <span className="text-[14px] font-mono font-medium inline-block w-full text-center" style={{ color: "var(--text-primary)" }}>
                        {row.file_count != null ? row.file_count : "—"}
                      </span>
                    </td>

                    {/* Volumen */}
                    <td className="px-4 py-4 align-middle text-right">
                      {row.volume_ml != null
                        ? <span className="text-[14px] font-mono font-medium inline-block w-full text-right" style={{ color: "var(--text-primary)" }}>
                            {row.volume_ml.toFixed(1)} <span className="text-[10px] font-sans text-[var(--text-muted)]">mL</span>
                          </span>
                        : <span className="text-sm text-right block w-full" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* Diámetro */}
                    <td className="px-4 py-4 align-middle text-right">
                      {row.longest_diameter_mm != null
                        ? <span className="text-[14px] font-mono font-medium inline-block w-full text-right" style={{ color: "var(--text-primary)" }}>
                            {row.longest_diameter_mm.toFixed(1)} <span className="text-[10px] font-sans text-[var(--text-muted)]">mm</span>
                          </span>
                        : <span className="text-sm text-right block w-full" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-4 align-middle text-center">
                      <span
                        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold mx-auto"
                        style={{ backgroundColor: st.bg, color: st.color }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: st.dot }} />
                        {st.label}
                      </span>
                    </td>

                    {/* Acción */}
                    <td className="py-4 pl-4 align-middle text-center" style={{ paddingRight: "2rem" }}>
                      <button
                        className={cn(
                          "inline-flex items-center justify-center gap-1 text-[13px] font-bold transition-all mx-auto outline-none w-full",
                          isCompleted
                            ? "hover:brightness-125"
                            : "opacity-40 cursor-not-allowed"
                        )}
                        style={isCompleted ? { color: "var(--text-accent)" } : { color: "var(--text-muted)" }}
                        disabled={!isCompleted}
                        onClick={() => isCompleted && onViewJob?.(row.job_id, row.patient_pseudo_id)}
                      >
                        <span className="text-center">Ver Resultados</span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer de la Tabla (Paginador) ──────────────────────────────────────── */}
        {!loading && total > 0 && (
          <div
            className="flex flex-col sm:flex-row items-center justify-between py-5 border-t bg-[var(--bg-card)]"
            style={{ borderColor: "var(--border-subtle)", paddingLeft: "2rem", paddingRight: "2rem" }}
          >
            <span className="text-sm font-medium mb-4 sm:mb-0" style={{ color: "var(--text-muted)" }}>
              Mostrando <span className="font-bold" style={{ color: "var(--text-primary)" }}>{firstRow}</span> a <span className="font-bold" style={{ color: "var(--text-primary)" }}>{lastRow}</span> de <span className="font-bold" style={{ color: "var(--text-primary)" }}>{total}</span>
            </span>
            <Paginator page={page} totalPages={totalPages} onPage={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
