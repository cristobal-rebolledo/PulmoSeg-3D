import { useState, useCallback, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import DicomUploader from "@/components/upload/DicomUploader";
import JobMonitor from "@/components/jobs/JobMonitor";
import ResultsDashboard from "@/components/results/ResultsDashboard";
import DashboardView from "@/components/views/DashboardView";
import HistoryView from "@/components/views/HistoryView";
import SettingsView from "@/components/views/SettingsView";
import { createSegmentationJob, buildSegmentationPayload } from "@/api/client";
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
  } = useJobPoller(pollingJobId, 3000);

  // Update job in list when poller returns new data
  useEffect(() => {
    if (!pollingJobId || !polledStatus) return;

    setJobs((prev) =>
      prev.map((job) =>
        job.id === pollingJobId
          ? { ...job, status: polledStatus, progress: polledProgress }
          : job
      )
    );

    // Auto-select completed job for results
    if (polledStatus === "COMPLETED") {
      setActiveJobId(pollingJobId);
    }
  }, [pollingJobId, polledStatus, polledProgress]);

  // --- Submit Handler ---
  const handleSubmit = useCallback(
    async ({ folderName, fileCount, patientId, studyUid }) => {
      setIsSubmitting(true);
      setSubmitError(null);

      try {
        const payload = buildSegmentationPayload({
          patientId,
          studyUid,
          fileCount,
        });

        const response = await createSegmentationJob(payload);

        // Add job to tracked list
        const newJob = {
          id: response.job_id,
          patientId,
          folderName,
          fileCount,
          status: response.status,
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

  // --- Get the selected job's results (from the poller) ---
  const selectedJobResults =
    activeJobId === pollingJobId || activeJobId === jobs.find(j => j.status === "COMPLETED")?.id
      ? { clinicalResults, artifacts, stateHistory }
      : null;

  // --- View Titles ---
  const VIEW_TITLES = {
    dashboard: { title: "Dashboard", subtitle: "Resumen general del sistema" },
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
              />

              {/* Results Dashboard */}
              {activeJobId && selectedJobResults?.clinicalResults && (
                <ResultsDashboard
                  clinicalResults={selectedJobResults.clinicalResults}
                  artifacts={selectedJobResults.artifacts}
                  stateHistory={selectedJobResults.stateHistory}
                />
              )}
            </div>
          )}

          {activeView === "dashboard" && (
            <DashboardView
              totalJobs={jobs.length}
              completedJobs={jobs.filter(j => j.status === "COMPLETED").length}
              failedJobs={jobs.filter(j => j.status === "FAILED").length}
              onNavigate={setActiveView}
            />
          )}

          {activeView === "history" && (
            <HistoryView />
          )}

          {activeView === "settings" && (
            <SettingsView />
          )}
        </div>
      </main>
    </div>
  );
}
