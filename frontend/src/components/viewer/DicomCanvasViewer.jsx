import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import dicomParser from "dicom-parser";
import { Layers3, AlertTriangle, Loader, Eye, EyeOff, ChevronUp, ChevronDown, ZoomIn, ZoomOut, Maximize2, SkipForward, SkipBack } from "lucide-react";
import { API_KEY } from "@/api/client";

const WINDOWS = [
  { label: "Pulmón",     wc: -600, ww: 1500 },
  { label: "Mediastino", wc:   40, ww:  400 },
  { label: "Hueso",      wc:  400, ww: 1800 },
  { label: "Blando",     wc:   40, ww:  350 },
];

const sliceCache = new Map();
async function fetchDicom(url) {
  if (sliceCache.has(url)) return sliceCache.get(url);
  const res = await fetch(url, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  const ds = dicomParser.parseDicom(new Uint8Array(buf));
  const rows = parseInt(ds.string("x00280010")) || 512;
  const cols = parseInt(ds.string("x00280011")) || 512;
  const slope = parseFloat(ds.string("x00281053")) || 1;
  const inter = parseFloat(ds.string("x00281052")) || -1024;
  const bits  = parseInt(ds.string("x00280100")) || 16;
  const rep   = parseInt(ds.string("x00280103")) || 0;
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
function renderCoronal(canvas, slices, coronalY, wc, ww, segData, showSeg, sliceIdx, spacingScale) {
  if (!canvas || !slices.length) return;
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

  const hYc = oy + ((sliceIdx ?? 0) / Math.max(n-1,1)) * dstH;
  ctx.save(); ctx.strokeStyle = "rgba(100,180,255,0.7)";
  ctx.lineWidth = 1; ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(0, hYc); ctx.lineTo(W, hYc); ctx.stroke();
  ctx.restore();
}

/**
 * Renders the sagittal MPR plane with true Z linear interpolation.
 */
function renderSagittal(canvas, slices, sagittalX, wc, ww, segData, showSeg, sliceIdx, spacingScale) {
  if (!canvas || !slices.length) return;
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

  const hYs = oy + ((sliceIdx ?? 0) / Math.max(n-1,1)) * dstH;
  ctx.save(); ctx.strokeStyle = "rgba(100,180,255,0.7)";
  ctx.lineWidth = 1; ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(0, hYs); ctx.lineTo(W, hYs); ctx.stroke();
  ctx.restore();
}


export default function DicomCanvasViewer({ jobId, dicomImageIds }) {
  const axialRef    = useRef(null);
  const coronalRef  = useRef(null);
  const sagittalRef = useRef(null);
  const dragRef        = useRef({ on: false, btn: -1, sx: 0, sy: 0, panStart: null, wcStart: 0, wwStart: 0 });
  const axialTransform = useRef(null); // stores { ox, oy, scale } from last renderAxial call

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
    renderCoronal(canvas, slices, coronalY, wc, ww, showSeg && segLoaded ? segData : null, showSeg && segLoaded, sliceIdx, spacingScale);
  }, [status, slices, coronalY, sliceIdx, wc, ww, showSeg, segLoaded, segData, spacingScale]);

  // Render sagittal
  useEffect(() => {
    if (status !== "ready" || !slices.length) return;
    const canvas = sagittalRef.current;
    if (!canvas) return;
    renderSagittal(canvas, slices, sagittalX, wc, ww, showSeg && segLoaded ? segData : null, showSeg && segLoaded, sliceIdx, spacingScale);
  }, [status, slices, sagittalX, sliceIdx, wc, ww, showSeg, segLoaded, segData, spacingScale]);

  // Resize observer
  useEffect(() => {
    [{ ref: axialRef, render: () => {
      if (status==="ready"&&slices.length) renderAxial(axialRef.current, slices[sliceIdx], wc, ww, zoom, pan, getSegSlice(), showSeg&&segLoaded);
    }},{ ref: coronalRef, render: () => {
      if (status==="ready"&&slices.length) renderCoronal(coronalRef.current, slices, coronalY, wc, ww, showSeg&&segLoaded?segData:null, showSeg&&segLoaded, sliceIdx, spacingScale);
    }},{ ref: sagittalRef, render: () => {
      if (status==="ready"&&slices.length) renderSagittal(sagittalRef.current, slices, sagittalX, wc, ww, showSeg&&segLoaded?segData:null, showSeg&&segLoaded, sliceIdx, spacingScale);
    }}].forEach(({ ref, render }) => {
      if (!ref.current?.parentElement) return;
      const obs = new ResizeObserver(([e]) => {
        if (ref.current) { ref.current.width=e.contentRect.width; ref.current.height=e.contentRect.height; render(); }
      });
      obs.observe(ref.current.parentElement);
      return () => obs.disconnect();
    });
  }, [status, sliceIdx, slices, wc, ww, zoom, pan, showSeg, segLoaded, segData, coronalY, sagittalX, getSegSlice]);

  function applyPreset(i) { setWinIdx(i); setWc(WINDOWS[i].wc); setWw(WINDOWS[i].ww); }
  function resetView() { setZoom(1); setPan({ x:0, y:0 }); }
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
    if (dragRef.current.on) return; // ignore if it was a drag
    const canvas = axialRef.current;
    const t = axialTransform.current;
    if (!canvas || !t) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left)  * scaleX;
    const cy = (e.clientY - rect.top)   * scaleY;
    const xi = Math.round((cx - t.ox) / t.scale);
    const yi = Math.round((cy - t.oy) / t.scale);
    const imgCols = slices[0]?.cols ?? 512;
    const imgRows = slices[0]?.rows ?? 512;
    if (xi >= 0 && xi < imgCols) setSagittalX(xi);
    if (yi >= 0 && yi < imgRows) setCoronalY(yi);
  }
  function onDown(e) { e.preventDefault(); dragRef.current={on:true,btn:e.button,sx:e.clientX,sy:e.clientY,panStart:{...pan},wcStart:wc,wwStart:ww}; }
  function onMove(e) {
    const d=dragRef.current; if (!d.on) return;
    const dx=e.clientX-d.sx, dy=e.clientY-d.sy;
    if (d.btn===0){setWc(Math.round(d.wcStart-dy*4));setWw(Math.max(1,Math.round(d.wwStart+dx*8)));setWinIdx(-1);}
    else if(d.btn===2) setPan({x:d.panStart.x+dx,y:d.panStart.y+dy});
  }
  function onUp() { dragRef.current.on=false; }

  const n = slices.length;
  const segArr = [...segmentedSlices].sort((a,b)=>a-b);
  const hasSegHere = segmentedSlices.has(sliceIdx);

  return (
    <div className="glass-card overflow-hidden" style={{ padding: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b"
        style={{ backgroundColor: "var(--bg-input)", borderColor: "var(--border-subtle)" }}>
        <div className="flex items-center gap-3">
          <Layers3 className="w-5 h-5" style={{ color: "var(--text-accent)" }} />
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Visor CT</h3>
          {status==="ready" && <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor:"oklch(0.72 0.17 195/0.15)",color:"oklch(0.72 0.17 195)" }}>{n} slices</span>}
          {segLoaded && (
            <button onClick={()=>setShowSeg(s=>!s)} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all"
              style={{ backgroundColor:showSeg?"oklch(0.65 0.22 20/0.2)":"var(--bg-card)", color:showSeg?"oklch(0.75 0.22 20)":"var(--text-muted)", border:`1px solid ${showSeg?"oklch(0.65 0.22 20/0.4)":"var(--border-subtle)"}` }}>
              {showSeg?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}
              Segmentación {segArr.length>0 && `(${segArr.length} cortes)`}
            </button>
          )}
          {segLoaded && segArr.length > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={()=>jumpToSeg(-1)} title="Anterior hallazgo" className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color:"var(--text-muted)" }}><SkipBack className="w-4 h-4"/></button>
              <span className="text-[10px]" style={{ color:"var(--text-muted)" }}>{hasSegHere?"● hallazgo aquí":""}</span>
              <button onClick={()=>jumpToSeg(1)} title="Siguiente hallazgo" className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color:"var(--text-muted)" }}><SkipForward className="w-4 h-4"/></button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status==="loading" && <div className="flex items-center gap-2 mr-2"><Loader className="w-4 h-4 animate-spin" style={{ color:"var(--text-accent)" }}/><span className="text-xs" style={{ color:"var(--text-muted)" }}>{progress}%</span></div>}
          {WINDOWS.map((w,i)=>(
            <button key={w.label} onClick={()=>applyPreset(i)} className="text-[10px] px-2 py-1 rounded font-medium transition-all"
              style={{ backgroundColor:i===winIdx?"var(--text-accent)":"var(--bg-card)",color:i===winIdx?"#fff":"var(--text-muted)" }}>{w.label}</button>
          ))}
          <div className="w-px h-4" style={{ backgroundColor:"var(--border-subtle)" }}/>
          <button onClick={()=>setZoom(z=>Math.min(8,z+0.25))} className="p-1 rounded hover:bg-white/10" style={{ color:"var(--text-muted)" }}><ZoomIn className="w-4 h-4"/></button>
          <button onClick={()=>setZoom(z=>Math.max(0.25,z-0.25))} className="p-1 rounded hover:bg-white/10" style={{ color:"var(--text-muted)" }}><ZoomOut className="w-4 h-4"/></button>
          <button onClick={resetView} className="p-1 rounded hover:bg-white/10" style={{ color:"var(--text-muted)" }}><Maximize2 className="w-4 h-4"/></button>
        </div>
      </div>

      {status==="loading" && <div style={{ height:"2px",backgroundColor:"var(--bg-card)" }}><div style={{ height:"100%",width:`${progress}%`,backgroundColor:"var(--text-accent)",transition:"width 0.3s" }}/></div>}

      {status==="error" && (
        <div className="flex items-start gap-3 p-5" style={{ backgroundColor:"oklch(0.65 0.20 20/0.08)" }}>
          <AlertTriangle className="w-5 h-5 shrink-0" style={{ color:"oklch(0.65 0.20 20)" }}/>
          <div><p className="text-sm font-semibold" style={{ color:"oklch(0.65 0.20 20)" }}>Error</p><p className="text-xs mt-1 font-mono" style={{ color:"var(--text-muted)" }}>{errMsg}</p></div>
        </div>
      )}

      {/* ── 3-panel MPR layout: Axial | Coronal | Sagittal ───────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr", height:"640px", backgroundColor:"#000" }}>

        {/* ── Axial ─────────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ backgroundColor:"#000", cursor:"crosshair", borderRight:"1px solid oklch(0.2 0 0)" }}
          onMouseDown={onDown} onMouseMove={onMove}
          onMouseUp={onUp} onMouseLeave={onUp}
          onClick={onAxialClick} onContextMenu={e=>e.preventDefault()}>
          <canvas ref={axialRef} style={{ width:"100%", height:"100%", display:"block" }}/>
          {status==="ready" && (
            <>
              <div className="absolute top-2 left-2 text-[10px] font-mono pointer-events-none select-none"
                style={{ color:"oklch(0.75 0 0)", lineHeight:1.7 }}>
                <div>AXIAL — Slice {sliceIdx+1}/{n}</div>
                <div>WC {wc} | WW {ww}</div>
                {hasSegHere && showSeg && <div style={{ color:"oklch(0.75 0.22 20)" }}>● Hallazgo en este corte</div>}
              </div>
              {showSeg && segArr.length>0 && (
                <div className="absolute bottom-8 left-2 flex items-center gap-1.5 text-[10px] pointer-events-none select-none">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor:"rgba(255,60,60,0.6)" }}/>
                  <span style={{ color:"oklch(0.75 0.22 20)" }}>Región segmentada · {segArr.length} cortes</span>
                </div>
              )}
              {/* Minimap strip */}
              <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1 px-2 py-1"
                style={{ backgroundColor:"rgba(0,0,0,0.65)", borderTop:"1px solid oklch(0.2 0 0)" }}>
                <button onClick={()=>setSliceIdx(i=>Math.max(0,i-1))} className="p-0.5 rounded hover:bg-white/10"
                  style={{ color:"var(--text-muted)" }}><ChevronUp className="w-3 h-3"/></button>
                <div className="relative flex-1 h-4 rounded overflow-hidden" style={{ backgroundColor:"rgba(255,255,255,0.05)" }}>
                  {Array.from({length:Math.min(n,200)},(_,i)=>{
                    const si=Math.round(i/Math.min(n,200)*n);
                    const isAct=Math.abs(si-sliceIdx)<2;
                    const hasSeg=segmentedSlices.has(si);
                    return <div key={i} onClick={()=>setSliceIdx(si)}
                      style={{ position:"absolute", left:`${(i/Math.min(n,200))*100}%`, top:0, bottom:0,
                        width:`${100/Math.min(n,200)}%`, cursor:"pointer",
                        backgroundColor:isAct?"rgba(255,255,255,0.9)":hasSeg?"rgba(255,60,60,0.7)":"transparent" }}/>;
                  })}
                </div>
                <button onClick={()=>setSliceIdx(i=>Math.min(n-1,i+1))} className="p-0.5 rounded hover:bg-white/10"
                  style={{ color:"var(--text-muted)" }}><ChevronDown className="w-3 h-3"/></button>
                <span className="text-[9px] font-mono ml-1" style={{ color:"oklch(0.5 0 0)" }}>{sliceIdx+1}/{n}</span>
              </div>
            </>
          )}
          {status==="loading" && <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-8 h-8 animate-spin" style={{ color:"var(--text-accent)" }}/></div>}
        </div>

        {/* ── Coronal ───────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ borderRight:"1px solid oklch(0.2 0 0)", cursor:"ns-resize" }}
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
          <div className="absolute top-1 left-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.72 0.17 195)" }}>CORONAL</div>
          <div className="absolute top-1 right-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.5 0 0)" }}>Y={coronalY} ↕scroll</div>
          <div className="absolute bottom-1 left-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.45 0 0)" }}>click→saltar corte</div>
        </div>

        {/* ── Sagittal ──────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden"
          style={{ cursor:"ns-resize" }}
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
          <div className="absolute top-1 left-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.80 0.16 80)" }}>SAGITAL</div>
          <div className="absolute top-1 right-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.5 0 0)" }}>X={sagittalX} ↕scroll</div>
          <div className="absolute bottom-1 left-2 z-10 text-[10px] font-mono pointer-events-none select-none"
            style={{ color:"oklch(0.45 0 0)" }}>click→saltar corte</div>
        </div>

      </div>


      {status==="ready" && (
        <div className="flex items-center gap-5 px-5 py-2 border-t text-[10px]" style={{ backgroundColor:"var(--bg-input)",borderColor:"var(--border-subtle)",color:"var(--text-muted)" }}>
          {[["Scroll","Axial"],["Click axial","Sync MPR"],["Ctrl+Scroll","Zoom"],["Click izq+drag","W/L"],["Click der+drag","Pan"],["Coronal ↕","Plano Y"],["Sagital ↕","Plano X"]].map(([k,a])=>(
            <span key={k}><span className="font-mono px-1.5 py-0.5 rounded mr-1" style={{ backgroundColor:"var(--bg-card)" }}>{k}</span>{a}</span>
          ))}
        </div>
      )}
    </div>
  );
}
