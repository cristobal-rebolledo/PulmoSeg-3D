import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { FolderOpen, FileText, X, Send, Zap, Brain, Shield } from "lucide-react";

export default function DicomUploader({ onSubmit, isSubmitting = false }) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [dcmFiles, setDcmFiles] = useState([]);
  const [patientId, setPatientId] = useState("");
  const [studyUid, setStudyUid] = useState("");
  const inputRef = useRef(null);

  const processFiles = useCallback((fileList) => {
    const allFiles = Array.from(fileList);
    const dicomFiles = allFiles.filter(
      (f) => f.name.toLowerCase().endsWith(".dcm") || f.name.toLowerCase().endsWith(".dicom")
    );
    if (allFiles.length === 0) return;
    const firstPath = allFiles[0]?.webkitRelativePath || "";
    const segments = firstPath.split("/");
    const topFolder = segments[0] || "";
    const secondFolder = segments.length > 2 ? segments[1] : "";
    const looksLikeUID = (s) => /^\d[\d.]+\d$/.test(s);
    let detectedPatient = "";
    let detectedStudy = "";
    if (looksLikeUID(topFolder)) {
      detectedPatient = "";
      detectedStudy = topFolder;
    } else {
      detectedPatient = topFolder;
      detectedStudy = looksLikeUID(secondFolder) ? secondFolder : "";
    }
    setSelectedFolder(topFolder);
    setDcmFiles(dicomFiles);
    if (!patientId && detectedPatient) setPatientId(detectedPatient);
    if (!studyUid && detectedStudy) setStudyUid(detectedStudy);
  }, [patientId, studyUid]);

  const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); }
      }
      if (files.length > 0) processFiles(files);
    }
  }, [processFiles]);

  const handleInputChange = useCallback((e) => {
    if (e.target.files && e.target.files.length > 0) processFiles(e.target.files);
  }, [processFiles]);

  const handleClear = useCallback(() => {
    setSelectedFolder(null); setDcmFiles([]); setPatientId(""); setStudyUid("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleSubmit = useCallback(() => {
    if (!selectedFolder || dcmFiles.length === 0) return;
    const resolvedPatient = patientId.trim();
    const resolvedStudy = studyUid.trim() || selectedFolder;
    if (!resolvedPatient) {
      alert("Por favor, ingresa el Patient Pseudo ID (ej: LIDC-IDRI-0001) antes de continuar.\n\nEste dato es necesario para localizar la carpeta DICOM correcta en el servidor.");
      return;
    }
    onSubmit?.({ folderName: selectedFolder, fileCount: dcmFiles.length, patientId: resolvedPatient, studyUid: resolvedStudy, files: dcmFiles });
  }, [selectedFolder, dcmFiles, patientId, studyUid, onSubmit]);

  const FEATURES = [
    { icon: Zap,    label: "Fast Processing", desc: "~60s por scan" },
    { icon: Brain,  label: "AI-Powered",      desc: "Deep Learning" },
    { icon: Shield, label: "Seguro",          desc: "Local processing" },
  ];

  return (
    <div className="glass-card p-8 animate-[fade-in_0.4s_ease-out]">
      <div className="mb-6">
        <h3 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Cargar Estudio DICOM
        </h3>
        <p className="text-sm mt-1.5" style={{ color: "var(--text-secondary)" }}>
          Arrastra una carpeta con archivos DICOM o haz clic para seleccionarla
        </p>
      </div>

      {!selectedFolder ? (
        <div
          id="dicom-dropzone"
          className={cn(
            "relative flex flex-col items-center justify-center",
            "min-h-[320px] px-8 rounded-2xl border-2 border-dashed",
            "cursor-pointer transition-all duration-300",
            isDragging && "dropzone-active"
          )}
          style={{
            borderColor: isDragging ? "var(--color-accent-500)" : "var(--border-subtle)",
            backgroundColor: isDragging ? "oklch(0.72 0.17 195 / 0.06)" : "var(--bg-input)",
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          {isDragging && (
            <div
              className="absolute inset-0 rounded-2xl pointer-events-none"
              style={{ background: "radial-gradient(ellipse at center, oklch(0.72 0.17 195 / 0.08) 0%, transparent 70%)" }}
            />
          )}
          <div
            className={cn("w-20 h-20 rounded-2xl flex items-center justify-center mb-5 transition-transform duration-300", isDragging && "scale-110")}
            style={{ backgroundColor: isDragging ? "oklch(0.72 0.17 195 / 0.18)" : "oklch(0.72 0.17 195 / 0.10)" }}
          >
            <FolderOpen className="w-10 h-10" style={{ color: "var(--text-accent)" }} />
          </div>
          <p className="text-xl font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            {isDragging ? "Suelta la carpeta aquí" : "Arrastra tu carpeta DICOM"}
          </p>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            o haz clic para buscar archivos <span style={{ color: "var(--text-accent)" }}>DICOM</span>
          </p>
          <p
            className="text-xs mt-4 px-6 py-2.5 rounded-full border"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)", backgroundColor: "var(--bg-card)" }}
          >
            Formatos soportados: <strong>.dcm</strong> · <strong>.dicom</strong>
          </p>
          <input ref={inputRef} type="file" className="hidden" onChange={handleInputChange}
            /* @ts-ignore */ webkitdirectory="" directory="" multiple />
        </div>
      ) : (
        <div className="rounded-2xl border p-6" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "oklch(0.72 0.19 155 / 0.12)" }}>
                <FolderOpen className="w-6 h-6" style={{ color: "var(--color-success)" }} />
              </div>
              <div>
                <p className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{selectedFolder}</p>
                <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
                  <FileText className="w-3.5 h-3.5 inline mr-1.5" />{dcmFiles.length} archivos .dcm detectados
                </p>
              </div>
            </div>
            <button onClick={handleClear} className="p-2 rounded-lg transition-colors cursor-pointer hover:bg-[var(--bg-card-hover)]" style={{ color: "var(--text-muted)" }} title="Cambiar carpeta">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-secondary)" }}>Patient Pseudo ID</label>
              <input id="input-patient-id" type="text" value={patientId} onChange={(e) => setPatientId(e.target.value)}
                placeholder="LIDC-IDRI-0001" className="w-full px-4 py-3 rounded-xl text-sm border outline-none transition-colors"
                style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }} />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-secondary)" }}>Study Instance UID</label>
              <input id="input-study-uid" type="text" value={studyUid} onChange={(e) => setStudyUid(e.target.value)}
                placeholder="1.3.6.1.4..." className="w-full px-4 py-3 rounded-xl text-sm border outline-none transition-colors"
                style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }} />
            </div>
          </div>

          <button
            id="submit-segmentation" onClick={handleSubmit}
            disabled={isSubmitting || dcmFiles.length === 0}
            className={cn(
              "w-full flex items-center justify-center gap-2.5",
              "px-6 py-3.5 rounded-xl text-base font-semibold",
              "transition-all duration-200 cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            style={{ background: "linear-gradient(135deg, var(--color-accent-500), var(--color-primary-500))", color: "white", boxShadow: "0 4px 16px oklch(0.72 0.17 195 / 0.25)" }}
          >
            {isSubmitting ? (
              <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Enviando...</>
            ) : (
              <><Send className="w-4 h-4" />Iniciar Segmentación</>
            )}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
        {FEATURES.map((feat) => {
          const Icon = feat.icon;
          return (
            <div key={feat.label} className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl border text-xs"
              style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)", color: "var(--text-secondary)" }}>
              <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-accent)" }} />
              <div>
                <p className="font-semibold" style={{ color: "var(--text-primary)" }}>{feat.label}</p>
                <p style={{ color: "var(--text-muted)" }}>{feat.desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
