import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { FileText, Search, Eye, Download, Loader, AlertTriangle, RefreshCw } from "lucide-react";
import { listJobs } from "@/api/client";

// ---------------------------------------------------------------------------
// Constantes de estilo por estado
// ---------------------------------------------------------------------------
const STATUS_STYLES = {
  COMPLETED:  { label: "Completado",  color: "oklch(0.72 0.19 155)", bg: "oklch(0.72 0.19 155 / 0.1)" },
  FAILED:     { label: "Error",       color: "oklch(0.65 0.20 20)",  bg: "oklch(0.65 0.20 20 / 0.1)"  },
  PROCESSING: { label: "Procesando",  color: "oklch(0.72 0.17 195)", bg: "oklch(0.72 0.17 195 / 0.1)" },
  QUEUED:     { label: "En Cola",     color: "oklch(0.80 0.16 80)",  bg: "oklch(0.80 0.16 80 / 0.1)"  },
  CANCELLED:  { label: "Cancelado",   color: "oklch(0.55 0.05 260)", bg: "oklch(0.55 0.05 260 / 0.1)" },
};

// ---------------------------------------------------------------------------
// Debounce hook — evita disparar el fetch por cada tecla en el buscador
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
// Componente principal
// ---------------------------------------------------------------------------
/**
 * HistoryView — Historial dinámico de estudios de segmentación.
 *
 * Obtiene los últimos 100 registros de GET /jobs al montar el componente.
 * Soporta búsqueda en tiempo real (debounce 400ms) por patient_pseudo_id.
 * El botón "Ver Detalle" delega la navegación al handler onViewJob del padre.
 *
 * @param {object} props
 * @param {function} props.onViewJob - Callback(jobId) llamado al pulsar "Ver Detalle"
 */
