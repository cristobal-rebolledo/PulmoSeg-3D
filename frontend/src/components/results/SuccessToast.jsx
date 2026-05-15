import { useEffect } from "react";
import { CheckCircle2, X } from "lucide-react";

export default function SuccessToast({ patientId, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl shadow-lg animate-[fade-in_0.3s_ease-out]"
      style={{
        backgroundColor: "oklch(0.72 0.19 155 / 0.12)",
        border: "1px solid oklch(0.72 0.19 155 / 0.35)",
        backdropFilter: "blur(12px)",
        minWidth: "260px",
      }}
    >
      <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: "oklch(0.72 0.19 155)" }} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "oklch(0.72 0.19 155)" }}>
          Segmentación completada
        </p>
        {patientId && (
          <p className="text-xs mt-0.5 font-mono" style={{ color: "var(--text-secondary)" }}>
            Paciente: {patientId}
          </p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="p-1 rounded-lg hover:bg-white/10 transition-colors"
        style={{ color: "var(--text-muted)" }}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
