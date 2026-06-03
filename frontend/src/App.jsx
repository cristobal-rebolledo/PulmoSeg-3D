import { useState, useCallback, useEffect, useRef } from "react";
import { ArrowRightLeft, X } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import ResultsDashboard from "@/components/results/ResultsDashboard";
import HistoryView from "@/components/views/HistoryView";
import SettingsView from "@/components/views/SettingsView";
import DicomUploader from "@/components/upload/DicomUploader";
import { createSegmentationJob, cancelJob, getJobStatus, deleteJob } from "@/api/client";
import { clearViewerCache } from "@/components/viewer/DicomCanvasViewer";

/**
 * App — Root component for PulmoSeg 3D Frontend.
 *
 * Orchestrates the full application flow:
 *   1. User selects a DICOM folder via DicomUploader
 *   2. App sends POST /segment to the FastAPI backend
 *   3. useJobPoller polls GET /status/{id} every 3 seconds
 *   4. When COMPLETED, ResultsDashboard displays clinical metrics
 *
 * State management:
 *   - activeView: current sidebar navigation page
 *   - theme: "dark" | "light" (persisted in localStorage)
 *   - jobs: array of tracked segmentation jobs
 *   - activeJobId: currently selected job for result viewing
 */
export default function App() {
  // --- Theme ---
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("pulmoseg-theme");
    return stored || "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
    localStorage.setItem("pulmoseg-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  // --- Navigation ---
  // "viewer" is the default view — right panel always shows the CT viewer or empty state.
  // "history" and "settings" replace the right panel with their respective views.
  const [activeView, setActiveView] = useState("viewer");

  // --- Jobs ---
  const [jobs, setJobs] = useState([]);
  const [activeJobId, setActiveJobId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Stores completed results keyed by jobId so they persist after polling stops
  const [completedResults, setCompletedResults] = useState({});
  const [pendingAction, setPendingAction] = useState(null);

  // --- Sidebar collapsed state (lifted up for layout sync) ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // --- Modal state for DICOM upload ---
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Multi-job polling loop — optimizado para rendimiento
  //
  // Optimizaciones:
  //   1. Intervalos adaptativos: PROCESSING → 3 s, QUEUED → 10 s
  //      (jobs en cola no cambian hasta que el activo termine)
  //   2. Anti-overlap: si un tick tarda más del intervalo, el siguiente
  //      no se lanza hasta que el anterior termine.
  //   3. Batch de actualizaciones: una sola llamada a setJobs por tick
  //      (N re-renders → 1 re-render)
  // ---------------------------------------------------------------------------
  const TERMINAL      = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
  const POLL_FAST_MS  = 3000;  // PROCESSING: inferencia activa
  const POLL_SLOW_MS  = 10000; // QUEUED: esperando en cola serial
  const TICK_TIMER_MS = 1000;  // Resolución del timer

  const jobsRef = useRef(jobs);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  const completedResultsRef = useRef(completedResults);
  useEffect(() => { completedResultsRef.current = completedResults; }, [completedResults]);

  const lastPollRef    = useRef({});   // { jobId: timestamp } — intervalos adaptativos
  const tickRunningRef = useRef(false); // anti-overlap

  useEffect(() => {
    const tick = async () => {
      if (tickRunningRef.current) return; // anti-overlap: no lanzar si ya hay un tick activo

      const now        = Date.now();
      const activeJobs = jobsRef.current.filter((j) => !TERMINAL.has(j.status) && j.status !== "UPLOADING");
      if (activeJobs.length === 0) return;

      // Filtrar solo los jobs cuyo intervalo ya venció
      const jobsToPoll = activeJobs.filter((j) => {
        const lastPoll = lastPollRef.current[j.id] ?? 0;
        const interval = j.status === "PROCESSING" ? POLL_FAST_MS : POLL_SLOW_MS;
        return (now - lastPoll) >= interval;
      });
      if (jobsToPoll.length === 0) return;

      tickRunningRef.current = true;
      jobsToPoll.forEach((j) => { lastPollRef.current[j.id] = now; });

      try {
        const results = await Promise.allSettled(
          jobsToPoll.map((j) =>
            getJobStatus(j.id).then((data) => ({ jobId: j.id, data }))
          )
        );

        // Acumular todas las actualizaciones antes de hacer setState
        const statusUpdates = {}; // { jobId: { status, progress, errorMessage } }
        const completions   = []; // jobs que llegaron a COMPLETED
        const toDelete      = []; // jobs que fallaron por Early Validation

        results.forEach((result) => {
          if (result.status !== "fulfilled") return;
          const { jobId, data } = result.value;
          const apiStatus   = data?.job_info?.status || "UNKNOWN";
          const apiProgress = data?.job_info?.progress_percentage ?? 0;
          const apiError    = data?.error_message || null;
          
          if (apiStatus === "FAILED" && apiError && apiError.includes("DICOM válido")) {
            toDelete.push(jobId);
            setSubmitError(apiError);
            setTimeout(() => setSubmitError(null), 8000); // 8 seconds toast
            deleteJob(jobId).catch((err) => console.error("Error deleting invalid job", err));
            return; // no actualizar estado, lo vamos a borrar
          }

          statusUpdates[jobId] = { status: apiStatus, progress: apiProgress, errorMessage: apiError };
          if (apiStatus === "COMPLETED") completions.push({ jobId, data });
        });

        // Una sola llamada a setJobs → un solo re-render por tick
        if (Object.keys(statusUpdates).length > 0 || toDelete.length > 0) {
          setJobs((prev) =>
            prev
              .map((j) => statusUpdates[j.id] ? { ...j, ...statusUpdates[j.id] } : j)
              .filter((j) => !toDelete.includes(j.id)) // Borrar los inválidos
          );
        }

        // Persistir resultados de jobs completados
        completions.forEach(({ jobId, data }) => {
          const matchedJob = jobsRef.current.find((j) => j.id === jobId);
          setCompletedResults((prev) => ({
            ...prev,
            [jobId]: {
              clinicalResults: data.clinical_results ?? null,
              artifacts:       data.artifacts        ?? null,
              stateHistory:    data.state_history    ?? [],
              patientId:       data.patient_pseudo_id ?? matchedJob?.patientId ?? null,
            },
          }));
          setActiveJobId((current) => current ?? jobId);
        });

      } finally {
        tickRunningRef.current = false;
      }
    };

    const id = setInterval(tick, TICK_TIMER_MS);
    tick();
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // deps vacías — tick accede al estado vía refs

  // --- Submit Handler ---
  const handleSubmit = useCallback(
    async ({ folderName, fileCount, patientId, studyUid, seriesUid, files }) => {
      setIsSubmitting(true);
      setSubmitError(null);

      // 1. Crear un job temporal (optimistic update) para que el usuario vea feedback inmediato
      const tempId = `upload-${Date.now()}`;
      const uploadingJob = {
        id: tempId,
        patientId,
        folderName,
        fileCount,
        status: "UPLOADING", // Nuevo estado temporal
        progress: 0,
        createdAt: new Date().toISOString(),
      };
      
      setJobs((prev) => [uploadingJob, ...prev]);

      // Cerrar el modal inmediatamente para no bloquear la interfaz.
      // El Job aparecerá en el sidebar con estado UPLOADING.
      setIsUploadModalOpen(false);

      try {
        const response = await createSegmentationJob({ files, patientId, studyUid });

        // 2. Reemplazar el job temporal con los datos reales del backend
        setJobs((prev) => prev.map(job => 
          job.id === tempId ? {
            id: response.job_id,
            patientId,
            folderName,
            fileCount,
            status: "QUEUED",
            progress: 0,
            createdAt: new Date().toISOString(),
          } : job
        ));

      } catch (error) {
        setSubmitError(error.message);
        console.error("Error creating segmentation job:", error);
        // Si falla, remover el job temporal para no dejar basura visual
        setJobs((prev) => prev.filter((job) => job.id !== tempId));
      } finally {
        setIsSubmitting(false);
      }
    },
    []
  );

  // --- Select a completed job to view results ---
  const handleSelectJob = useCallback((jobId) => {
    const job = jobs.find((j) => j.id === jobId);
    if (job?.status === "COMPLETED") {
      if (activeJobId && activeJobId !== jobId) {
        setPendingAction({ type: "sidebar", jobId, patientId: job.patientId || "Paciente" });
      } else {
        setActiveJobId(jobId);
        setActiveView("viewer"); // Switch right panel to viewer
      }
    }
  }, [jobs, activeJobId]);

  // --- Cancel a job ---
  const handleCancel = useCallback(async (jobId) => {
    try {
      await cancelJob(jobId);
      setJobs((prev) =>
        prev.map((job) =>
          job.id === jobId ? { ...job, status: "CANCELLED" } : job
        )
      );
    } catch (error) {
      console.error("Error al cancelar el job:", error);
    }
  }, []);

  // --- Close current study and clear memory ---
  const handleCloseStudy = useCallback(() => {
    clearViewerCache();
    setActiveJobId(null);
    setSubmitError(null);
    setActiveView("viewer");
  }, []);

  // --- Load historical results from HistoryView ---
  const handleViewFromHistory = useCallback(async (jobId, patientPseudoId) => {
    if (activeJobId && activeJobId !== jobId) {
      setPendingAction({ type: "history", jobId, patientId: patientPseudoId || `Estudio ${jobId.slice(0, 8)}` });
      return;
    }
    try {
      const data = await getJobStatus(jobId);
      if (data?.clinical_results) {
        setCompletedResults((prev) => ({
          ...prev,
          [jobId]: {
            clinicalResults: data.clinical_results,
            artifacts:       data.artifacts,
            stateHistory:    data.state_history ?? [],
            patientId:       data.patient_pseudo_id ?? null,
          },
        }));
        setActiveJobId(jobId);
        setActiveView("viewer"); // Always navigate to viewer
      }
    } catch (error) {
      console.error("Error cargando resultados históricos:", error);
    }
  }, [activeJobId]);

  // --- Derived state ---
  const selectedJobResults = activeJobId ? (completedResults[activeJobId] ?? null) : null;

  const VIEW_TITLES = {
    viewer:   { 
      title: activeJobId ? `Estudio Clínico: ${selectedJobResults?.patientId || "Desconocido"}` : "Panel de Análisis Clínico", 
      subtitle: activeJobId ? "Resultados de segmentación y volumetría 3D" : "Selecciona un estudio DICOM del panel lateral para visualizar" 
    },
    history:  { title: "Historial de Estudios",        subtitle: "Registros clínicos y segmentaciones anteriores" },
    settings: { title: "Configuración del Sistema",    subtitle: "Ajustes de inferencia IA y arquitectura de modelos" },
  };

  const currentView = VIEW_TITLES[activeView] || VIEW_TITLES["viewer"];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Sidebar — owns dropzone + studies list ── */}
      <Sidebar
        activeView={activeView}
        onNavigate={setActiveView}
        jobs={jobs.map((j) => ({
          ...j,
          volumeMl:   completedResults[j.id]?.clinicalResults?.volumetric_data?.volume_ml   ?? null,
          diameterMm: completedResults[j.id]?.clinicalResults?.recist_metrics?.longest_diameter_mm ?? null,
        }))}
        onNewAnalysis={() => setIsUploadModalOpen(true)}
        activeJobId={activeJobId}
        onSelectJob={handleSelectJob}
        onCancel={handleCancel}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />

      {/* ── Main Panel — always CT viewer or History/Settings ── */}
      <main
        className="flex-1 flex flex-col overflow-hidden transition-all duration-300"
        style={{ marginLeft: sidebarCollapsed ? "80px" : "304px" }}
      >
        <Header
          title={currentView.title}
          subtitle={currentView.subtitle}
          theme={theme}
          onToggleTheme={toggleTheme}
          onCloseStudy={activeView === "viewer" && activeJobId ? handleCloseStudy : null}
        />

        {/* Content area — viewer is always flex/overflow-hidden to fill space */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Viewer: visible when activeView === "viewer" */}
          {activeView === "viewer" && (
            <ResultsDashboard
              key={activeJobId || "empty"}
              jobId={activeJobId}
              patientId={selectedJobResults?.patientId ?? null}
              clinicalResults={selectedJobResults?.clinicalResults ?? null}
              artifacts={selectedJobResults?.artifacts ?? null}
              stateHistory={selectedJobResults?.stateHistory ?? []}
              onCloseStudy={handleCloseStudy}
            />
          )}

          {/* Historial */}
          {activeView === "history" && (
            <div className="flex-1 p-8 overflow-y-auto">
              <HistoryView onViewJob={handleViewFromHistory} />
            </div>
          )}

          {/* Configuración */}
          {activeView === "settings" && (
            <div className="flex-1 p-8 overflow-y-auto">
              <SettingsView />
            </div>
          )}

          {/* Submit error toast */}
          {submitError && (
            <div
              className="absolute top-6 left-1/2 -translate-x-1/2 px-5 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-[fade-in_0.3s_ease-out]"
              style={{
                backgroundColor: "oklch(0.65 0.20 20)",
                color: "white",
                zIndex: 9999,
                maxWidth: "450px",
                width: "max-content"
              }}
            >
              <div className="shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="15" y1="9" x2="9" y2="15"></line>
                  <line x1="9" y1="9" x2="15" y2="15"></line>
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[14px] font-bold leading-snug">
                  {submitError}
                </p>
              </div>
              <button 
                onClick={() => setSubmitError(null)}
                className="opacity-80 hover:opacity-100 transition-opacity p-1 ml-1 rounded-lg shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Confirm Switch Dialog */}
      {pendingAction && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/60 backdrop-blur-md animate-[fade-in_0.2s_ease-out]">
          <div className="glass-card max-w-lg w-full mx-4 border rounded-[28px] shadow-2xl flex flex-col items-center text-center" style={{ padding: "48px", borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-sidebar)" }}>
            <div className="w-20 h-20 rounded-2xl mb-8 flex items-center justify-center" style={{ backgroundColor: "oklch(0.72 0.17 195 / 0.12)", color: "oklch(0.72 0.17 195)", border: "1px solid oklch(0.72 0.17 195 / 0.25)" }}>
              <ArrowRightLeft className="w-10 h-10" strokeWidth={2.5} />
            </div>
            <h3 className="text-3xl font-extrabold tracking-tight mb-6" style={{ color: "var(--text-primary)" }}>Cambiar de Estudio</h3>
            <p className="text-lg leading-loose mb-12" style={{ color: "var(--text-secondary)" }}>
              ¿Deseas cerrar el estudio actual y visualizar los resultados de <strong className="font-bold px-1" style={{ color: "var(--text-accent)" }}>{pendingAction.patientId}</strong>?
            </p>
            <div className="flex w-full gap-5">
              <button
                onClick={() => setPendingAction(null)}
                className="flex-1 py-5 rounded-xl text-lg font-bold transition-all hover:opacity-70"
                style={{ color: "var(--text-primary)", border: "2px solid var(--border-subtle)", backgroundColor: "transparent" }}
              >
                Cancelar
              </button>
              <button
                onClick={async () => {
                  const action = pendingAction;
                  setPendingAction(null);
                  clearViewerCache();
                  
                  if (action.type === "sidebar") {
                    setActiveJobId(action.jobId);
                    setActiveView("viewer");
                  } else if (action.type === "history") {
                    try {
                      const data = await getJobStatus(action.jobId);
                      if (data?.clinical_results) {
                        setCompletedResults((prev) => ({
                          ...prev,
                          [action.jobId]: {
                            clinicalResults: data.clinical_results,
                            artifacts:       data.artifacts,
                            stateHistory:    data.state_history ?? [],
                            patientId:       data.patient_pseudo_id ?? null,
                          },
                        }));
                        setActiveJobId(action.jobId);
                        setActiveView("viewer");
                      }
                    } catch (error) {
                      console.error("Error cargando resultados históricos:", error);
                    }
                  }
                }}
                className="flex-1 py-5 rounded-xl text-lg font-bold transition-all shadow-xl hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0"
                style={{ backgroundColor: "oklch(0.72 0.17 195)", color: "#fff", border: "2px solid oklch(0.62 0.17 195)" }}
              >
                Sí, cambiar estudio
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Upload Modal */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-md animate-[fade-in_0.2s_ease-out]">
          {/* Modal Container */}
          <div className="relative w-full max-w-2xl mx-4 animate-[slide-up_0.3s_ease-out]">
            <DicomUploader onSubmit={handleSubmit} isSubmitting={isSubmitting} onClose={() => setIsUploadModalOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
