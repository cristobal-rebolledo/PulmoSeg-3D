import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import dicomParser from "dicom-parser";
import { Layers3, AlertTriangle, Loader, Eye, EyeOff, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, SkipForward, SkipBack, LocateFixed } from "lucide-react";
import { API_KEY } from "@/api/client";

const WINDOWS = [
  { label: "Pulmón",     wc: -600, ww: 1500 },
  { label: "Mediastino", wc:   40, ww:  400 },
  { label: "Hueso",      wc:  400, ww: 1800 },
  { label: "Blando",     wc:   40, ww:  350 },
];

const sliceCache = new Map();
export function clearViewerCache() {
  sliceCache.clear();
}

async function fetchDicom(url) {
  if (sliceCache.has(url)) return sliceCache.get(url);
  const res = await fetch(url, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  const ds = dicomParser.parseDicom(new Uint8Array(buf));
  const rows = ds.uint16("x00280010") ?? 512;
  const cols = ds.uint16("x00280011") ?? 512;
  const slopeStr = ds.string("x00281053");
  const interStr = ds.string("x00281052");
  const slope = slopeStr !== undefined ? parseFloat(slopeStr) : 1;
  const inter = interStr !== undefined ? parseFloat(interStr) : -1024;
  const bits  = ds.uint16("x00280100") ?? 16;
  const rep   = ds.uint16("x00280103") ?? 0;
  // ── Spacing metadata for anisotropy correction ──────────────────────────
  // PixelSpacing (0028,0030): "rowSpacing\colSpacing" — we use the in-plane spacing
  const psRaw = ds.string("x00280030");
  const pixelSpacing = psRaw ? parseFloat(psRaw.split("\\")[0]) || 1.0 : 1.0;
  // SpacingBetweenSlices (0018,0088) is the true inter-slice gap for multi-slice CT.
  // SliceThickness (0018,0050) may differ due to overlap or gap acquisitions.
  const sbs = parseFloat(ds.string("x00180088"));
  const sliceThickness = (sbs > 0 ? sbs : parseFloat(ds.string("x00180050"))) || pixelSpacing;
  // ImagePositionPatient (0020,0032): "X\Y\Z" — Z gives us the true physical slice order.
  // Critical for correct MPR: without this, slices in filename order may be anatomically
  // shuffled, causing renderCoronal/renderSagittal to interpolate unrelated tissue → stripes.
  const ippRaw = ds.string("x00200032");
  const zPos = ippRaw ? parseFloat(ippRaw.split("\\")[2]) : NaN;
  const el = ds.elements.x7fe00010;
  if (!el) throw new Error("No PixelData");
  const rawBuf = ds.byteArray.buffer;
  const raw = bits === 16
    ? (rep === 1 ? new Int16Array(rawBuf, el.dataOffset, el.length / 2) : new Uint16Array(rawBuf, el.dataOffset, el.length / 2))
    : new Uint8Array(rawBuf, el.dataOffset, el.length);
  const hu = new Float32Array(rows * cols);
  for (let i = 0; i < hu.length; i++) hu[i] = raw[i] * slope + inter;
  const result = { rows, cols, hu, pixelSpacing, sliceThickness, zPos };
  sliceCache.set(url, result);
  return result;
}

async function parseNifti(buffer) {
  let data = buffer;
  const m = new Uint8Array(buffer, 0, 2);
  if (m[0] === 0x1f && m[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter(); w.write(new Uint8Array(buffer)); w.close();
    const r = ds.readable.getReader();
    const chunks = []; let len = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); len += value.length; }
    const out = new Uint8Array(len); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    data = out.buffer;
  }
  const v = new DataView(data);
  const nx = v.getInt16(42, true), ny = v.getInt16(44, true), nz = v.getInt16(46, true);
  const dtype = v.getInt16(70, true);
  const voxOff = Math.round(v.getFloat32(108, true));

  // ── Detectar si el eje Z del NIfTI está invertido respecto al visor ──────
  // El backend resamplea la máscara al espacio exacto del DICOM original,
  // por lo que nx==cols y ny==rows (mapeo 1:1 en x/y).
  // Solo queda manejar el eje Z: el visor ordena slices DESCENDENTE por Z
  // físico (slice 0 = superior/cabeza). El sform nos dice si NIfTI z=0
  // apunta hacia Superior (zFlip=true) o Inferior (zFlip=false).
  const sformCode = v.getInt16(254, true);
  let zFlip = true; // conservador: la mayoría de CTs en RAS tienen z=0=inferior
  if (sformCode > 0) {
    const r9 = v.getFloat32(312, true); // srow_z[2]: positivo → z crece hacia Superior
    if (r9 !== 0) zFlip = r9 > 0;
  }

  let px;
  if (dtype === 2) px = new Uint8Array(data, voxOff);
  else if (dtype === 4) px = new Int16Array(data, voxOff);
  else if (dtype === 8) px = new Int32Array(data, voxOff);
  else if (dtype === 16) px = new Float32Array(data, voxOff);
  else px = new Uint8Array(data, voxOff);
  return { nx, ny, nz, px, zFlip };
}


function renderAxial(canvas, slice, wc, ww, zoom, pan, segSlice, showSeg) {
  if (!canvas || !slice) return;
  const { rows, cols, hu } = slice;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const fitScale = Math.min(W / cols, H / rows) * zoom;
  const ox = (W - cols * fitScale) / 2 + pan.x;
  const oy = (H - rows * fitScale) / 2 + pan.y;
  const lower = wc - ww / 2;
  const off = new OffscreenCanvas(cols, rows);
  const oc = off.getContext("2d");
  const img = oc.createImageData(cols, rows);
  const d = img.data;
  for (let i = 0; i < hu.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(((hu[i] - lower) / ww) * 255)));
    d[i*4]=d[i*4+1]=d[i*4+2]=v; d[i*4+3]=255;
  }
  oc.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, ox, oy, cols * fitScale, rows * fitScale);
  if (showSeg && segSlice) {
    const si = oc.createImageData(cols, rows);
    const sd = si.data;
    for (let i = 0; i < segSlice.length; i++) {
      if (segSlice[i] > 0) { sd[i*4]=255; sd[i*4+1]=60; sd[i*4+2]=60; sd[i*4+3]=170; }
    }
    oc.putImageData(si, 0, 0);
    ctx.save(); ctx.globalAlpha = 0.5;
    ctx.drawImage(off, ox, oy, cols * fitScale, rows * fitScale);
    ctx.restore();
  }
  return { ox, oy, scale: fitScale };
}

