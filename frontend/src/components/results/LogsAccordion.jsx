import { useState } from "react";
import { Terminal, ChevronDown, ChevronUp } from "lucide-react";

export default function LogsAccordion({ consoleLines, lineColor }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <button
        id="logs-accordion-toggle"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{ backgroundColor: "var(--bg-input)" }}
      >
        <Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-accent)" }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider flex-1 text-left" style={{ color: "var(--text-secondary)" }}>
          Logs del Worker
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full mr-2" style={{ backgroundColor: "var(--bg-card)", color: "var(--text-muted)" }}>
          {consoleLines.length} líneas
        </span>
        <div className="flex items-center gap-1 mr-2">
          {["oklch(0.65 0.20 20)", "oklch(0.80 0.16 80)", "oklch(0.72 0.19 155)"].map((c) => (
            <div key={c} className="w-2 h-2 rounded-full" style={{ backgroundColor: c }} />
          ))}
        </div>
        {open
          ? <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
          : <ChevronUp className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
        }
      </button>
      {open && (
        <div
          className="px-4 py-3 max-h-32 overflow-y-auto animate-[fade-in_0.2s_ease-out]"
          style={{ backgroundColor: "#000", fontFamily: "'JetBrains Mono','Fira Code',monospace" }}
        >
          {consoleLines.map((line, i) => (
            <div key={i} className="text-[11px] leading-5" style={{ color: lineColor[line.type] || "white" }}>
              {line.text}
            </div>
          ))}
          <div className="text-[11px] leading-5 mt-1" style={{ color: "oklch(0.5 0 0)" }}>
            <span className="status-pulse inline-block">▌</span>
          </div>
        </div>
      )}
    </div>
  );
}
