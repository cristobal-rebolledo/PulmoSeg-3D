import { useState, useEffect, useRef, useCallback } from "react";
import { checkHealth } from "@/api/client";

/**
 * useApiHealth — Hook that polls the FastAPI /health endpoint.
 *
 * Returns the current connectivity status so the Header can display
 * a green/red indicator.
 *
 * @param {number} intervalMs - Polling interval in milliseconds (default: 10s)
 * @returns {{ isConnected: boolean, isChecking: boolean, lastCheck: Date|null, error: string|null }}
 */
export function useApiHealth(intervalMs = 10000) {
  const [isConnected, setIsConnected] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [lastCheck, setLastCheck] = useState(null);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const check = useCallback(async () => {
    setIsChecking(true);
    try {
      const data = await checkHealth();
      setIsConnected(data?.status === "healthy");
      setError(null);
    } catch (err) {
      setIsConnected(false);
      setError(err.message);
    } finally {
      setIsChecking(false);
      setLastCheck(new Date());
    }
  }, []);

  useEffect(() => {
    // Initial check
    check();

    // Set up polling
    intervalRef.current = setInterval(check, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [check, intervalMs]);

  return { isConnected, isChecking, lastCheck, error };
}