/**
 * Draws crosshairs on the axial canvas at the current coronalY / sagittalX position.
 * Called after renderAxial so it draws on top.
 */
function drawAxialCrosshairs(canvas, transform, coronalY, sagittalX) {
  if (!canvas || !transform) return;
  const { ox, oy, scale } = transform;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.strokeStyle = "rgba(100,200,255,0.65)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  const lineY = oy + coronalY * scale;
  ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(canvas.width, lineY); ctx.stroke();
  const lineX = ox + sagittalX * scale;
  ctx.beginPath(); ctx.moveTo(lineX, 0); ctx.lineTo(lineX, canvas.height); ctx.stroke();
  ctx.restore();
}

/**
 * Catmull-Rom cubic interpolation for smooth Z-resampling.
 * Requires 4 control points (p0..p3) and a parameter t ∈ [0,1].
 * Clamp the result to [-1024, 3071] HU to prevent overshoot artifacts.
 */
function catmullRom(p0, p1, p2, p3, t) {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2*p0 - 5*p1 + 4*p2 - p3) * t * t +
    (-p0 + 3*p1 - 3*p2 + p3) * t * t * t
  );
}

/**
 * Renders the coronal MPR plane with Catmull-Rom cubic Z interpolation.
 * Builds the output at physical height: outH = round(nSlices × spacingScale) px,
 * sampling each row by cubic-spline interpolation across the 4 bracketing slices.
 * This eliminates the "stripe" artifact caused by linear interpolation of 5mm gaps.
 */
function renderCoronal(canvas, slices, coronalY, wc, ww, segData, showSeg, sliceIdx, spacingScale, sagittalX) {
  if (!canvas || !slices.length) return null;
  const n = slices.length;
  const cols = slices[0].cols, rows = slices[0].rows;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const lower = wc - ww / 2;
  const scale = Math.max(0.1, spacingScale ?? 1);
  const outW = cols;
  const outH = Math.min(Math.round(n * scale), 4096);

  const off = new OffscreenCanvas(outW, outH);
  const oc = off.getContext("2d");
  const img = oc.createImageData(outW, outH);
  const d = img.data;
  for (let zy = 0; zy < outH; zy++) {
    const zFrac = (zy / outH) * n;
    const z1 = Math.min(Math.floor(zFrac), n - 1);
    const z0 = Math.max(z1 - 1, 0);
    const z2 = Math.min(z1 + 1, n - 1);
    const z3 = Math.min(z1 + 2, n - 1);
    const tz = zFrac - Math.floor(zFrac);
    const hu0 = slices[z0].hu, hu1 = slices[z1].hu;
    const hu2 = slices[z2].hu, hu3 = slices[z3].hu;
    for (let x = 0; x < outW; x++) {
      const si = coronalY * cols + x;
      const huVal = Math.max(-1024, Math.min(3071,
        catmullRom(hu0[si], hu1[si], hu2[si], hu3[si], tz)
      ));
      const v = Math.max(0, Math.min(255, Math.round(((huVal - lower) / ww) * 255)));
      const i = (zy * outW + x) * 4;
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
  }
  oc.putImageData(img, 0, 0);

  const fitFactor = Math.min(W / outW, H / outH);
  const dstW = outW * fitFactor, dstH = outH * fitFactor;
  const ox = (W - dstW) / 2, oy = (H - dstH) / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, ox, oy, dstW, dstH);
  ctx.restore();

  if (showSeg && segData) {
    const { nx, ny, nz, px, zFlip } = segData;
    const yIdx = Math.min(Math.round((coronalY / Math.max(rows-1,1)) * (ny-1)), ny-1);
    const maskOff = new OffscreenCanvas(outW, outH);
    const mc = maskOff.getContext("2d");
    const si = mc.createImageData(outW, outH);
    const sd = si.data;
    for (let zy = 0; zy < outH; zy++) {
      const zFrac = (zy / outH) * n;
      const z0 = Math.min(Math.floor(zFrac), n-1), z1 = Math.min(z0+1, n-1);
      const tz = zFrac - z0;
      const t0 = zFlip ? (1 - z0/Math.max(n-1,1)) : (z0/Math.max(n-1,1));
      const t1 = zFlip ? (1 - z1/Math.max(n-1,1)) : (z1/Math.max(n-1,1));
      const zi0 = Math.min(Math.round(t0 * (nz-1)), nz-1);
      const zi1 = Math.min(Math.round(t1 * (nz-1)), nz-1);
      for (let x = 0; x < outW; x++) {
        const xIdx = Math.min(Math.round((x / Math.max(outW-1,1)) * (nx-1)), nx-1);
        const v0 = px[zi0 * nx * ny + yIdx * nx + xIdx] > 0 ? 1 : 0;
        const v1 = px[zi1 * nx * ny + yIdx * nx + xIdx] > 0 ? 1 : 0;
        if (v0*(1-tz)+v1*tz > 0.5) { const i=(zy*outW+x)*4; sd[i]=255;sd[i+1]=40;sd[i+2]=40;sd[i+3]=255; }
      }
    }
    mc.putImageData(si, 0, 0);
    ctx.save(); ctx.globalAlpha = 0.5;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(maskOff, ox, oy, dstW, dstH);
    ctx.restore();
  }

  // Crosshairs
  ctx.save();
  ctx.strokeStyle = "rgba(100,180,255,0.75)";
  ctx.lineWidth = 1; ctx.setLineDash([4,4]);
  // Horizontal: current axial slice
  const hYc = oy + ((sliceIdx ?? 0) / Math.max(n-1,1)) * dstH;
  ctx.beginPath(); ctx.moveTo(0, hYc); ctx.lineTo(W, hYc); ctx.stroke();
  // Vertical: current sagittalX plane
  if (sagittalX != null) {
    const hXc = ox + (sagittalX / Math.max(outW-1,1)) * dstW;
    ctx.strokeStyle = "rgba(255,200,80,0.75)";
    ctx.beginPath(); ctx.moveTo(hXc, 0); ctx.lineTo(hXc, H); ctx.stroke();
  }
  ctx.restore();
  return { ox, oy, dstW, dstH };
}


/**
 * Renders the sagittal MPR plane with true Z linear interpolation.
 */
