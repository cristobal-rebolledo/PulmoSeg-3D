/**
 * client.js — API Service Layer for PulmoSeg 3D.
 *
 * Wraps all communication with the FastAPI backend.
 * In development, requests go through Vite's proxy (/api → localhost:8000).
 *
 * Endpoints mapped:
 *   checkHealth()                        → GET  /health
 *   createSegmentationJob(files, meta)   → POST /segment  (multipart/form-data)
 *   getJobStatus(jobId)                  → GET  /status/{job_id}
 *
 * Security:
 *   - The X-API-Key header is injected automatically into all requests.
 *   - The key is read from VITE_API_KEY (set in frontend/.env).
 *   - DICOM and NIfTI file endpoints require this header.
 */

// Base URL for API requests.
// Vite proxy rewrites /api/* → http://127.0.0.1:8000/*
const API_BASE = "/api";

/**
 * API Key for protected endpoints (DICOM / NIfTI file serving).
 * Loaded from VITE_API_KEY environment variable.
 * Must match PULMOSEG_API_KEY in the backend .env file.
 */
export const API_KEY = import.meta.env.VITE_API_KEY || "";

/**
 * Generic fetch wrapper for JSON endpoints (GET, etc.).
 *
 * Automatically injects X-API-Key header for all requests.
 *
 * @param {string} endpoint - API endpoint path (e.g. "/health")
 * @param {object} options  - fetch() options
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} With descriptive message on network or HTTP errors
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;

  const config = {
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    ...options,
    // Merge headers if options also has them
    ...(options.headers
      ? {
          headers: {
            "Content-Type": "application/json",
            ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
            ...options.headers,
          },
        }
      : {}),
  };

  try {
    const response = await fetch(url, config);

    // Parse response body
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        data?.detail || data?.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return data;
  } catch (error) {
    // Network error (API unreachable)
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error("No se pudo conectar con la API. ¿Está corriendo el servidor?");
    }
    throw error;
  }
}

// ===========================================================================
// API Functions
// ===========================================================================

/**
 * GET /health — Check if the FastAPI backend is alive.
 *
 * @returns {Promise<{status: string, service: string, version: string}>}
 * @example
 *   const health = await checkHealth();
 *   // { status: "healthy", service: "PulmoSeg 3D API", version: "1.1.0-local" }
 */
export async function checkHealth() {
  return request("/health");
}

/**
 * POST /segment — Create a new segmentation job via multipart file upload.
 *
 * Sends the actual DICOM files alongside metadata as FormData.
 * The backend saves the files permanently to temp_{job_id}/ for
 * later visualization with the custom Canvas viewer.
 *
 * IMPORTANT: Do NOT set Content-Type header manually — the browser
 * must set it automatically with the correct multipart boundary.
 *
 * @param {object} params
 * @param {File[]} params.files            - Array of DICOM File objects
 * @param {string} [params.patientId]      - Patient pseudo ID
 * @param {string} [params.studyUid]       - Study Instance UID
 *
 * @returns {Promise<{job_id: string, status: string, message: string}>}
 */
export async function createSegmentationJob({ files, patientId, studyUid }) {
  const url = `${API_BASE}/segment`;

  // Build FormData with files + metadata
  const formData = new FormData();

  formData.append("patient_pseudo_id", patientId || "unknown");
  formData.append("study_instance_uid", studyUid || "unknown");

  // Append each DICOM file under the same field name "files"
  for (const file of files) {
    formData.append("files", file);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers: {
        // X-API-Key header (no Content-Type — browser sets it with boundary)
        ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
      },
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        data?.detail || data?.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return data;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error("No se pudo conectar con la API. ¿Está corriendo el servidor?");
    }
    throw error;
  }
}

/**
 * GET /status/{job_id} — Get current job status and results.
 *
 * Returns job info, progress, state history, and (if COMPLETED)
 * clinical_results and artifacts (including dicom_image_ids for the viewer).
 *
 * @param {string} jobId - The job identifier returned by POST /segment
 *
 * @returns {Promise<{
 *   job_info: { job_id, status, progress_percentage, timestamps },
 *   clinical_results?: { lesion_id, volumetric_data, recist_metrics },
 *   artifacts?: {
 *     segmentation_mask_nifti_url,
 *     uncertainty_map_url,
 *     dicom_image_ids: string[],
 *   },
 *   state_history: Array<{ state, time }>,
 *   error_message?: string
 * }>}
 */
export async function getJobStatus(jobId) {
  return request(`/status/${encodeURIComponent(jobId)}`);
}

/**
 * POST /cancel/{job_id} — Cancels an active segmentation job.
 *
 * Can only cancel jobs in QUEUED or PROCESSING state.
 * The backend marks the job as CANCELLED; the worker detects this
 * at its next checkpoint and aborts the pipeline.
 *
 * @param {string} jobId - The job identifier to cancel
 * @returns {Promise<{job_id: string, status: string, message: string}>}
 */
export async function cancelJob(jobId) {
  return request(`/cancel/${encodeURIComponent(jobId)}`, { method: "POST" });
}

/**
 * DELETE /jobs/{job_id} — Deletes a job entirely from the database.
 * Used for cleaning up invalid uploads.
 */
export async function deleteJob(jobId) {
  return request(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

/**
 * GET /jobs — Lista paginada del historial de trabajos de segmentación.
 *
 * Soporta búsqueda por patient_pseudo_id y paginación con skip/limit.
 * El frontend limita la vista inicial a los últimos 100 registros.
 *
 * @param {object} [params]
 * @param {number} [params.skip=0]      - Offset de paginación
 * @param {number} [params.limit=100]   - Máximo de resultados por llamada
 * @param {string} [params.search=""]   - Filtro parcial por patient_pseudo_id
 *
 * @returns {Promise<{
 *   total: number,
 *   jobs: Array<{
 *     job_id: string,
 *     patient_pseudo_id: string|null,
 *     status: string,
 *     created_at: string,
 *     completed_at: string|null,
 *     file_count: number|null,
 *     volume_ml: number|null,
 *     longest_diameter_mm: number|null,
 *   }>
 * }>}
 */
export async function listJobs({ skip = 0, limit = 100, search = "" } = {}) {
  const params = new URLSearchParams({ skip: String(skip), limit: String(limit) });
  if (search && search.trim()) {
    params.set("search", search.trim());
  }
  return request(`/jobs?${params.toString()}`);
}

