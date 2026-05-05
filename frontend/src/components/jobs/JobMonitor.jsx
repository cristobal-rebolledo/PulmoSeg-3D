import { cn } from "@/lib/utils";
import JobCard from "./JobCard";
import { ListChecks } from "lucide-react";

/**
 * JobMonitor — Displays a list of active/completed segmentation jobs.
 *
 * @param {object} props
 * @param {Array}    props.jobs        - Array of job objects { id, patientId, status, progress, data }
 * @param {string}   props.activeJobId - Currently selected job ID
 * @param {function} props.onSelectJob - Callback when a job card is clicked
 */
export default function JobMonitor({ jobs = [], activeJobId, onSelectJob }) {
  if (jobs.length === 0) {
    return (
      <div className="glass-card p-6 animate-[fade-in_0.4s_ease-out]">
        <div className="flex items-center gap-2 mb-3">
          <ListChecks className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Tareas en Curso
          </h3>
        </div>
        <div className="flex flex-col items-center justify-center py-8">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
            style={{ backgroundColor: "var(--bg-input)" }}
          >
            <ListChecks className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
          </div>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No hay tareas activas
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Sube un estudio DICOM para comenzar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-6 animate-[fade-in_0.4s_ease-out]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ListChecks className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Tareas en Curso
          </h3>
        </div>
        <span
          className="text-xs font-medium px-2 py-1 rounded-full"
          style={{
            backgroundColor: "var(--bg-input)",
            color: "var(--text-secondary)",
          }}
        >
          {jobs.length} {jobs.length === 1 ? "tarea" : "tareas"}
        </span>
      </div>

      <div className="space-y-3">
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            isActive={job.id === activeJobId}
            onClick={() => onSelectJob?.(job.id)}
          />
        ))}
      </div>
    </div>
  );
}
