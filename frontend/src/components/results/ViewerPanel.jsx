import { cn } from "@/lib/utils";
import { ImageOff } from "lucide-react";

export default function ViewerPanel({ artifacts, lesionId }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[400px] animate-[fade-in_0.5s_ease-out]">
      <div className="flex items-center justify-center w-24 h-24 mb-6 rounded-[28px] border-2" style={{ backgroundColor: "oklch(0.17 0.008 260)", borderColor: "oklch(0.24 0.008 260)" }}>
        <ImageOff className="w-10 h-10 opacity-40" style={{ color: "oklch(0.65 0.01 260)" }} />
      </div>
      <h3 className="text-2xl font-bold mb-3" style={{ color: "oklch(0.95 0.005 260)" }}>Visualización no disponible</h3>
      <p className="text-base text-center max-w-md font-medium" style={{ color: "oklch(0.80 0.01 260)" }}>
        El visor interactivo requiere las series <strong style={{ color: "oklch(0.82 0.15 195)" }}>DICOM originales</strong>.
      </p>
      <p className="text-sm text-center max-w-lg mt-3" style={{ color: "oklch(0.65 0.01 260)" }}>
        Este estudio fue procesado directamente desde un formato NIfTI o vía API externa sin adjuntar las imágenes de origen. Revisa los resultados volumétricos en la parte superior.
      </p>
    </div>
  );
}