function renderSagittal(canvas, slices, sagittalX, wc, ww, segData, showSeg, sliceIdx, spacingScale, coronalY) {
  if (!canvas || !slices.length) return null;
  const n = slices.length;
  const cols = slices[0].cols, rows = slices[0].rows;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const lower = wc - ww / 2;
  const scale = Math.max(0.1, spacingScale ?? 1);
  const outW = rows;
  const outH = Math.min(Math.round(n * scale), 4096);

  const off = new OffscreenCanvas(outW, outH);
  const oc = off.getContext("2d");
  const img = oc.createImageData(outW, outH);
  const d = img.data;
  for (let zy = 0; zy < outH; zy++) {
    const zFrac = (zy / outH) * n;
    const z1 = Math.min(Math.floor(zFrac), n - 1);
    const z0 = Math.max(z1 - 1, 0);
    const z2 = Math.min(z1 + 1, n - 1);
    const z3 = Math.min(z1 + 2, n - 1);
    const tz = zFrac - Math.floor(zFrac);
    const hu0 = slices[z0].hu, hu1 = slices[z1].hu;
    const hu2 = slices[z2].hu, hu3 = slices[z3].hu;
    for (let y = 0; y < outW; y++) {
      const si = y * cols + sagittalX;
      const huVal = Math.max(-1024, Math.min(3071,
        catmullRom(hu0[si], hu1[si], hu2[si], hu3[si], tz)
      ));
      const v = Math.max(0, Math.min(255, Math.round(((huVal - lower) / ww) * 255)));
      const i = (zy * outW + y) * 4;
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
  }
  oc.putImageData(img, 0, 0);

  const fitFactor = Math.min(W / outW, H / outH);
  const dstW = outW * fitFactor, dstH = outH * fitFactor;
  const ox = (W - dstW) / 2, oy = (H - dstH) / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, ox, oy, dstW, dstH);
  ctx.restore();

  if (showSeg && segData) {
    const { nx, ny, nz, px, zFlip } = segData;
    const xIdx = Math.min(Math.round((sagittalX / Math.max(cols-1,1)) * (nx-1)), nx-1);
    const maskOff = new OffscreenCanvas(outW, outH);
    const mc = maskOff.getContext("2d");
    const si = mc.createImageData(outW, outH);
    const sd = si.data;
    for (let zy = 0; zy < outH; zy++) {
      const zFrac = (zy / outH) * n;
      const z0 = Math.min(Math.floor(zFrac), n-1), z1 = Math.min(z0+1, n-1);
      const tz = zFrac - z0;
      const t0 = zFlip ? (1 - z0/Math.max(n-1,1)) : (z0/Math.max(n-1,1));
      const t1 = zFlip ? (1 - z1/Math.max(n-1,1)) : (z1/Math.max(n-1,1));
      const zi0 = Math.min(Math.round(t0 * (nz-1)), nz-1);
      const zi1 = Math.min(Math.round(t1 * (nz-1)), nz-1);
      for (let y = 0; y < outW; y++) {
        const yIdx = Math.min(Math.round((y / Math.max(outW-1,1)) * (ny-1)), ny-1);
        const v0 = px[zi0 * nx * ny + yIdx * nx + xIdx] > 0 ? 1 : 0;
        const v1 = px[zi1 * nx * ny + yIdx * nx + xIdx] > 0 ? 1 : 0;
        if (v0*(1-tz)+v1*tz > 0.5) { const i=(zy*outW+y)*4; sd[i]=255;sd[i+1]=40;sd[i+2]=40;sd[i+3]=255; }
      }
    }
    mc.putImageData(si, 0, 0);
    ctx.save(); ctx.globalAlpha = 0.5;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(maskOff, ox, oy, dstW, dstH);
    ctx.restore();
  }

  // Crosshairs
  ctx.save();
  ctx.strokeStyle = "rgba(100,180,255,0.75)";
  ctx.lineWidth = 1; ctx.setLineDash([4,4]);
  // Horizontal: current axial slice
  const hYs = oy + ((sliceIdx ?? 0) / Math.max(n-1,1)) * dstH;
  ctx.beginPath(); ctx.moveTo(0, hYs); ctx.lineTo(W, hYs); ctx.stroke();
  // Vertical: current coronalY plane
  if (coronalY != null) {
    const hXs = ox + (coronalY / Math.max(outW-1,1)) * dstW;
    ctx.strokeStyle = "rgba(80,220,120,0.75)";
    ctx.beginPath(); ctx.moveTo(hXs, 0); ctx.lineTo(hXs, H); ctx.stroke();
  }
  ctx.restore();
  return { ox, oy, dstW, dstH };
}



