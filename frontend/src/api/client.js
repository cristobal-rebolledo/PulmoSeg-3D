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
 * later visualization with Cornerstone3D.
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
 * clinical_results and artifacts (including dicom_image_ids for Cornerstone3D).
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
