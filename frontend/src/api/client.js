/**
 * client.js — API Service Layer for PulmoSeg 3D.
 *
 * Wraps all communication with the FastAPI backend.
 * In development, requests go through Vite's proxy (/api → localhost:8000).
 *
 * Endpoints mapped:
 *   checkHealth()                → GET  /health
 *   createSegmentationJob(data)  → POST /segment
 *   getJobStatus(jobId)          → GET  /status/{job_id}
 */

// Base URL for API requests.
// Vite proxy rewrites /api/* → http://127.0.0.1:8000/*
const API_BASE = "/api";

/**
 * Generic fetch wrapper with error handling.
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
    },
    ...options,
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
 *   // { status: "healthy", service: "PulmoSeg 3D API", version: "1.0.0-local" }
 */
export async function checkHealth() {
  return request("/health");
}

/**
 * POST /segment — Create a new segmentation job.
 *
 * Sends the full payload matching the SegmentationRequest Pydantic model.
 * The backend creates the job in SQLite and launches a BackgroundTask.
 *
 * @param {object} payload - Segmentation request data
 * @param {string} payload.idempotency_key    - Unique key to prevent duplicates
 * @param {string} payload.patient_pseudo_id  - Pseudonymized patient ID
 * @param {string} payload.study_instance_uid - DICOM Study Instance UID
 * @param {object} payload.dicom_source       - DICOM source config
 * @param {object} payload.target_roi         - ROI bounding box config
 * @param {object} payload.execution_config   - Model and priority config
 *
 * @returns {Promise<{job_id: string, status: string, message: string}>}
 * @example
 *   const job = await createSegmentationJob({
 *     idempotency_key: "req_001",
 *     patient_pseudo_id: "LIDC-IDRI-0001",
 *     study_instance_uid: "1.3.6...",
 *     dicom_source: { ... },
 *     target_roi: { ... },
 *     execution_config: { ... }
 *   });
 *   // { job_id: "req_001", status: "QUEUED", message: "..." }
 */
export async function createSegmentationJob(payload) {
  return request("/segment", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * GET /status/{job_id} — Get current job status and results.
 *
 * Returns job info, progress, state history, and (if COMPLETED)
 * clinical_results and artifacts.
 *
 * @param {string} jobId - The job identifier returned by POST /segment
 *
 * @returns {Promise<{
 *   job_info: { job_id, status, progress_percentage, timestamps },
 *   clinical_results?: { lesion_id, volumetric_data, recist_metrics },
 *   artifacts?: { segmentation_mask_nifti_url, uncertainty_map_url },
 *   state_history: Array<{ state, time }>,
 *   error_message?: string
 * }>}
 */
export async function getJobStatus(jobId) {
  return request(`/status/${encodeURIComponent(jobId)}`);
}

/**
 * Build a complete segmentation request payload from user inputs.
 *
 * Helper that constructs the full SegmentationRequest object
 * matching the Pydantic schema, using sensible defaults for
 * fields the user doesn't need to configure in the UI.
 *
 * @param {object} params
 * @param {string} params.patientId    - Patient pseudo ID (e.g. "LIDC-IDRI-0001")
 * @param {string} params.studyUid     - Study Instance UID
 * @param {string} [params.seriesUid]  - Series Instance UID (defaults to studyUid)
 * @param {number} [params.fileCount]  - Number of DICOM files detected
 * @param {string} [params.idempotencyKey] - Custom idempotency key
 *
 * @returns {object} Complete payload ready for createSegmentationJob()
 */
export function buildSegmentationPayload({
  patientId,
  studyUid,
  seriesUid,
  fileCount = 1,
  idempotencyKey,
}) {
  const key = idempotencyKey || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    idempotency_key: key,
    patient_pseudo_id: patientId,
    study_instance_uid: studyUid,
    dicom_source: {
      gcs_bucket: "local",
      gcs_prefix: `dicom/${patientId}/${studyUid}/`,
      series_instance_uid: seriesUid || studyUid,
      expected_file_count: fileCount,
    },
    target_roi: {
      enabled: true,
      roi_validation_mode: "STRICT",
      coordinates: {
        x_min: 0,
        x_max: 512,
        y_min: 0,
        y_max: 512,
        z_min: 0,
        z_max: fileCount,
      },
    },
    execution_config: {
      model_version: "SegResNet_Lung_v2.1",
      priority: "NORMAL",
      webhook_url: null,
    },
  };
}
