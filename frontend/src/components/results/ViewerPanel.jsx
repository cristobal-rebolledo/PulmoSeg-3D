import { cn } from "@/lib/utils";
import { ImageOff } from "lucide-react";

export default function ViewerPanel({ artifacts, lesionId }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[400px] animate-[fade-in_0.5s_ease-out]">
      <div className="flex items-center justify-center w-24 h-24 mb-6 rounded-[28px] border-2" style={{ backgroundColor: "var(--bg-card)", borderColor: "var(--border-subtle)" }}>
        <ImageOff className="w-10 h-10 opacity-40" style={{ color: "var(--text-secondary)" }} />
      </div>
      <h3 className="text-2xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>Visualización no disponible</h3>
      <p className="text-base text-center max-w-md font-medium" style={{ color: "var(--text-secondary)" }}>
        El visor interactivo requiere las series <strong style={{ color: "var(--text-accent)" }}>DICOM originales</strong>.
      </p>
      <p className="text-sm text-center max-w-lg mt-3" style={{ color: "var(--text-muted)" }}>
        Este estudio fue procesado directamente desde un formato NIfTI o vía API externa sin adjuntar las imágenes de origen. Revisa los resultados volumétricos en la parte superior.
      </p>
    </div>
  );
}
