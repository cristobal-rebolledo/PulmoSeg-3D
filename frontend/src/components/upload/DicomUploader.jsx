import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { FolderOpen, FileText, X, Send } from "lucide-react";

export default function DicomUploader({ onSubmit, isSubmitting = false, onClose }) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [dcmFiles, setDcmFiles] = useState([]);
  const [patientId, setPatientId] = useState("");
  const [studyUid, setStudyUid] = useState("");
  const [seriesUid, setSeriesUid] = useState("");
  const folderInputRef = useRef(null);
  const fileInputRef = useRef(null);

  const processFiles = useCallback((fileList) => {
    const allFiles = Array.from(fileList);
    const zipFiles = allFiles.filter(f => f.name.toLowerCase().endsWith(".zip"));
    
    if (zipFiles.length > 0) {
      const zipFile = zipFiles[0];
      const baseName = zipFile.name.replace(/\.zip$/i, "");
      setSelectedFolder(baseName);
      setDcmFiles([zipFile]);
      if (!patientId) setPatientId(baseName);
      return;
    }

    const dicomFiles = allFiles.filter(
      (f) => f.name.toLowerCase().endsWith(".dcm") || f.name.toLowerCase().endsWith(".dicom")
    );
    if (dicomFiles.length === 0) return;
    const firstPath = dicomFiles[0]?.webkitRelativePath || allFiles[0]?.webkitRelativePath || "";
    const segments = firstPath.split("/");
    const topFolder = segments[0] || "";
    const secondFolder = segments.length > 2 ? segments[1] : "";
    const thirdFolder = segments.length > 3 ? segments[2] : "";
    
    setSelectedFolder(topFolder);
    setDcmFiles(dicomFiles);
    if (!patientId) setPatientId(topFolder);
  }, [patientId]);


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
    setSelectedFolder(null); setDcmFiles([]); setPatientId(""); setStudyUid(""); setSeriesUid("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleSubmit = useCallback(() => {
    if (!selectedFolder || dcmFiles.length === 0) return;
    const resolvedPatient = patientId.trim();
    const resolvedStudy = studyUid.trim() || selectedFolder;
    const resolvedSeries = seriesUid.trim();
    if (!resolvedPatient) {
      alert("Por favor, ingresa el Patient Pseudo ID (ej: LIDC-IDRI-0001) antes de continuar.\n\nEste dato es necesario para localizar la carpeta DICOM correcta en el servidor.");
      return;
    }
    onSubmit?.({
      folderName: selectedFolder,
      fileCount: dcmFiles.length,
      patientId: resolvedPatient,
      studyUid: resolvedStudy,
      seriesUid: resolvedSeries,
      files: dcmFiles,
    });
  }, [selectedFolder, dcmFiles, patientId, studyUid, seriesUid, onSubmit]);



  return (
    <div className="glass-card rounded-[28px] animate-[fade-in_0.4s_ease-out] shadow-2xl relative" style={{ padding: "40px", backgroundColor: "var(--bg-card)" }}>
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-2 rounded-full transition-colors hover:bg-[var(--bg-card-hover)]"
          style={{ color: "var(--text-muted)" }}
          title="Cerrar modal"
        >
          <X className="w-6 h-6" />
        </button>
      )}

      <div className="mb-8 pr-12">
        <h3 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Cargar Estudio DICOM
        </h3>
        <p className="text-base mt-2" style={{ color: "var(--text-secondary)" }}>
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
          onClick={() => fileInputRef.current?.click()}
        >
          {isDragging && (
            <div
              className="absolute inset-0 rounded-2xl pointer-events-none"
              style={{ background: "radial-gradient(ellipse at center, oklch(0.72 0.17 195 / 0.08) 0%, transparent 70%)" }}
            />
          )}
          <div
            className={cn("w-24 h-24 rounded-3xl flex items-center justify-center mb-6 transition-transform duration-300", isDragging && "scale-110")}
            style={{ backgroundColor: isDragging ? "oklch(0.72 0.17 195 / 0.18)" : "oklch(0.72 0.17 195 / 0.10)" }}
          >
            <FolderOpen className="w-12 h-12" style={{ color: "var(--text-accent)" }} />
          </div>
          <p className="text-2xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>
            {isDragging ? "Suelta la carpeta o archivo ZIP aquí" : "Arrastra tu carpeta DICOM o archivo .ZIP"}
          </p>
          <p className="text-base" style={{ color: "var(--text-muted)" }}>
            haz clic para buscar <span className="font-semibold" style={{ color: "var(--text-accent)" }}>archivos ZIP o DICOM</span>
          </p>
          <p className="text-sm mt-2" style={{ color: "var(--text-muted)" }}>
            o <button type="button" onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }} className="font-semibold hover:underline" style={{ color: "var(--text-accent)" }}>seleccionar una carpeta entera</button>
          </p>
          <p
            className="text-sm font-medium mt-6 px-8 py-3 rounded-full border"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)", backgroundColor: "var(--bg-input)" }}
          >
            Formatos soportados: <strong>.dcm</strong> · <strong>.dicom</strong> · <strong>.zip</strong>
          </p>
          <input ref={folderInputRef} type="file" className="hidden" onChange={handleInputChange}
            /* @ts-ignore */ webkitdirectory="" directory="" multiple />
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleInputChange}
            multiple accept=".zip,.dcm,.dicom" />
        </div>
      ) : (
        <div className="flex flex-col gap-8 mt-2">
          <div className="rounded-[20px] border" style={{ padding: "32px", borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-input)" }}>
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: "oklch(0.72 0.19 155 / 0.15)" }}>
                  <FolderOpen className="w-7 h-7" style={{ color: "var(--color-success)" }} />
                </div>
                <div>
                  <p className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{selectedFolder}</p>
                  <p className="text-sm mt-1 font-medium" style={{ color: "var(--text-muted)" }}>
                    <FileText className="w-4 h-4 inline mr-1.5" />{dcmFiles.length} archivo(s) detectado(s)
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-6">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest mb-2.5" style={{ color: "var(--text-secondary)" }}>Patient Pseudo ID</label>
                <input id="input-patient-id" type="text" value={patientId} onChange={(e) => setPatientId(e.target.value)}
                  placeholder="LIDC-IDRI-0001" className="w-full px-5 py-4 rounded-xl text-base font-medium border outline-none transition-all focus:border-[var(--color-accent-500)] focus:ring-1 focus:ring-[var(--color-accent-500)]"
                  style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }} />
              </div>
              <div className="hidden">
                <label className="block text-[11px] font-bold uppercase tracking-widest mb-2.5" style={{ color: "var(--text-secondary)" }}>Study Instance UID</label>
                <input id="input-study-uid" type="text" value={studyUid} onChange={(e) => setStudyUid(e.target.value)}
                  placeholder="1.3.6.1.4..." className="w-full px-5 py-4 rounded-xl text-base font-medium border outline-none transition-all focus:border-[var(--color-accent-500)] focus:ring-1 focus:ring-[var(--color-accent-500)]"
                  style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }} />
              </div>
            </div>
          </div>

          <button
            id="submit-segmentation" onClick={handleSubmit}
            disabled={isSubmitting || dcmFiles.length === 0}
            className={cn(
              "w-full flex items-center justify-center gap-3",
              "px-6 py-6 mt-2 rounded-[16px] text-xl font-extrabold",
              "transition-all duration-200 cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:-translate-y-0.5"
            )}
            style={{ background: "linear-gradient(135deg, var(--color-accent-500), var(--color-primary-500))", color: "white", boxShadow: "0 8px 24px oklch(0.72 0.17 195 / 0.35)" }}
          >
            {isSubmitting ? (
              <><div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Enviando...</>
            ) : (
              <><Send className="w-5 h-5" />Iniciar Segmentación</>
            )}
          </button>
        </div>
      )}


    </div>
  );
}
