import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  FileText, Search, Eye, Download, Loader, AlertTriangle,
  RefreshCw, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight,
} from "lucide-react";
import { listJobs } from "@/api/client";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const STATUS_STYLES = {
  COMPLETED:  { label: "Completado",  color: "oklch(0.72 0.19 155)", bg: "oklch(0.72 0.19 155 / 0.1)" },
  FAILED:     { label: "Error",       color: "oklch(0.65 0.20 20)",  bg: "oklch(0.65 0.20 20 / 0.1)"  },
  PROCESSING: { label: "Procesando",  color: "oklch(0.72 0.17 195)", bg: "oklch(0.72 0.17 195 / 0.1)" },
  QUEUED:     { label: "En Cola",     color: "oklch(0.80 0.16 80)",  bg: "oklch(0.80 0.16 80 / 0.1)"  },
  CANCELLED:  { label: "Cancelado",   color: "oklch(0.55 0.05 260)", bg: "oklch(0.55 0.05 260 / 0.1)" },
};

const PAGE_SIZE_OPTIONS = [10, 25, 50];

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
// Paginador — renderiza los botones de páginas con ventana deslizante
// ---------------------------------------------------------------------------
function Paginator({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;

  // Ventana: siempre muestra hasta 5 páginas alrededor de la actual
  const delta = 2;
  const range = [];
  const rangeWithDots = [];

  for (let i = Math.max(2, page - delta); i <= Math.min(totalPages - 1, page + delta); i++) {
    range.push(i);
  }

  // Primera página
  rangeWithDots.push(1);

  if (range[0] > 2) rangeWithDots.push("…");
  range.forEach((p) => rangeWithDots.push(p));
  if (range[range.length - 1] < totalPages - 1) rangeWithDots.push("…");

  if (totalPages > 1) rangeWithDots.push(totalPages);

  const btnBase = [
    "flex items-center justify-center min-w-[2rem] h-8 px-1.5 rounded text-xs font-medium",
    "border transition-all duration-150 cursor-pointer select-none",
  ].join(" ");

  const btnActive = { backgroundColor: "#22d3ee", borderColor: "#22d3ee", color: "oklch(0.13 0.01 260)" };
  const btnNormal = { borderColor: "var(--border-subtle)", color: "var(--text-secondary)", backgroundColor: "var(--bg-input)" };
  const btnDisabled = { borderColor: "var(--border-subtle)", color: "var(--text-muted)", backgroundColor: "transparent", opacity: 0.4, cursor: "not-allowed" };

  return (
    <div className="flex items-center gap-1">
      {/* << First */}
      <button
        className={btnBase}
        style={page === 1 ? btnDisabled : btnNormal}
        disabled={page === 1}
        onClick={() => onPage(1)}
        title="Primera página"
      >
        <ChevronFirst className="w-3.5 h-3.5" />
      </button>

      {/* < Prev */}
      <button
        className={btnBase}
        style={page === 1 ? btnDisabled : btnNormal}
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        title="Página anterior"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>

      {/* Page numbers */}
      {rangeWithDots.map((p, i) =>
        p === "…" ? (
          <span
            key={`dots-${i}`}
            className="flex items-center justify-center w-8 h-8 text-xs select-none"
            style={{ color: "var(--text-muted)" }}
          >
            ···
          </span>
        ) : (
          <button
            key={p}
            className={btnBase}
            style={p === page ? btnActive : btnNormal}
            onClick={() => onPage(p)}
          >
            {p}
          </button>
        )
      )}

      {/* > Next */}
      <button
        className={btnBase}
        style={page === totalPages ? btnDisabled : btnNormal}
        disabled={page === totalPages}
        onClick={() => onPage(page + 1)}
        title="Página siguiente"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>

      {/* >> Last */}
      <button
        className={btnBase}
        style={page === totalPages ? btnDisabled : btnNormal}
        disabled={page === totalPages}
        onClick={() => onPage(totalPages)}
        title="Última página"
      >
        <ChevronLast className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------
/**
 * HistoryView — Historial paginado de estudios de segmentación.
 *
 * Paginación server-side real usando skip/limit del endpoint GET /jobs.
 * Soporta búsqueda debounced por patient_pseudo_id.
 *
 * @param {object}   props
 * @param {function} props.onViewJob - Callback(jobId) al pulsar "Ver Detalle"
 */
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

  // Re-fetch cuando cambia búsqueda (reset a pág 1) o página/pageSize
  useEffect(() => {
    fetchJobs(debouncedSearch, page, pageSize);
  }, [debouncedSearch, page, pageSize, fetchJobs]);

  // Al cambiar búsqueda volvemos a página 1
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  // Al cambiar tamaño de página volvemos a página 1
  const handlePageSize = (size) => {
    setPageSize(size);
    setPage(1);
  };

  // ── Helpers de formato ───────────────────────────────────────────────────
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

  // Primeros 8 chars del UUID + indicador del segmento #2 para legibilidad
  // Ejemplo: "33fec9de" → muestra "33fec9de" con tooltip del UUID completo
  function shortId(jobId) {
    if (!jobId) return "—";
    const parts = jobId.split("-");
    // Muestra los primeros dos segmentos: "33fec9de-1a2b" para más contexto
    return parts.slice(0, 2).join("-");
  }

  // ── Rango de filas mostradas ─────────────────────────────────────────────
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow  = Math.min(page * pageSize, total);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto space-y-5 animate-[fade-in_0.4s_ease-out]">

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
          {/* Refrescar */}
          <button
            id="history-refresh-btn"
            onClick={() => fetchJobs(debouncedSearch, page, pageSize)}
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
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{error}</p>
          </div>
        </div>
      )}

      {/* ── Tabla ──────────────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden" style={{ padding: 0 }}>

        {/* Sub-header: selector de filas + info de página */}
        <div
          className="flex items-center justify-between px-5 py-2.5 border-b"
          style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
        >
          {/* "Mostrar X entradas" */}
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Mostrar</span>
            <select
              id="history-page-size"
              value={pageSize}
              onChange={(e) => handlePageSize(Number(e.target.value))}
              className="text-xs rounded px-2 py-1 border outline-none cursor-pointer"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--bg-card)",
                color: "var(--text-primary)",
              }}
            >
              {PAGE_SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>entradas</span>
          </div>

          {/* Info de rango */}
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {loading
              ? "Cargando..."
              : total === 0
              ? "Sin registros"
              : `Mostrando ${firstRow}–${lastRow} de ${total} registros`}
          </span>
        </div>

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

              {/* Cargando */}
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
                          : "No hay estudios registrados aún."}
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {/* Filas */}
              {!loading && jobs.map((row, i) => {
                const st = STATUS_STYLES[row.status] ?? STATUS_STYLES.FAILED;
                const isCompleted = row.status === "COMPLETED";
                const sid = shortId(row.job_id);

                return (
                  <tr
                    key={row.job_id}
                    className={cn(
                      "border-b transition-colors duration-150",
                      "hover:bg-[var(--bg-card-hover)]",
                      "animate-[fade-in_0.25s_ease-out]"
                    )}
                    style={{
                      borderColor: "var(--border-subtle)",
                      animationDelay: `${i * 30}ms`,
                      animationFillMode: "both",
                    }}
                  >
                    {/* ── ID Estudio ── */}
                    <td className="px-5 py-3.5">
                      <div
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg"
                        style={{
                          backgroundColor: "var(--bg-card)",
                          border: "1px solid var(--border-subtle)",
                        }}
                        title={`UUID completo: ${row.job_id}`}
                      >
                        {/* Punto de color indicador */}
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: st.color }}
                        />
                        <span
                          className="text-xs font-mono font-semibold tracking-tight"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {sid}
                        </span>
                      </div>
                    </td>

                    {/* ── Paciente ── */}
                    <td className="px-5 py-3.5">
                      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                        {row.patient_pseudo_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </span>
                    </td>

                    {/* ── Archivos ── */}
                    <td className="px-5 py-3.5">
                      <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>
                        {row.file_count != null ? `${row.file_count} dcm` : "—"}
                      </span>
                    </td>

                    {/* ── Fecha ── */}
                    <td className="px-5 py-3.5">
                      <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                        {fmtDate(row.created_at)}
                      </span>
                      <br />
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {fmtTime(row.created_at)}
                      </span>
                    </td>

                    {/* ── Estado ── */}
                    <td className="px-5 py-3.5">
                      <span
                        className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{ backgroundColor: st.bg, color: st.color }}
                      >
                        {st.label}
                      </span>
                    </td>

                    {/* ── Volumen ── */}
                    <td className="px-5 py-3.5">
                      {row.volume_ml != null
                        ? <span className="text-sm font-mono font-medium" style={{ color: "var(--text-primary)" }}>
                            {row.volume_ml.toFixed(2)}
                          </span>
                        : <span className="text-sm" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* ── Diámetro ── */}
                    <td className="px-5 py-3.5">
                      {row.longest_diameter_mm != null
                        ? <span className="text-sm font-mono font-medium" style={{ color: "var(--text-primary)" }}>
                            {row.longest_diameter_mm.toFixed(1)}
                          </span>
                        : <span className="text-sm" style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>

                    {/* ── Acciones ── */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
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
                          title={isCompleted ? "Cargar en el visor" : "Solo para estudios completados"}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Ver Detalle
                        </button>

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
                          title={isCompleted ? "Descargar NIfTI" : "Solo para estudios completados"}
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

        {/* ── Footer con paginador ──────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-5 py-3 border-t"
          style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}
        >
          {/* Info total + páginas */}
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {loading
              ? "Cargando..."
              : total === 0
              ? "Sin registros"
              : `${totalPages} página${totalPages !== 1 ? "s" : ""} · ${total} registros en total`}
          </span>

          {/* Botones de paginación */}
          <Paginator page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      </div>
    </div>
  );
}