export default function DicomCanvasViewer({ jobId, dicomImageIds }) {
  const axialRef    = useRef(null);
  const coronalRef  = useRef(null);
  const sagittalRef = useRef(null);
  const dragRef          = useRef({ on: false, btn: -1, sx: 0, sy: 0, panStart: null, wcStart: 0, wwStart: 0 });
  const axialTransform   = useRef(null);
  const coronalTransform = useRef(null);
  const sagittalTransform= useRef(null);

  const [status,    setStatus]    = useState("idle");
  const [errMsg,    setErrMsg]    = useState(null);
  const [progress,  setProgress]  = useState(0);
  const [slices,    setSlices]    = useState([]);
  const [segData,   setSegData]   = useState(null);
  const [segLoaded, setSegLoaded] = useState(false);
  const [showSeg,   setShowSeg]   = useState(true);
  const [sliceIdx,  setSliceIdx]  = useState(0);
  const [winIdx,    setWinIdx]    = useState(0);
  const [wc, setWc] = useState(WINDOWS[0].wc);
  const [ww, setWw] = useState(WINDOWS[0].ww);
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const [coronalY,  setCoronalY]  = useState(256);
  const [sagittalX, setSagittalX] = useState(256);

  // Anisotropy scale factor: sliceThickness / pixelSpacing
  // Computed once from the first loaded slice and memoized.
  // Typical CT chest: pixelSpacing ≈ 0.7 mm, sliceThickness ≈ 2.5–5 mm → scale ≈ 3.5–7
  const spacingScale = useMemo(() => {
    if (!slices.length) return 1;
    const { pixelSpacing = 1, sliceThickness = 1 } = slices[0];
    const s = sliceThickness / pixelSpacing;
    return Number.isFinite(s) && s > 0 ? s : 1;
  }, [slices]);

  useEffect(() => {
    if (!jobId || !dicomImageIds?.length) return;
    let cancelled = false;
    async function load() {
      setStatus("loading"); setProgress(0);
      setSlices([]); setSegData(null); setSegLoaded(false);
      const urls = dicomImageIds.map(p => `/api${p}`);
      const loaded = [];
      for (let i = 0; i < urls.length; i += 8) {
        if (cancelled) return;
        const res = await Promise.all(urls.slice(i, i+8).map(fetchDicom));
        loaded.push(...res);
        setProgress(Math.round(loaded.length / urls.length * 100));
      }
      if (cancelled) return;
      // ── Sort by physical Z position (ImagePositionPatient) ─────────────────
      // This is the definitive fix for the MPR stripe artifact.
      // Slices from the API arrive in filename order (arbitrary). If not sorted
      // by Z, renderCoronal/renderSagittal interpolate between anatomically
      // unrelated slices → the "barcode noise" visible in the screenshot.
      // We sort DESCENDING so slice[0] = highest Z = head (radiological convention).
      const hasZ = loaded.some(s => Number.isFinite(s.zPos));
      const sorted = hasZ
        ? [...loaded].sort((a, b) => (b.zPos ?? 0) - (a.zPos ?? 0))
        : loaded; // fallback: keep original order if Z metadata is missing
      setSlices(sorted);
      setSliceIdx(Math.floor(sorted.length / 2));
      setCoronalY(Math.floor((sorted[0]?.rows || 512) / 2));
      setSagittalX(Math.floor((sorted[0]?.cols || 512) / 2));
      setStatus("ready");
      fetch(`/api/nifti/${jobId}`, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} })
        .then(r => r.ok ? r.arrayBuffer() : null)
        .then(buf => buf ? parseNifti(buf) : null)
        .then(seg => { if (!cancelled && seg) { setSegData(seg); setSegLoaded(true); } })
        .catch(() => {});
    }
    load().catch(e => { if (!cancelled) { setStatus("error"); setErrMsg(e.message); } });
    return () => { cancelled = true; };
  }, [jobId]);

  // Calcular qué slices tienen segmentación
  const segmentedSlices = useMemo(() => {
    if (!segData || !slices.length) return new Set();
    const { nx, ny, nz, px, zFlip } = segData;
    const result = new Set();
    for (let z = 0; z < slices.length; z++) {
      const t = z / Math.max(slices.length - 1, 1);
      const tN = zFlip ? (1 - t) : t;
      const zIdx = Math.min(Math.round(tN * (nz - 1)), nz - 1);
      const start = zIdx * nx * ny;
      for (let i = start; i < start + nx * ny; i++) {
        if (px[i] > 0) { result.add(z); break; }
      }
    }
    return result;
  }, [segData, slices.length]);

  // Segmented Y-rows (for coronal scroll strip)
  const segYInMask = useMemo(() => {
    if (!segData) return new Set();
    const { nx, ny, px } = segData;
    const result = new Set();
    for (let i = 0; i < px.length; i++) {
      if (px[i] > 0) result.add(Math.floor((i % (nx * ny)) / nx));
    }
    return result;
  }, [segData]);

  // Segmented X-columns (for sagittal scroll strip)
  const segXInMask = useMemo(() => {
    if (!segData) return new Set();
    const { nx, px } = segData;
    const result = new Set();
    for (let i = 0; i < px.length; i++) {
      if (px[i] > 0) result.add(i % nx);
    }
    return result;
  }, [segData]);

  const getSegSlice = useCallback(() => {
    if (!segData || !slices.length) return null;
    const { nx, ny, nz, px, zFlip } = segData;

    // El backend ya resampleó la máscara al espacio del DICOM original:
    // nx == cols, ny == rows → mapeo 1:1, sin necesidad de escalar x/y.
    // Solo aplicamos zFlip para la correspondencia de cortes.
    const t = sliceIdx / Math.max(slices.length - 1, 1);
    const tN = zFlip ? (1 - t) : t;
    const zIdx = Math.min(Math.round(tN * (nz - 1)), nz - 1);

    // Devolver el plano z directamente (ya tiene las dimensiones correctas)
    return px.slice(zIdx * nx * ny, (zIdx + 1) * nx * ny);
  }, [segData, sliceIdx, slices]);


  // Render axial + crosshairs
  useEffect(() => {
    if (status !== "ready" || !slices.length) return;
    const canvas = axialRef.current;
    if (!canvas) return;
    const transform = renderAxial(canvas, slices[sliceIdx], wc, ww, zoom, pan, getSegSlice(), showSeg && segLoaded);
    axialTransform.current = transform;
    drawAxialCrosshairs(canvas, transform, coronalY, sagittalX);
  }, [status, sliceIdx, slices, wc, ww, zoom, pan, showSeg, segLoaded, getSegSlice, coronalY, sagittalX]);

  // Render coronal
  useEffect(() => {
    if (status !== "ready" || !slices.length) return;
    const canvas = coronalRef.current;
    if (!canvas) return;
    const t = renderCoronal(canvas, slices, coronalY, wc, ww, showSeg && segLoaded ? segData : null, showSeg && segLoaded, sliceIdx, spacingScale, sagittalX);
    coronalTransform.current = t;
  }, [status, slices, coronalY, sliceIdx, wc, ww, showSeg, segLoaded, segData, spacingScale, sagittalX]);

  // Render sagittal
  useEffect(() => {
    if (status !== "ready" || !slices.length) return;
    const canvas = sagittalRef.current;
    if (!canvas) return;
    const t = renderSagittal(canvas, slices, sagittalX, wc, ww, showSeg && segLoaded ? segData : null, showSeg && segLoaded, sliceIdx, spacingScale, coronalY);
    sagittalTransform.current = t;
  }, [status, slices, sagittalX, sliceIdx, wc, ww, showSeg, segLoaded, segData, spacingScale, coronalY]);

  // Resize observer with debounce and proper cleanup
  useEffect(() => {
    const observers = [
      { ref: axialRef, render: () => {
        if (status==="ready"&&slices.length) {
          const t = renderAxial(axialRef.current, slices[sliceIdx], wc, ww, zoom, pan, getSegSlice(), showSeg&&segLoaded);
          axialTransform.current = t;
          drawAxialCrosshairs(axialRef.current, t, coronalY, sagittalX);
        }
      }},
      { ref: coronalRef, render: () => {
        if (status==="ready"&&slices.length) { const t=renderCoronal(coronalRef.current, slices, coronalY, wc, ww, showSeg&&segLoaded?segData:null, showSeg&&segLoaded, sliceIdx, spacingScale, sagittalX); coronalTransform.current=t; }
      }},
      { ref: sagittalRef, render: () => {
        if (status==="ready"&&slices.length) { const t=renderSagittal(sagittalRef.current, slices, sagittalX, wc, ww, showSeg&&segLoaded?segData:null, showSeg&&segLoaded, sliceIdx, spacingScale, coronalY); sagittalTransform.current=t; }
      }}
    ].map(({ ref, render }) => {
      if (!ref.current?.parentElement) return null;
      let timeoutId;
      let isFirst = true;
      const obs = new ResizeObserver(([e]) => {
        if (ref.current) {
          const w = e.contentRect.width;
          const h = e.contentRect.height;
          
          if (isFirst || ref.current.width === 0 || ref.current.width === 300) {
            // Primera ejecución: actualizar resolución y renderizar inmediatamente para evitar distorsión inicial
            isFirst = false;
            ref.current.width = w;
            ref.current.height = h;
            render();
          } else {
            // Resize posteriores: debounce para evitar congelamiento de UI
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
              if (ref.current) {
                ref.current.width = w;
                ref.current.height = h;
                render();
              }
            }, 100);
          }
        }
      });
      obs.observe(ref.current.parentElement);
      return { obs, cleanup: () => clearTimeout(timeoutId) };
    });

    return () => {
      observers.forEach(item => {
        if (item) {
          item.cleanup();
          item.obs.disconnect();
        }
      });
    };
  }, [status, sliceIdx, slices, wc, ww, zoom, pan, showSeg, segLoaded, segData, coronalY, sagittalX, getSegSlice, spacingScale]);

  function applyPreset(i) { setWinIdx(i); setWc(WINDOWS[i].wc); setWw(WINDOWS[i].ww); }
  function jumpToSeg(dir) {
    const arr = [...segmentedSlices].sort((a,b)=>a-b);
    if (!arr.length) return;
    if (dir > 0) { const n = arr.find(s=>s>sliceIdx); if (n!=null) setSliceIdx(n); }
    else { const n = [...arr].reverse().find(s=>s<sliceIdx); if (n!=null) setSliceIdx(n); }
  }

  // ── Manual Wheel Listener (Non-Passive) ──────────────────────────────────
  // Browsers make wheel events passive by default, so React's onWheel
  // can't prevent page scroll. We attach it manually to the refs.
  useEffect(() => {
    const refs = [axialRef, coronalRef, sagittalRef];
    const handlers = [];

    refs.forEach((ref, idx) => {
      const container = ref.current?.parentElement;
      if (!container) return;

      const handleWheel = (e) => {
        e.preventDefault(); // Stop page scroll
        if (idx === 0) { // Axial view logic
          if (e.ctrlKey) {
            setZoom(z => Math.max(0.25, Math.min(8, z * (e.deltaY > 0 ? 0.9 : 1.1))));
          } else {
            setSliceIdx(i => Math.max(0, Math.min(slices.length - 1, i + (e.deltaY > 0 ? 1 : -1))));
          }
        } else if (idx === 1) { // Coronal
          setCoronalY(y => Math.max(0, Math.min((slices[0]?.rows || 512) - 1, y + (e.deltaY > 0 ? 4 : -4))));
        } else if (idx === 2) { // Sagittal
          setSagittalX(x => Math.max(0, Math.min((slices[0]?.cols || 512) - 1, x + (e.deltaY > 0 ? 4 : -4))));
        }
      };

      container.addEventListener("wheel", handleWheel, { passive: false });
      handlers.push({ container, handleWheel });
    });

    return () => {
      handlers.forEach(({ container, handleWheel }) => container.removeEventListener("wheel", handleWheel));
    };
  }, [status, slices, slices.length]);

  /** Click on axial canvas → update coronalY + sagittalX for MPR sync */
  function onAxialClick(e) {
    if (dragRef.current.on) return;
    const canvas = axialRef.current;
    const t = axialTransform.current;
    if (!canvas || !t) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    const xi = Math.round((cx - t.ox) / t.scale);
    const yi = Math.round((cy - t.oy) / t.scale);
    if (xi >= 0 && xi < (slices[0]?.cols ?? 512)) setSagittalX(xi);
    if (yi >= 0 && yi < (slices[0]?.rows ?? 512)) setCoronalY(yi);
  }
  /** Axial hover → real-time crosshair update (not dragging) */
  function onAxialHover(e) {
    if (dragRef.current.on) return;
    const canvas = axialRef.current;
    const t = axialTransform.current;
    if (!canvas || !t || !slices.length) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    const xi = Math.round((cx - t.ox) / t.scale);
    const yi = Math.round((cy - t.oy) / t.scale);
    if (xi >= 0 && xi < (slices[0]?.cols ?? 512)) setSagittalX(xi);
    if (yi >= 0 && yi < (slices[0]?.rows ?? 512)) setCoronalY(yi);
  }
  /** Coronal hover → update sagittalX and sliceIdx */
  function onCoronalHover(e) {
    const t = coronalTransform.current;
    if (!t || !slices.length) return;
    const canvas = coronalRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const relX = Math.max(0, Math.min(1, (cx - t.ox) / t.dstW));
    const relY = Math.max(0, Math.min(1, (cy - t.oy) / t.dstH));
    const xi = Math.round(relX * ((slices[0]?.cols ?? 512) - 1));
    const zi = Math.round(relY * (slices.length - 1));
    setSagittalX(xi);
    setSliceIdx(zi);
  }
  /** Sagittal hover → update coronalY and sliceIdx */
  function onSagittalHover(e) {
    const t = sagittalTransform.current;
    if (!t || !slices.length) return;
    const canvas = sagittalRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const relX = Math.max(0, Math.min(1, (cx - t.ox) / t.dstW));
    const relY = Math.max(0, Math.min(1, (cy - t.oy) / t.dstH));
    const yi = Math.round(relX * ((slices[0]?.rows ?? 512) - 1));
    const zi = Math.round(relY * (slices.length - 1));
    setCoronalY(yi);
    setSliceIdx(zi);
  }
  function onDown(e) { e.preventDefault(); dragRef.current={on:true,btn:e.button,sx:e.clientX,sy:e.clientY,panStart:{...pan},wcStart:wc,wwStart:ww}; }
  function onMove(e) {
    const d=dragRef.current;
    if (!d.on) return;
    const dx=e.clientX-d.sx, dy=e.clientY-d.sy;
    if (d.btn===0){setWc(Math.round(d.wcStart-dy*4));setWw(Math.max(1,Math.round(d.wwStart+dx*8)));setWinIdx(-1);}
    else if(d.btn===2) setPan({x:d.panStart.x+dx,y:d.panStart.y+dy});
  }
  function onUp() { dragRef.current.on=false; }

  const n = slices.length;
  const segArr = [...segmentedSlices].sort((a,b)=>a-b);
  const hasSegHere = segmentedSlices.has(sliceIdx);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Toolbar / Header */}
      <div className="flex flex-wrap items-center justify-between px-5 py-3 border-b shrink-0 z-10 shadow-sm gap-4"
        style={{ backgroundColor: "var(--bg-sidebar)", borderColor: "var(--border-subtle)" }}>
        
        {/* Left: Slices and Navigation */}
        <div className="flex flex-wrap items-center gap-6">
          {/* Main Slice Counter */}
          {status==="ready" && (
            <div className="flex items-center gap-2.5 bg-black/20 px-3 py-1.5 rounded-lg border" style={{ borderColor: "var(--border-subtle)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)" }}>
              <Layers3 className="w-4 h-4" style={{ color: "var(--text-accent)" }} />
              <span className="text-sm font-mono font-bold tracking-wide" style={{ color: "var(--text-primary)" }}>
                {n} cortes
              </span>
            </div>
          )}

          {segLoaded && (
            <div className="flex items-center gap-3">
              {/* Toggle Segmentación IA */}
              <button
                onClick={() => setShowSeg(s => !s)}
                className="flex items-center gap-2.5 px-4 py-2 rounded-xl border-2 text-xs font-bold tracking-wide transition-all whitespace-nowrap"
                style={{
                  backgroundColor: showSeg ? "oklch(0.65 0.22 20/0.15)" : "transparent",
                  borderColor: showSeg ? "oklch(0.65 0.22 20/0.55)" : "var(--border-subtle)",
                  color: showSeg ? "oklch(0.80 0.22 20)" : "var(--text-muted)"
                }}
              >
                {showSeg ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                Segmentación IA
                <span
                  className="w-2 h-2 rounded-full ml-1 transition-colors"
                  style={{ backgroundColor: showSeg ? "oklch(0.65 0.22 20)" : "var(--text-muted)" }}
                />
              </button>
              {/* Navigation between hallazgos */}
              {segArr.length > 0 && (
                <div className="flex items-center gap-1 bg-black/20 rounded-lg border px-1" style={{ borderColor: "var(--border-subtle)" }}>
                  <button onClick={() => jumpToSeg(-1)} title="Hallazgo anterior" className="p-1.5 rounded-md hover:bg-white/10 transition-colors" style={{ color: "var(--text-secondary)" }}><SkipBack className="w-3.5 h-3.5"/></button>
                  <span className="text-[11px] font-mono font-semibold px-2" style={{ color: hasSegHere ? "oklch(0.75 0.22 20)" : "var(--text-muted)" }}>
                    {hasSegHere ? "●" : "○"} {segArr.length} hallazgos
                  </span>
                  <button onClick={() => jumpToSeg(1)} title="Siguiente hallazgo" className="p-1.5 rounded-md hover:bg-white/10 transition-colors" style={{ color: "var(--text-secondary)" }}><SkipForward className="w-3.5 h-3.5"/></button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Presets and Status */}
        <div className="flex flex-wrap items-center gap-6">
          {status==="loading" && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-black/20 rounded-lg border shrink-0" style={{ borderColor: "var(--border-subtle)" }}>
              <Loader className="w-4 h-4 animate-spin" style={{ color:"var(--text-accent)" }}/>
              <span className="text-xs font-bold" style={{ color:"var(--text-primary)" }}>{progress}%</span>
            </div>
          )}
          
          <div className="flex flex-wrap items-center gap-2 bg-black/20 rounded-lg border p-1.5" style={{ borderColor: "var(--border-subtle)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)" }}>
            {WINDOWS.map((w,i)=>(
              <button key={w.label} onClick={()=>applyPreset(i)} className="text-[11px] px-4 py-1.5 rounded-md font-bold transition-all uppercase tracking-wider shrink-0 whitespace-nowrap"
                style={{ 
                  backgroundColor: i===winIdx ? "var(--bg-elevated)" : "transparent",
                  color: i===winIdx ? "var(--text-primary)" : "var(--text-muted)",
                  boxShadow: i===winIdx ? "0 1px 3px rgba(0,0,0,0.2)" : "none"
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {status==="loading" && <div style={{ height:"2px",backgroundColor:"var(--bg-card)" }}><div style={{ height:"100%",width:`${progress}%`,backgroundColor:"var(--text-accent)",transition:"width 0.3s" }}/></div>}

      {status==="error" && (
        <div className="flex items-start gap-3 p-5" style={{ backgroundColor:"oklch(0.65 0.20 20/0.08)" }}>
          <AlertTriangle className="w-5 h-5 shrink-0" style={{ color:"oklch(0.65 0.20 20)" }}/>
          <div><p className="text-sm font-semibold" style={{ color:"oklch(0.65 0.20 20)" }}>Error</p><p className="text-xs mt-1 font-mono" style={{ color:"var(--text-muted)" }}>{errMsg}</p></div>
        </div>
      )}

      {/* Grid wrapper — takes all remaining flex space; grid fills it absolutely */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, right: "80px", top: 0, bottom: 0, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", backgroundColor:"#000" }}>

        {/* ── Axial ─────────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ backgroundColor:"#000", cursor:"crosshair", borderRight:"1px solid oklch(0.2 0 0)" }}
          onMouseDown={onDown} onMouseMove={onMove}
          onMouseUp={onUp} onMouseLeave={onUp}
          onClick={onAxialClick} onContextMenu={e=>e.preventDefault()}>
          <canvas ref={axialRef} style={{ width:"100%", height:"100%", display:"block" }}/>
          {status==="ready" && (
            <>
              {/* Label top-left */}
              <div className="absolute top-2 left-2 z-10 pointer-events-none select-none flex flex-col gap-0.5">
                <span className="text-[13px] font-mono font-bold tracking-widest" style={{ color: "oklch(0.72 0.17 195)" }}>AXIAL</span>
                <span className="text-[11px] font-mono" style={{ color: "oklch(0.50 0 0)" }}>WC {wc} | WW {ww}</span>
                {hasSegHere && showSeg && <span className="text-[11px] font-mono" style={{ color:"oklch(0.75 0.22 20)" }}>● Hallazgo</span>}
              </div>
              {/* Slice counter top-right */}
              <div className="absolute top-2 right-2 z-10 text-[13px] font-mono font-bold pointer-events-none select-none" style={{ color: "oklch(0.72 0.17 195)" }}>
                {sliceIdx + 1} <span className="text-[12px] font-bold">/ {n}</span>
              </div>
              {/* Seg legend bottom-left */}
              {showSeg && segArr.length > 0 && (
                <div className="absolute bottom-16 left-3 flex items-center gap-1.5 text-[10px] pointer-events-none select-none">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor:"rgba(255,60,60,0.6)" }}/>
                  <span style={{ color:"oklch(0.75 0.22 20)" }}>Región segmentada · {segArr.length} cortes</span>
                </div>
              )}
              {/* Zoom controls overlaid bottom-right */}
              <div className="absolute bottom-16 right-3 flex items-center gap-1.5 bg-black/60 rounded-xl border px-2 py-1.5 backdrop-blur-md shadow-2xl pointer-events-auto" style={{ borderColor: "oklch(0.3 0 0)" }}>
                <button onClick={(e) => { e.stopPropagation(); setZoom(z => Math.max(0.25, z - 0.25)) }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors text-white/80 hover:text-white" title="Alejar (Zoom Out)"><ZoomOut className="w-5 h-5"/></button>
                <span className="text-[13px] font-mono font-bold w-12 text-center text-white/90 select-none">{Math.round(zoom * 100)}%</span>
                <button onClick={(e) => { e.stopPropagation(); setZoom(z => Math.min(8, z + 0.25)) }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors text-white/80 hover:text-white" title="Acercar (Zoom In)"><ZoomIn className="w-5 h-5"/></button>
                <div className="w-px h-6 bg-white/20 mx-0.5"></div>
                <button onClick={(e) => { e.stopPropagation(); setZoom(1); setPan({x:0, y:0}); }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors text-white/80 hover:text-white" title="Centrar y restablecer vista"><LocateFixed className="w-5 h-5"/></button>
              </div>
              {/* Minimap strip */}
              <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2"
                style={{ backgroundColor:"rgba(0,0,0,0.75)", borderTop:"1px solid oklch(0.25 0 0)" }}
                onClick={e => e.stopPropagation()}>
                <button onClick={()=>setSliceIdx(i=>Math.max(0,i-1))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white"
                  title="Corte anterior"><ChevronLeft className="w-4 h-4"/></button>
                <div className="relative flex-1 h-8 rounded-md overflow-hidden" style={{ backgroundColor:"rgba(255,255,255,0.1)" }}>
                  {Array.from({length:Math.min(n,200)},(_,i)=>{
                    const si=Math.round(i/Math.min(n,200)*n);
                    const isAct=Math.abs(si-sliceIdx)<2;
                    const hasSeg=segmentedSlices.has(si);
                    return <div key={i} onClick={()=>setSliceIdx(si)}
                      style={{ position:"absolute", left:`${(i/Math.min(n,200))*100}%`, top:0, bottom:0,
                        width:`calc(${100/Math.min(n,200)}% + 1px)`, cursor:"pointer",
                        backgroundColor:isAct?"rgba(255,255,255,0.9)":hasSeg?"rgba(255,60,60,0.7)":"transparent" }}/>;
                  })}
                </div>
                <button onClick={()=>setSliceIdx(i=>Math.min(n-1,i+1))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white"
                  title="Corte siguiente"><ChevronRight className="w-4 h-4"/></button>
                <span className="text-xs font-mono font-bold ml-2 min-w-[50px] text-right text-white/90">{sliceIdx+1}/{n}</span>
              </div>
            </>
          )}
          {status==="loading" && <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-8 h-8 animate-spin" style={{ color:"var(--text-accent)" }}/></div>}
        </div>

        {/* ── Coronal ───────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ borderRight:"1px solid oklch(0.2 0 0)", cursor:"crosshair" }}
          onClick={e=>{
            // click on coronal → jump to that axial slice
            const canvas = coronalRef.current;
            if (!canvas || !slices.length) return;
            const rect = canvas.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / rect.height;
            const targetZ = Math.round(relY * (slices.length - 1));
            if (targetZ >= 0 && targetZ < slices.length) setSliceIdx(targetZ);
          }}>
          <canvas ref={coronalRef} style={{ width:"100%", height:"100%", display:"block" }}/>
          {status!=="ready" && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
            justifyContent:"center", color:"oklch(0.35 0 0)", fontSize:"10px", fontFamily:"monospace" }}>CORONAL</div>}
          {/* Label + position */}
          <div className="absolute top-2 left-2 z-10 pointer-events-none select-none flex flex-col gap-0.5">
            <span className="text-[13px] font-mono font-bold tracking-widest" style={{ color: "oklch(0.68 0.20 145)" }}>CORONAL</span>
          </div>
          <div className="absolute top-2 right-2 z-10 text-[13px] font-mono font-bold pointer-events-none select-none" style={{ color: "oklch(0.68 0.20 145)" }}>
            {coronalY + 1} <span className="text-[12px] font-bold">/ {slices[0]?.rows || 512}</span>
          </div>
          {status==="ready" && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2"
              style={{ backgroundColor:"rgba(0,0,0,0.75)", borderTop:"1px solid oklch(0.25 0 0)" }}
              onClick={e => e.stopPropagation()}>
              <button onClick={()=>setCoronalY(y=>Math.max(0,y-4))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white" title="Desplazar plano"><ChevronLeft className="w-4 h-4"/></button>
              <div className="relative flex-1 h-8 rounded-md overflow-hidden" style={{backgroundColor:"rgba(255,255,255,0.1)"}}>
                {(() => {
                  const total = slices[0]?.rows || 512;
                  const ns = Math.min(total, 200);
                  const ny = segData?.ny || 1;
                  return Array.from({length:ns},(_,i) => {
                    const cy = Math.round((i/ns)*total);
                    const isAct = Math.abs(cy-coronalY) < Math.ceil(total/ns)*1.5;
                    const yi = segData ? Math.min(Math.round((cy/Math.max(total-1,1))*(ny-1)),ny-1) : -1;
                    const hasSeg = segYInMask.has(yi);
                    return <div key={i} onClick={()=>setCoronalY(cy)}
                      style={{position:"absolute",left:`${(i/ns)*100}%`,top:0,bottom:0,width:`calc(${100/ns}% + 1px)`,cursor:"pointer",
                        backgroundColor:isAct?"rgba(255,255,255,0.9)":hasSeg?"rgba(255,60,60,0.7)":"transparent"}}/>;
                  });
                })()}
              </div>
              <button onClick={()=>setCoronalY(y=>Math.min((slices[0]?.rows||512)-1,y+4))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white" title="Desplazar plano"><ChevronRight className="w-4 h-4"/></button>
              <span className="text-xs font-mono font-bold ml-2 min-w-[50px] text-right text-white/90">{coronalY+1}/{slices[0]?.rows||512}</span>
            </div>
          )}
        </div>

        {/* ── Sagittal ──────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ cursor:"crosshair" }}
          onClick={e=>{
            const canvas = sagittalRef.current;
            if (!canvas || !slices.length) return;
            const rect = canvas.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / rect.height;
            const targetZ = Math.round(relY * (slices.length - 1));
            if (targetZ >= 0 && targetZ < slices.length) setSliceIdx(targetZ);
          }}>
          <canvas ref={sagittalRef} style={{ width:"100%", height:"100%", display:"block" }}/>
          {status!=="ready" && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
            justifyContent:"center", color:"oklch(0.35 0 0)", fontSize:"10px", fontFamily:"monospace" }}>SAGITAL</div>}
          {/* Label + position */}
          <div className="absolute top-2 left-2 z-10 pointer-events-none select-none flex flex-col gap-0.5">
            <span className="text-[13px] font-mono font-bold tracking-widest" style={{ color: "oklch(0.80 0.16 80)" }}>SAGITAL</span>
          </div>
          <div className="absolute top-2 right-2 z-10 text-[13px] font-mono font-bold pointer-events-none select-none" style={{ color: "oklch(0.80 0.16 80)" }}>
            {sagittalX + 1} <span className="text-[12px] font-bold">/ {slices[0]?.cols || 512}</span>
          </div>
          {status==="ready" && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2"
              style={{ backgroundColor:"rgba(0,0,0,0.75)", borderTop:"1px solid oklch(0.25 0 0)" }}
              onClick={e => e.stopPropagation()}>
              <button onClick={()=>setSagittalX(x=>Math.max(0,x-4))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white" title="Desplazar plano"><ChevronLeft className="w-4 h-4"/></button>
              <div className="relative flex-1 h-8 rounded-md overflow-hidden" style={{backgroundColor:"rgba(255,255,255,0.1)"}}>
                {(() => {
                  const total = slices[0]?.cols || 512;
                  const ns = Math.min(total, 200);
                  const nx = segData?.nx || 1;
                  return Array.from({length:ns},(_,i) => {
                    const cx = Math.round((i/ns)*total);
                    const isAct = Math.abs(cx-sagittalX) < Math.ceil(total/ns)*1.5;
                    const xi = segData ? Math.min(Math.round((cx/Math.max(total-1,1))*(nx-1)),nx-1) : -1;
                    const hasSeg = segXInMask.has(xi);
                    return <div key={i} onClick={()=>setSagittalX(cx)}
                      style={{position:"absolute",left:`${(i/ns)*100}%`,top:0,bottom:0,width:`calc(${100/ns}% + 1px)`,cursor:"pointer",
                        backgroundColor:isAct?"rgba(255,255,255,0.9)":hasSeg?"rgba(255,60,60,0.7)":"transparent"}}/>;
                  });
                })()}
              </div>
              <button onClick={()=>setSagittalX(x=>Math.min((slices[0]?.cols||512)-1,x+4))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/20 transition-colors text-white/90 hover:text-white" title="Desplazar plano"><ChevronRight className="w-4 h-4"/></button>
              <span className="text-xs font-mono font-bold ml-2 min-w-[50px] text-right text-white/90">{sagittalX+1}/{slices[0]?.cols||512}</span>
            </div>
          )}
        </div>

        </div>{/* /grid (position:absolute, 3 columns) */}

        {/* ── W/L Slider — absolutely overlaid on right edge ────────── */}
        <div style={{ position:"absolute", right:0, top:0, bottom:0, width:"80px", zIndex:10,
          display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-evenly",
          borderLeft:"1px solid oklch(0.18 0 0)", backgroundColor:"oklch(0.08 0 0)", padding:"10px 6px" }}>

          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"6px" }}>
            <span style={{ fontSize:"12px", fontFamily:"monospace", color:"oklch(0.65 0 0)", textTransform:"uppercase", fontWeight:"bold" }}>WW</span>
            <span style={{ fontSize:"14px", fontFamily:"monospace", color:"oklch(0.72 0.17 195)", fontWeight:700 }}>{ww}</span>
            <input type="range" min={1} max={4096} value={ww}
              onChange={e=>{ setWw(+e.target.value); setWinIdx(-1); }}
              style={{ writingMode:"vertical-lr", direction:"rtl", height:"160px", cursor:"pointer",
                accentColor:"oklch(0.72 0.17 195)" }}/>
          </div>

          <div style={{ width:"80%", height:"1px", backgroundColor:"oklch(0.2 0 0)" }}/>

          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"6px" }}>
            <span style={{ fontSize:"12px", fontFamily:"monospace", color:"oklch(0.65 0 0)", textTransform:"uppercase", fontWeight:"bold" }}>WC</span>
            <span style={{ fontSize:"14px", fontFamily:"monospace", color:"oklch(0.80 0.16 80)", fontWeight:700 }}>{wc}</span>
            <input type="range" min={-1024} max={3071} value={wc}
              onChange={e=>{ setWc(+e.target.value); setWinIdx(-1); }}
              style={{ writingMode:"vertical-lr", direction:"rtl", height:"160px", cursor:"pointer",
                accentColor:"oklch(0.80 0.16 80)" }}/>
          </div>

        </div>
      </div>{/* /grid wrapper (flex:1 position:relative) */}

    </div>
  );
}
