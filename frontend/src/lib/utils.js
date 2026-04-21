import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * cn() — Utility for conditionally joining Tailwind classes.
 * Merges conflicting classes intelligently (e.g., p-2 + p-4 → p-4).
 * Used by all Shadcn/ui components.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
