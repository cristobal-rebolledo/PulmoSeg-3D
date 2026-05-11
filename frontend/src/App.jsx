import { useState, useCallback, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import DicomUploader from "@/components/upload/DicomUploader";
import JobMonitor from "@/components/jobs/JobMonitor";
import ResultsDashboard from "@/components/results/ResultsDashboard";
import HistoryView from "@/components/views/HistoryView";
import SettingsView from "@/components/views/SettingsView";
import { createSegmentationJob, cancelJob, getJobStatus } from "@/api/client";
import { useJobPoller } from "@/hooks/useJobPoller";

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
  const [activeView, setActiveView] = useState("new-segmentation");

  // --- Jobs ---
  const [jobs, setJobs] = useState([]);
  const [activeJobId, setActiveJobId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Stores completed results keyed by jobId so they persist after polling stops
  const [completedResults, setCompletedResults] = useState({});

  // --- Sidebar collapsed state (lifted up for layout sync) ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // --- Polling for the active job ---
  // We poll the most recently added non-terminal job
  const pollingJobId = jobs.find(
    (j) => j.status === "QUEUED" || j.status === "PROCESSING"
  )?.id || null;

  const {
    status: polledStatus,
    progress: polledProgress,
    clinicalResults,
    artifacts,
    stateHistory,
    polledJobId,
  } = useJobPoller(pollingJobId, 3000);

  // Update job in list when poller returns new data
  useEffect(() => {
    // Guard: only apply updates when the poller's data matches the job we're tracking.
    // Without this, stale "COMPLETED" data from a previous job can bleed into a new job
    // due to async React state updates (race condition).
    if (!pollingJobId || !polledStatus || polledJobId !== pollingJobId) return;

    setJobs((prev) =>
      prev.map((job) =>
        job.id === pollingJobId
          ? { ...job, status: polledStatus, progress: polledProgress }
          : job
      )
    );

    // When job completes, persist results in state and auto-select it
    if (polledStatus === "COMPLETED") {
      setCompletedResults((prev) => ({
        ...prev,
        [pollingJobId]: { clinicalResults, artifacts, stateHistory },
      }));
      setActiveJobId(pollingJobId);
    }
  }, [pollingJobId, polledJobId, polledStatus, polledProgress, clinicalResults, artifacts, stateHistory]);

  // --- Submit Handler ---
  const handleSubmit = useCallback(
    async ({ folderName, fileCount, patientId, studyUid, seriesUid, files }) => {
      setIsSubmitting(true);
      setSubmitError(null);

      try {
        // Enviar archivos DICOM reales al backend via multipart upload
        const response = await createSegmentationJob({
          files,
          patientId,
          studyUid,
        });

        // Add job to tracked list.
        // IMPORTANT: Always initialize with "QUEUED" regardless of the API response.
        // The POST /segment response status may not be reliable as the initial UI state,
        // and using it caused the "immediately COMPLETED" bug due to stale API data.
        const newJob = {
          id: response.job_id,
          patientId,
          folderName,
          fileCount,
          status: "QUEUED",
          progress: 0,
          createdAt: new Date().toISOString(),
        };

        setJobs((prev) => [newJob, ...prev]);
        setActiveJobId(null); // Reset result view — wait for completion

      } catch (error) {
        setSubmitError(error.message);
        console.error("Error creating segmentation job:", error);
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
      setActiveJobId(jobId);
    }
  }, [jobs]);

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

  // --- Cargar resultados históricos desde el Historial de Estudios ---
  // Llamado cuando el usuario pulsa "Ver Detalle" en HistoryView.
  // 1. Recupera el resultado completo del job desde el backend.
  // 2. Lo persiste en completedResults para que ResultsDashboard lo muestre.
  // 3. Navega a la vista principal.
  const handleViewFromHistory = useCallback(async (jobId) => {
    try {
      const data = await getJobStatus(jobId);
      if (data?.clinical_results) {
        setCompletedResults((prev) => ({
          ...prev,
          [jobId]: {
            clinicalResults: data.clinical_results,
            artifacts:       data.artifacts,
            stateHistory:    data.state_history ?? [],
          },
        }));
        setActiveJobId(jobId);
        setActiveView("new-segmentation");
      }
    } catch (error) {
      console.error("Error cargando resultados históricos:", error);
    }
  }, []);

  // --- Get the selected job's results ---
  // Use persisted completedResults so they remain visible after polling stops.
  const selectedJobResults = activeJobId ? (completedResults[activeJobId] ?? null) : null;

  // --- View Titles ---
  const VIEW_TITLES = {
    "new-segmentation": {
      title: "Nueva Segmentación",
      subtitle: "Sube un estudio DICOM para iniciar el análisis con IA",
    },
    history: { title: "Historial de Estudios", subtitle: "Registros de segmentaciones anteriores" },
    settings: { title: "Configuración del Modelo", subtitle: "Arquitectura nnU-Net y parámetros de inferencia" },
  };

  const currentView = VIEW_TITLES[activeView] || VIEW_TITLES["new-segmentation"];

  return (
    <div className="flex min-h-screen">
      {/* --- Sidebar --- */}
      <Sidebar
        activeView={activeView}
        onNavigate={setActiveView}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />

      {/* --- Main Content --- */}
      <main
        className="flex-1 flex flex-col transition-all duration-300"
        style={{
          marginLeft: sidebarCollapsed ? "5rem" : "18rem",
        }}
      >
        {/* Header */}
        <Header
          title={currentView.title}
          subtitle={currentView.subtitle}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {/* Content Area */}
        <div className="flex-1 p-8 overflow-y-auto">
          {activeView === "new-segmentation" && (
            <div className="max-w-7xl mx-auto space-y-8">
              {/* DICOM Uploader */}
              <DicomUploader
                onSubmit={handleSubmit}
                isSubmitting={isSubmitting}
              />

              {/* Error message */}
              {submitError && (
                <div
                  className="glass-card p-4 border animate-[fade-in_0.3s_ease-out]"
                  style={{
                    borderColor: "oklch(0.65 0.20 20 / 0.4)",
                    backgroundColor: "oklch(0.65 0.20 20 / 0.08)",
                  }}
                >
                  <p className="text-sm" style={{ color: "oklch(0.65 0.20 20)" }}>
                    ❌ Error: {submitError}
                  </p>
                </div>
              )}

              {/* Job Monitor */}
              <JobMonitor
                jobs={jobs}
                activeJobId={activeJobId}
                onSelectJob={handleSelectJob}
                onCancel={handleCancel}
              />

              {/* Results Dashboard */}
              {activeJobId && selectedJobResults?.clinicalResults && (
                <ResultsDashboard
                  jobId={activeJobId}
                  clinicalResults={selectedJobResults.clinicalResults}
                  artifacts={selectedJobResults.artifacts}
                  stateHistory={selectedJobResults.stateHistory}
                />
              )}
            </div>
          )}



          {activeView === "history" && (
            <HistoryView onViewJob={handleViewFromHistory} />
          )}

          {activeView === "settings" && (
            <SettingsView />
          )}
        </div>
      </main>
    </div>
  );
}
