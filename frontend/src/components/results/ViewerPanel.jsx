import { cn } from "@/lib/utils";
import { Layers, Crosshair } from "lucide-react";

const PLANES = [
  { id: "viewer-axial", name: "Axial", description: "Vista superior → inferior", shortcut: "Z", gridLabel: "Slice transversal" },
  { id: "viewer-coronal", name: "Coronal", description: "Vista anterior → posterior", shortcut: "Y", gridLabel: "Slice frontal" },
  { id: "viewer-sagittal", name: "Sagital", description: "Vista izquierda → derecha", shortcut: "X", gridLabel: "Slice lateral" },
];

export default function ViewerPanel({ artifacts, lesionId }) {
  return (
    <div className="glass-card p-6 animate-[fade-in_0.5s_ease-out]">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Visualización Multiplanar</h3>
        </div>
        {lesionId && (
          <span className="text-xs font-mono px-2 py-1 rounded-md" style={{ backgroundColor: "var(--bg-input)", color: "var(--text-muted)" }}>
            Lesión: {lesionId}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {PLANES.map((plane, index) => (
          <div key={plane.id} id={plane.id} className="animate-[fade-in_0.4s_ease-out]" style={{ animationDelay: `${index * 150}ms`, animationFillMode: "both" }}>
            {/* Plane label bar */}
            <div className="flex items-center justify-between px-3 py-2 rounded-t-lg border-x border-t" style={{ backgroundColor: "var(--bg-input)", borderColor: "var(--border-subtle)" }}>
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-accent)" }}>{plane.name}</span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>{plane.description}</span>
            </div>

            {/* Dark viewer with enhanced crosshairs and grid */}
            <div className={cn("relative w-full aspect-square rounded-b-lg border-x border-b flex flex-col items-center justify-center overflow-hidden")} style={{ backgroundColor: "var(--bg-viewer)", borderColor: "var(--border-subtle)" }}>

              {/* Subtle grid pattern */}
              <div className="absolute inset-0 pointer-events-none opacity-[0.04]" style={{
                backgroundImage: `
                  linear-gradient(oklch(0.72 0.17 195) 1px, transparent 1px),
                  linear-gradient(90deg, oklch(0.72 0.17 195) 1px, transparent 1px)`,
                backgroundSize: "20px 20px",
              }} />

              {/* Main crosshair lines */}
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `
                  linear-gradient(to right, transparent calc(50% - 0.5px), oklch(0.72 0.17 195 / 0.35) calc(50% - 0.5px), oklch(0.72 0.17 195 / 0.35) calc(50% + 0.5px), transparent calc(50% + 0.5px)),
                  linear-gradient(to bottom, transparent calc(50% - 0.5px), oklch(0.72 0.17 195 / 0.35) calc(50% - 0.5px), oklch(0.72 0.17 195 / 0.35) calc(50% + 0.5px), transparent calc(50% + 0.5px))`,
              }} />

              {/* Center crosshair icon */}
              <Crosshair className="w-8 h-8 opacity-20" style={{ color: "var(--text-accent)" }} />
              <p className="text-xs mt-2 opacity-30" style={{ color: "var(--text-secondary)" }}>{plane.gridLabel}</p>

              {/* HUD corners — simulating medical viewer */}
              <div className="absolute top-2 left-2 space-y-0.5">
                <p className="text-xs font-mono opacity-50" style={{ color: "var(--text-accent)" }}>{plane.shortcut}</p>
                <p className="text-[10px] font-mono opacity-25" style={{ color: "var(--text-muted)" }}>512 × 512</p>
              </div>
              <div className="absolute top-2 right-2">
                <p className="text-[10px] font-mono opacity-25" style={{ color: "var(--text-muted)" }}>1.5mm</p>
              </div>
              <div className="absolute bottom-2 left-2">
                <p className="text-[10px] font-mono opacity-25" style={{ color: "var(--text-muted)" }}>Idx: 64</p>
              </div>
              <div className="absolute bottom-2 right-2">
                <p className="text-[10px] font-mono opacity-30" style={{ color: "var(--text-muted)" }}>WL: -600 / WW: 1500</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