export default function HistoryView({ onViewJob }) {
  const [jobs,    setJobs]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [search,  setSearch]  = useState("");

  // Valor de búsqueda con debounce de 400ms
  const debouncedSearch = useDebounce(search, 400);

  // Ref para el input — permite hacer foco sin re-renderizar
  const searchRef = useRef(null);

  // ── Fetch de datos ──────────────────────────────────────────────────────
  const fetchJobs = useCallback(async (searchTerm) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listJobs({ limit: 100, search: searchTerm });
      setJobs(data.jobs ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err.message ?? "Error al cargar el historial.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Volver a buscar cada vez que cambia el término con debounce
  useEffect(() => {
    fetchJobs(debouncedSearch);
  }, [debouncedSearch, fetchJobs]);

  // ── Helpers de formato ──────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("es-CL", {
      year: "numeric", month: "short", day: "numeric",
    });
  }
  function fmtTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("es-CL", {
      hour: "2-digit", minute: "2-digit",
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-[fade-in_0.4s_ease-out]">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.1)" }}
          >
            <FileText className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          </div>
          <div>
            <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
              Registros de Segmentación
            </h3>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {loading
                ? "Cargando registros..."
                : `${total} estudio${total !== 1 ? "s" : ""} registrado${total !== 1 ? "s" : ""}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Botón Refrescar */}
          <button
            id="history-refresh-btn"
            onClick={() => fetchJobs(debouncedSearch)}
            disabled={loading}
            className="p-2 rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}
            title="Refrescar historial"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>

          {/* Buscador */}
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg border"
            style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
          >
            <Search className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
            <input
              id="history-search-input"
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por paciente o ID..."
              className="bg-transparent text-sm outline-none w-52"
              style={{ color: "var(--text-primary)" }}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-xs opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--text-muted)" }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div
          className="glass-card p-4 flex items-start gap-3 animate-[fade-in_0.3s_ease-out]"
          style={{ borderColor: "oklch(0.65 0.20 20 / 0.4)", backgroundColor: "oklch(0.65 0.20 20 / 0.06)" }}
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "oklch(0.65 0.20 20)" }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "oklch(0.65 0.20 20)" }}>
              Error al cargar el historial
            </p>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {/* ── Tabla ──────────────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden" style={{ padding: 0 }}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr
                className="border-b"
                style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
              >
                {["ID Estudio", "Paciente", "Archivos", "Fecha", "Estado", "Volumen (mL)", "Diámetro (mm)", "Acciones"].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>

              {/* Estado de carga */}
              {loading && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Loader className="w-6 h-6 animate-spin" style={{ color: "var(--text-accent)" }} />
                      <span className="text-sm" style={{ color: "var(--text-muted)" }}>
                        Cargando registros...
                      </span>
                    </div>
                  </td>
                </tr>
              )}

              {/* Sin resultados */}
              {!loading && !error && jobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="w-8 h-8 opacity-20" style={{ color: "var(--text-muted)" }} />
                      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                        {search
                          ? `No se encontraron estudios para "${search}"`
                          : "No hay estudios registrados aún. Sube tu primer estudio DICOM."}
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Filas de datos */}
              {!loading && jobs.map((row, i) => {
                const st = STATUS_STYLES[row.status] ?? STATUS_STYLES.FAILED;
                const isCompleted = row.status === "COMPLETED";

                // Abreviar job_id para la columna (primeros 8 chars del UUID)
                const shortId = row.job_id.split("-")[0] ?? row.job_id;

                return (
                  <tr
                    key={row.job_id}
                    className={cn(
                      "border-b transition-colors duration-150",
                      "hover:bg-[var(--bg-card-hover)]",
                      "animate-[fade-in_0.3s_ease-out]"
                    )}
                    style={{
                      borderColor: "var(--border-subtle)",
                      animationDelay: `${i * 40}ms`,
                      animationFillMode: "both",
                    }}
                  >
                    {/* ID */}
                    <td className="px-5 py-4">
                      <span
                        className="text-xs font-mono px-2 py-1 rounded"
                        style={{ backgroundColor: "var(--bg-input)", color: "var(--text-accent)" }}
                        title={row.job_id}
                      >
                        {shortId}…
                      </span>
                    </td>

                    {/* Paciente */}
                    <td className="px-5 py-4">
                      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                        {row.patient_pseudo_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </span>
                    </td>

                    {/* Archivos */}
                    <td className="px-5 py-4">
                      <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>
                        {row.file_count != null ? `${row.file_count} dcm` : "—"}
                      </span>
                    </td>

                    {/* Fecha */}
                    <td className="px-5 py-4">
                      <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                        {fmtDate(row.created_at)}
                      </span>
                      <br />
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {fmtTime(row.created_at)}
                      </span>
                    </td>

                    {/* Estado */}
                    <td className="px-5 py-4">
                      <span
                        className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{ backgroundColor: st.bg, color: st.color }}
                      >
                        {st.label}
                      </span>
                    </td>

                    {/* Volumen */}
                    <td className="px-5 py-4">
                      {row.volume_ml != null
                        ? <span className="text-sm font-mono font-medium" style={{ color: "var(--text-primary)" }}>
                            {row.volume_ml.toFixed(2)}
                          </span>
                        : <span className="text-sm" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* Diámetro */}
                    <td className="px-5 py-4">
                      {row.longest_diameter_mm != null
                        ? <span className="text-sm font-mono font-medium" style={{ color: "var(--text-primary)" }}>
                            {row.longest_diameter_mm.toFixed(1)}
                          </span>
                        : <span className="text-sm" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* Acciones */}
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        {/* Ver Detalle */}
                        <button
                          id={`history-view-${row.job_id}`}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                            isCompleted
                              ? "cursor-pointer hover:border-[var(--border-accent)]"
                              : "opacity-40 cursor-not-allowed"
                          )}
                          style={{
                            borderColor: "var(--border-subtle)",
                            color: "var(--text-accent)",
                            backgroundColor: "var(--bg-input)",
                          }}
                          disabled={!isCompleted}
                          onClick={() => isCompleted && onViewJob?.(row.job_id)}
                          title={isCompleted ? "Cargar resultados en el visor" : "Solo disponible para estudios completados"}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Ver Detalle
                        </button>

                        {/* Descargar NIfTI */}
                        <a
                          id={`history-download-${row.job_id}`}
                          href={isCompleted ? `/api/nifti/${row.job_id}` : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            "flex items-center justify-center w-8 h-8 rounded-lg border transition-all",
                            isCompleted
                              ? "cursor-pointer hover:border-[var(--border-accent)]"
                              : "opacity-40 cursor-not-allowed pointer-events-none"
                          )}
                          style={{
                            borderColor: "var(--border-subtle)",
                            color: "var(--text-muted)",
                            backgroundColor: "var(--bg-input)",
                          }}
                          title={isCompleted ? "Descargar máscara NIfTI" : "Solo disponible para estudios completados"}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-5 py-3 border-t"
          style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
        >
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {loading
              ? "Cargando..."
              : `Mostrando ${jobs.length} de ${total} registros`}
          </span>
          {total > 100 && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Mostrando los 100 más recientes · Usa el buscador para filtrar
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
