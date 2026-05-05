import { useState, useEffect, useRef, useCallback } from "react";
import { getJobStatus } from "@/api/client";

/**
 * useJobPoller — Hook that polls GET /status/{job_id} at a fixed interval.
 *
 * Automatically stops polling when the job reaches a terminal state
 * (COMPLETED or FAILED).
 *
 * @param {string|null} jobId      - Job ID to poll (null = inactive)
 * @param {number}      intervalMs - Polling interval in ms (default: 3000)
 *
 * @returns {{
 *   data: object|null,          - Full status response from the API
 *   status: string,             - Current job status ("QUEUED", "PROCESSING", etc.)
 *   progress: number,           - Progress percentage (0-100)
 *   isPolling: boolean,         - Whether actively polling
 *   error: string|null,         - Error message if polling failed
 *   clinicalResults: object|null, - Clinical results (only when COMPLETED)
 *   artifacts: object|null,      - File artifacts (only when COMPLETED)
 *   stateHistory: Array,        - Full state history
 * }}
 */
export function useJobPoller(jobId, intervalMs = 3000) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState(null);
  // Tracks which job the current data/status belongs to.
  // This is NOT the same as jobId (the prop) — it only updates when real
  // API data arrives, preventing stale data from a previous job from being
  // read as valid data for the new job during React's async state transitions.
  const [dataJobId, setDataJobId] = useState(null);
  const intervalRef = useRef(null);

  // Terminal states — stop polling when reached
  const TERMINAL_STATES = ["COMPLETED", "FAILED"];

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const poll = useCallback(async () => {
    if (!jobId) return;

    try {
      const result = await getJobStatus(jobId);
      setData(result);
      setDataJobId(jobId); // Mark that this data belongs to jobId

      const jobStatus = result?.job_info?.status || "UNKNOWN";
      const jobProgress = result?.job_info?.progress_percentage || 0;

      setStatus(jobStatus);
      setProgress(jobProgress);
      setError(null);

      // Stop polling on terminal state
      if (TERMINAL_STATES.includes(jobStatus)) {
        stopPolling();
      }
    } catch (err) {
      setError(err.message);
      // Don't stop polling on transient errors — the API might come back
    }
  }, [jobId, stopPolling]);

  // Start/stop polling when jobId changes
  useEffect(() => {
    if (!jobId) {
      stopPolling();
      return;
    }

    // Reset ALL state for new job, including dataJobId
    setData(null);
    setStatus("");
    setProgress(0);
    setError(null);
    setDataJobId(null); // Critical: clear data ownership before first poll
    setIsPolling(true);

    // Immediate first poll
    poll();

    // Set up interval
    intervalRef.current = setInterval(poll, intervalMs);

    return () => stopPolling();
  }, [jobId, intervalMs, poll, stopPolling]);

  return {
    // polledJobId is the job that the current data BELONGS TO.
    // It is null until the first real API response arrives for the current jobId.
    polledJobId: dataJobId,
    data,
    status,
    progress,
    isPolling,
    error,
    clinicalResults: data?.clinical_results || null,
    artifacts: data?.artifacts || null,
    stateHistory: data?.state_history || [],
  };
}
