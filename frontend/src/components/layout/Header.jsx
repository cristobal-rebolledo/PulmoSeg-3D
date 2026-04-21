import { useApiHealth } from "@/hooks/useApiHealth";
import { cn } from "@/lib/utils";
import { Sun, Moon, Wifi, WifiOff } from "lucide-react";

/**
 * Header — Top bar with page title, API status indicator, and theme toggle.
 *
 * @param {object} props
 * @param {string} props.title         - Current page title
 * @param {string} props.subtitle      - Optional subtitle/description
 * @param {string} props.theme         - Current theme ("dark" | "light")
 * @param {function} props.onToggleTheme - Callback to toggle theme
 */
export default function Header({ title, subtitle, theme, onToggleTheme }) {
  const { isConnected, isChecking } = useApiHealth(10000);

  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{
        backgroundColor: "var(--bg-sidebar)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* --- Left: Title --- */}
      <div>
        <h2
          className="text-xl font-bold tracking-tight"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className="text-sm mt-0.5"
            style={{ color: "var(--text-secondary)" }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {/* --- Right: Controls --- */}
      <div className="flex items-center gap-4">
        {/* API Status Indicator */}
        <div
          id="api-status-indicator"
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium",
            "border transition-all duration-300"
          )}
          style={{
            borderColor: isConnected
              ? "oklch(0.72 0.19 155 / 0.4)"
              : "oklch(0.65 0.20 20 / 0.4)",
            backgroundColor: isConnected
              ? "oklch(0.72 0.19 155 / 0.1)"
              : "oklch(0.65 0.20 20 / 0.1)",
            color: isConnected
              ? "oklch(0.72 0.19 155)"
              : "oklch(0.65 0.20 20)",
          }}
        >
          {isConnected ? (
            <Wifi className="w-3.5 h-3.5" />
          ) : (
            <WifiOff className="w-3.5 h-3.5" />
          )}
          <span>
            {isChecking
              ? "Verificando..."
              : isConnected
                ? "API Conectada"
                : "API Desconectada"}
          </span>
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              isConnected && "status-pulse"
            )}
            style={{
              backgroundColor: isConnected
                ? "oklch(0.72 0.19 155)"
                : "oklch(0.65 0.20 20)",
            }}
          />
        </div>

        {/* Theme Toggle Button */}
        <button
          id="theme-toggle"
          onClick={onToggleTheme}
          className={cn(
            "flex items-center justify-center w-9 h-9 rounded-lg",
            "border transition-all duration-200 cursor-pointer",
            "hover:border-[var(--border-accent)]"
          )}
          style={{
            borderColor: "var(--border-subtle)",
            color: "var(--text-secondary)",
            backgroundColor: "var(--bg-card)",
          }}
          title={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
        >
          {theme === "dark" ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>
      </div>
    </header>
  );
}
