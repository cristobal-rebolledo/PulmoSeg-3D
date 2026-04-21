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

    // Reset state for new job
    setData(null);
    setStatus("");
    setProgress(0);
    setError(null);
    setIsPolling(true);

    // Immediate first poll
    poll();

    // Set up interval
    intervalRef.current = setInterval(poll, intervalMs);

    return () => stopPolling();
  }, [jobId, intervalMs, poll, stopPolling]);

  return {
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
