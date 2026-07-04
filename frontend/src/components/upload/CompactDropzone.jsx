import { useState, useRef, useCallback } from "react";
import { UploadCloud, FolderOpen, X, Send } from "lucide-react";

/**
 * CompactDropzone — Versión compacta del DicomUploader diseñada para caber en la sidebar.
 *
 * Estado vacío:  icono + "Arrastra carpeta DICOM" (~120px alto)
 * Con archivos:  nombre de carpeta + fileCount + input Patient ID + botón "Iniciar Análisis"
 *
 * Al hacer submit, el form se limpia automáticamente para el siguiente estudio.
 *
 * @param {object}   props
 * @param {function} props.onSubmit      - Callback con { folderName, fileCount, patientId, studyUid, files }
 * @param {boolean}  props.isSubmitting  - Muestra spinner mientras se envía
 */
export default function CompactDropzone({ onSubmit, isSubmitting = false }) {
  const [isDragging, setIsDragging]       = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [dcmFiles, setDcmFiles]           = useState([]);
  const [patientId, setPatientId]         = useState("");
  const [studyUid, setStudyUid]           = useState("");
  const inputRef = useRef(null);

  // ── File processing ──────────────────────────────────────────────────────
  const processFiles = useCallback((fileList) => {
    const allFiles   = Array.from(fileList);
    
    const totalSize = allFiles.reduce((acc, file) => acc + file.size, 0);
    const maxSize = 130 * 1024 * 1024; // 130 MB
    if (totalSize > maxSize) {
      alert(`El tamaño total del estudio (${(totalSize / 1024 / 1024).toFixed(1)} MB) excede el límite máximo permitido de 130 MB.`);
      return;
    }

    const dicomFiles = allFiles.filter(
      (f) => f.name.toLowerCase().endsWith(".dcm") || f.name.toLowerCase().endsWith(".dicom")
    );
    if (allFiles.length === 0) return;

    const firstPath   = allFiles[0]?.webkitRelativePath || "";
    const segments    = firstPath.split("/");
    const topFolder   = segments[0] || "";
    const secondFolder = segments.length > 2 ? segments[1] : "";
    const looksLikeUID = (s) => /^\d[\d.]+\d$/.test(s);

    const detectedPatient = looksLikeUID(topFolder) ? "" : topFolder;
    const detectedStudy   = looksLikeUID(topFolder)
      ? topFolder
      : looksLikeUID(secondFolder) ? secondFolder : "";

    setSelectedFolder(topFolder);
    setDcmFiles(dicomFiles);
    if (!patientId && detectedPatient) setPatientId(detectedPatient);
    if (!studyUid  && detectedStudy)   setStudyUid(detectedStudy);
  }, [patientId, studyUid]);

  // ── Event handlers ────────────────────────────────────────────────────────
  const handleDragOver  = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true);  }, []);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }, []);
  const handleDrop      = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    const items = e.dataTransfer?.items;
    if (items) {
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") { const f = items[i].getAsFile(); if (f) files.push(f); }
      }
      if (files.length > 0) processFiles(files);
    }
  }, [processFiles]);

  const handleInputChange = useCallback((e) => {
    if (e.target.files?.length > 0) processFiles(e.target.files);
  }, [processFiles]);

  const handleClear = useCallback((e) => {
    e?.stopPropagation();
    setSelectedFolder(null); setDcmFiles([]); setPatientId(""); setStudyUid("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleSubmit = useCallback((e) => {
    e?.stopPropagation();
    if (!selectedFolder || dcmFiles.length === 0 || !patientId.trim()) return;
    onSubmit?.({
      folderName: selectedFolder,
      fileCount:  dcmFiles.length,
      patientId:  patientId.trim(),
      studyUid:   studyUid.trim() || selectedFolder,
      seriesUid:  "",
      files:      dcmFiles,
    });
    handleClear();
  }, [selectedFolder, dcmFiles, patientId, studyUid, onSubmit, handleClear]);

  // ── Render: empty state ───────────────────────────────────────────────────
  if (!selectedFolder) {
    return (
      <div
        id="compact-dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: "22px 14px",
          borderRadius: 14,
          border: `2px dashed ${isDragging ? "#22d3ee" : "var(--border-subtle)"}`,
          backgroundColor: isDragging ? "oklch(0.72 0.17 195 / 0.07)" : "transparent",
          cursor: "pointer",
          transition: "border-color 200ms ease, background-color 200ms ease",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!isDragging) e.currentTarget.style.borderColor = "oklch(0.72 0.17 195 / 0.5)";
        }}
        onMouseLeave={(e) => {
          if (!isDragging) e.currentTarget.style.borderColor = "var(--border-subtle)";
        }}
      >
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: isDragging ? "oklch(0.72 0.17 195 / 0.20)" : "oklch(0.72 0.17 195 / 0.10)",
          transition: "background-color 200ms ease",
        }}>
          <UploadCloud style={{ width: 22, height: 22, color: "#22d3ee" }} />
        </div>

        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            {isDragging ? "Suelta aquí" : "Arrastra carpeta DICOM"}
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "3px 0 0" }}>
            .dcm · .dicom soportados
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleInputChange}
          /* @ts-ignore */
          webkitdirectory=""
          directory=""
          multiple
        />
      </div>
    );
  }

  // ── Render: files selected ────────────────────────────────────────────────
  return (
    <div style={{
      borderRadius: 14,
      border: "1px solid var(--border-subtle)",
      backgroundColor: "var(--bg-input)",
      padding: 14,
    }}>
      {/* Folder header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: "oklch(0.72 0.19 155 / 0.12)", flexShrink: 0,
        }}>
          <FolderOpen style={{ width: 17, height: 17, color: "oklch(0.72 0.19 155)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
            margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {selectedFolder}
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
            {dcmFiles.length} archivos .dcm
          </p>
        </div>
        <button
          onClick={handleClear}
          title="Cambiar carpeta"
          style={{
            border: "none", background: "none", cursor: "pointer",
            color: "var(--text-muted)", padding: 4, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Patient ID */}
      <input
        type="text"
        value={patientId}
        onChange={(e) => setPatientId(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit(e)}
        placeholder="Patient ID (ej: LIDC-IDRI-0001)"
        style={{
          width: "100%", boxSizing: "border-box",
          padding: "8px 10px", borderRadius: 8,
          border: "1px solid var(--border-subtle)",
          backgroundColor: "var(--bg-card)", color: "var(--text-primary)",
          fontSize: 12, outline: "none", marginBottom: 10,
        }}
      />

      {/* Submit */}
      <button
        id="compact-submit-btn"
        onClick={handleSubmit}
        disabled={isSubmitting || dcmFiles.length === 0 || !patientId.trim()}
        style={{
          width: "100%",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          padding: "10px 12px", borderRadius: 10, border: "none", cursor: "pointer",
          background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
          color: "oklch(0.10 0.01 260)",
          fontSize: 13, fontWeight: 700,
          boxShadow: "0 4px 14px oklch(0.72 0.17 195 / 0.35)",
          opacity: (isSubmitting || !patientId.trim()) ? 0.5 : 1,
          transition: "opacity 200ms ease, transform 200ms ease",
        }}
        onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.transform = "scale(1.02)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
      >
        {isSubmitting ? (
          <>
            <div style={{
              width: 13, height: 13, borderRadius: "50%",
              border: "2px solid rgba(0,0,0,0.25)", borderTopColor: "#000",
              animation: "spin 0.8s linear infinite",
            }} />
            Enviando...
          </>
        ) : (
          <>
            <Send style={{ width: 14, height: 14 }} />
            Iniciar Análisis
          </>
        )}
      </button>
    </div>
  );
}
