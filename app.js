// SmartBoard MVP — single file behavior
// Uses: canvas drawing, pages (array of image data), basic undo/redo (snapshot), shapes, text, image upload, zoom/pan
// Modern browsers assumed. Use module type in index.html

const canvas = document.getElementById('boardCanvas');
const container = document.getElementById('canvasContainer');
const ctx = canvas.getContext('2d', { alpha: true });

// UI elements
const tools = document.querySelectorAll('.tool');
const colorInput = document.getElementById('color');
const sizeInput = document.getElementById('size');
const opacityInput = document.getElementById('opacity');
const imgInput = document.getElementById('imgInput');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clearPage');
const exportBtn = document.getElementById('exportBtn');
const saveLocal = document.getElementById('saveLocal');
const loadLocal = document.getElementById('loadLocal');
const prevPage = document.getElementById('prevPage');
const nextPage = document.getElementById('nextPage');
const addPage = document.getElementById('addPage');
const pageIndicator = document.getElementById('pageIndicator');
const pagesList = document.getElementById('pagesList');
const layersList = document.getElementById('layersList');
const fitBtn = document.getElementById('fitBtn');
const recordBtn = document.getElementById('recordBtn');
const downloadRecording = document.getElementById('downloadRecording');

// State
let state = {
  tool: 'pen',
  color: '#22d3ee',
  size: 4,
  opacity: 1,
  isDrawing: false,
  lastPos: null,
  scale: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  pointerId: null,
  shapeStart: null,
  pages: [],  // each page: {id, snapshotDataURL}
  pageIndex: 0,
  undoStack: [],
  redoStack: [],
  recordingChunks: [],
  recorder: null
};

// init canvas size to fit container
function resizeCanvas() {
  const rect = container.getBoundingClientRect();
  const DPR = window.devicePixelRatio || 1;
  // choose a drawing logical size with good DPI (e.g., 1600x900 base scaled by container)
  const w = Math.max(1200, Math.floor(rect.width * 1.2));
  const h = Math.max(700, Math.floor(rect.height * 1.2));
  canvas.width = Math.floor(w * DPR);
  canvas.height = Math.floor(h * DPR);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(DPR,0,0,DPR,0,0); // scale to device pixels
  redraw(); // re-render current page content
}

window.addEventListener('resize', () => {
  // preserve current page snapshot and re-render
  resizeCanvas();
});

function ensurePages() {
  if (state.pages.length === 0) {
    state.pages.push(makeBlankPage());
  }
  if (state.pageIndex < 0) state.pageIndex = 0;
  if (state.pageIndex >= state.pages.length) state.pageIndex = state.pages.length - 1;
  refreshPagesUI();
}

function makeBlankPage() {
  // return blank page snapshot as dataURL
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = 'transparent';
  tctx.fillRect(0,0,tmp.width,tmp.height);
  return { id: crypto.randomUUID(), snapshot: tmp.toDataURL('image/png') };
}

function getCurrentPage() {
  ensurePages();
  return state.pages[state.pageIndex];
}

function pushSnapshotToUndo() {
  // limit stack size
  const snap = canvas.toDataURL('image/png');
  state.undoStack.push({page: state.pageIndex, img: snap});
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoBtns();
}

function updateUndoRedoBtns(){
  undoBtn.disabled = state.undoStack.length === 0;
  redoBtn.disabled = state.redoStack.length === 0;
}

function redraw() {
  // clear canvas; draw current page snapshot stretched to canvas display size with pan/zoom
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.restore();

  // apply transform
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.scale, state.scale);

  const page = getCurrentPage();
  if (page && page.snapshot) {
    const img = new Image();
    img.onload = () => {
      // draw with center fit
      ctx.drawImage(img, 0, 0, canvas.width / (window.devicePixelRatio||1), canvas.height / (window.devicePixelRatio||1));
      ctx.restore();
    };
    img.src = page.snapshot;
  } else {
    // blank
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.restore();
  }
  updatePageIndicator();
  refreshPagesUI();
  refreshLayersUI();
}

// Drawing helpers (with smoothing using quadratic curve)
function getEventPos(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches) {
    const t = e.touches[0];
    return { x: (t.clientX - rect.left) - state.panX, y: (t.clientY - rect.top) - state.panY };
  } else {
    return { x: (e.clientX - rect.left) - state.panX, y: (e.clientY - rect.top) - state.panY };
  }
}

function screenToCanvas(x, y) {
  // map screen coords to canvas logical coords considering scale and pan
  const rect = canvas.getBoundingClientRect();
  const cx = (x - rect.left - state.panX) / state.scale;
  const cy = (y - rect.top - state.panY) / state.scale;
  return { x: cx, y: cy };
}

function startDraw(screenX, screenY, pointerId=null) {
  if (state.tool === 'select') return;
  state.isDrawing = true;
  state.pointerId = pointerId;
  const p = screenToCanvas(screenX, screenY);
  state.lastPos = p;
  state.shapeStart = p;
  // save snapshot for undo
  pushSnapshotToUndo();
  // if pen/high: begin path on top of snapshot rendering into in-memory layer
}

function drawTo(screenX, screenY) {
  if (!state.isDrawing) return;
  const p = screenToCanvas(screenX, screenY);
  const tool = state.tool;
  const color = state.color;
  const size = Number(state.size);
  const opacity = Number(state.opacity);

  // load current page image, draw on top, then replace page snapshot at every stroke end.
  // For immediate feedback we draw directly on canvas *overlay* (but our design uses snapshot full redraw),
  // So here we will draw onto the visible canvas using transform then commit at end.
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.scale, state.scale);

  if (tool === 'pen' || tool === 'high') {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = (tool === 'high') ? Math.min(opacity, 0.45) : opacity;
    ctx.lineWidth = size;
    ctx.globalCompositeOperation = 'source-over';
    // smoothing: quadratic from lastPos to current via midpoint
    const midX = (state.lastPos.x + p.x) / 2;
    const midY = (state.lastPos.y + p.y) / 2;
    ctx.beginPath();
    ctx.moveTo(state.lastPos.x, state.lastPos.y);
    ctx.quadraticCurveTo(state.lastPos.x, state.lastPos.y, midX, midY);
    ctx.stroke();
  } else if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = size * 2;
    ctx.beginPath();
    ctx.moveTo(state.lastPos.x, state.lastPos.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // shapes preview: we redraw page snapshot then draw preview shape
    // so first restore page snapshot:
    const page = getCurrentPage();
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width / (window.devicePixelRatio||1), canvas.height / (window.devicePixelRatio||1));
      drawPreviewShape(ctx, state.shapeStart, p, tool, color, size, opacity);
    };
    img.src = page.snapshot;
    ctx.restore();
    return;
  }

  ctx.restore();
  state.lastPos = p;
}

function drawPreviewShape(ctxRef, a, b, tool, color, size, opacity) {
  ctxRef.save();
  ctxRef.globalAlpha = opacity;
  ctxRef.strokeStyle = color;
  ctxRef.lineWidth = size;
  ctxRef.fillStyle = color;
  if (tool === 'rect') {
    const w = b.x - a.x, h = b.y - a.y;
    ctxRef.strokeRect(a.x, a.y, w, h);
  } else if (tool === 'circle') {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    ctxRef.beginPath(); ctxRef.arc(a.x, a.y, r, 0, Math.PI*2); ctxRef.stroke();
  } else if (tool === 'line') {
    ctxRef.beginPath(); ctxRef.moveTo(a.x, a.y); ctxRef.lineTo(b.x, b.y); ctxRef.stroke();
  }
  ctxRef.restore();
}

function endDraw(screenX, screenY) {
  if (!state.isDrawing) return;
  const p = screenToCanvas(screenX, screenY);
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.scale, state.scale);

  if (state.tool === 'pen' || state.tool === 'high' || state.tool === 'eraser') {
    // already drawn on canvas: commit by capturing canvas to page snapshot
    commitCanvasToPage();
  } else if (['rect','circle','line'].includes(state.tool)) {
    // draw final shape onto context (over snapshot) then commit
    drawPreviewShape(ctx, state.shapeStart, p, state.tool, state.color, state.size, state.opacity);
    commitCanvasToPage();
  } else if (state.tool === 'text') {
    // create an input overlay for text entry
    createTextInputOverlay(screenX, screenY);
    // we don't commit now, user will confirm
  } else if (state.tool === 'image') {
    // image tool handled on file input change
  }
  ctx.restore();
  state.isDrawing = false;
  state.lastPos = null;
  state.shapeStart = null;
  updateUndoRedoBtns();
}

function commitCanvasToPage() {
  // Save current visible canvas (with transforms applied) into page snapshot
  // To capture what's visible including transforms we draw everything to an offscreen canvas at logical size.
  const DPR = window.devicePixelRatio || 1;
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const octx = off.getContext('2d');
  // draw the current visible canvas content (it is already displayed with device pixel scaling)
  octx.drawImage(canvas, 0, 0);
  // save dataURL
  const data = off.toDataURL('image/png');
  state.pages[state.pageIndex].snapshot = data;
  // also redraw to ensure proper state
  redraw();
  // enable undo/redo toggle updated earlier
}

// Tool switching
tools.forEach(btn => btn.addEventListener('click', () => {
  tools.forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const t = btn.dataset.tool;
  state.tool = t;
  // change cursor
  if (t === 'pan' || t === 'select') {
    canvas.style.cursor = 'default';
  } else if (t === 'text') {
    canvas.style.cursor = 'text';
  } else {
    canvas.style.cursor = 'crosshair';
  }
}));

// color/size/opacity inputs
colorInput.addEventListener('input', (e)=> state.color = e.target.value);
sizeInput.addEventListener('input', (e)=> state.size = e.target.value);
opacityInput.addEventListener('input', (e)=> state.opacity = e.target.value);

// pointer + touch events for drawing and pan
let lastPointer = null;
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  lastPointer = ev;
  if (state.tool === 'select' && ev.button === 1) {
    // middle click pan
    state.isPanning = true;
    state.panLast = {x: ev.clientX, y: ev.clientY};
    return;
  }
  if (state.tool === 'pan' || ev.shiftKey || ev.button === 1 || ev.pointerType === 'touch' && ev.touches && ev.touches.length === 2) {
    state.isPanning = true;
    state.panLast = {x: ev.clientX, y: ev.clientY};
    return;
  }
  // start drawing
  startDraw(ev.clientX, ev.clientY, ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (state.isPanning) {
    const dx = ev.clientX - state.panLast.x;
    const dy = ev.clientY - state.panLast.y;
    state.panLast = {x: ev.clientX, y: ev.clientY};
    state.panX += dx;
    state.panY += dy;
    redraw(); // transform changed
    return;
  }
  if (state.isDrawing) {
    drawTo(ev.clientX, ev.clientY);
  }
});

canvas.addEventListener('pointerup', (ev) => {
  canvas.releasePointerCapture(ev.pointerId);
  if (state.isPanning) {
    state.isPanning = false;
    return;
  }
  endDraw(ev.clientX, ev.clientY);
});

// wheel zoom
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const delta = ev.deltaY > 0 ? 0.9 : 1.1;
  // zoom into cursor point
  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left;
  const cy = ev.clientY - rect.top;
  const worldX = (cx - state.panX) / state.scale;
  const worldY = (cy - state.panY) / state.scale;
  state.scale *= delta;
  // clamp
  state.scale = Math.min(3, Math.max(0.4, state.scale));
  // adjust pan so zoom is centered
  state.panX = cx - worldX * state.scale;
  state.panY = cy - worldY * state.scale;
  redraw();
}, { passive: false });

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') selectTool('pen');
  if (e.key === 'h' || e.key === 'H') selectTool('high');
  if (e.key === 'e' || e.key === 'E') selectTool('eraser');
  if (e.key === 't' || e.key === 'T') selectTool('text');
  if (e.key === 'r' || e.key === 'R') selectTool('rect');
  if (e.key === 'c' || e.key === 'C') selectTool('circle');
  if (e.key === 'l' || e.key === 'L') selectTool('line');
  if (e.key === ' ' ) { // hold space to pan
    state.spaceDown = true;
    selectTool('pan');
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    state.spaceDown = false;
    selectTool('select');
  }
});

function selectTool(name) {
  const btn = Array.from(tools).find(b=>b.dataset.tool===name);
  if (btn) btn.click();
}

// image upload
imgInput.addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    // draw centered and scaled
    pushSnapshotToUndo();
    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.scale, state.scale);
    const maxW = (canvas.width / (window.devicePixelRatio||1)) * 0.6;
    const maxH = (canvas.height / (window.devicePixelRatio||1)) * 0.6;
    let w = img.width, h = img.height;
    const ratio = Math.min(maxW / w, maxH / h, 1);
    w = w * ratio; h = h * ratio;
    ctx.drawImage(img, 50, 50, w, h);
    ctx.restore();
    commitCanvasToPage();
    URL.revokeObjectURL(url);
  };
  img.src = url;
});

// undo/redo using snapshots
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

function undo() {
  if (state.undoStack.length === 0) return;
  const last = state.undoStack.pop();
  state.redoStack.push({page: last.page, img: state.pages[last.page].snapshot});
  state.pages[last.page].snapshot = last.img;
  state.pageIndex = last.page;
  redraw();
  updateUndoRedoBtns();
}

function redo() {
  if (state.redoStack.length === 0) return;
  const r = state.redoStack.pop();
  state.undoStack.push({page: r.page, img: state.pages[r.page].snapshot});
  state.pages[r.page].snapshot = r.img;
  state.pageIndex = r.page;
  redraw();
  updateUndoRedoBtns();
}

// clear page
clearBtn.addEventListener('click', () => {
  if (!confirm('Clear this page?')) return;
  pushSnapshotToUndo();
  state.pages[state.pageIndex].snapshot = makeBlankDataURL();
  redraw();
});

function makeBlankDataURL() {
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  return tmp.toDataURL('image/png');
}

// export PNG
exportBtn.addEventListener('click', () => {
  // draw final scaled snapshot and download
  const link = document.createElement('a');
  link.download = `smartboard_page_${state.pageIndex+1}.png`;
  link.href = getPageDataURL(state.pageIndex);
  link.click();
});

function getPageDataURL(idx) {
  return state.pages[idx].snapshot;
}

// save/load local
saveLocal.addEventListener('click', () => {
  const dump = JSON.stringify({pages: state.pages});
  localStorage.setItem('smartboard_save', dump);
  alert('Saved locally.');
});

loadLocal.addEventListener('click', () => {
  const raw = localStorage.getItem('smartboard_save');
  if (!raw) return alert('Nothing saved locally.');
  const obj = JSON.parse(raw);
  state.pages = obj.pages || [makeBlankPage()];
  state.pageIndex = 0;
  redraw();
  alert('Loaded.');
});

// pages navigation
prevPage.addEventListener('click', () => {
  state.pageIndex = Math.max(0, state.pageIndex - 1);
  redraw();
});
nextPage.addEventListener('click', () => {
  state.pageIndex = Math.min(state.pages.length - 1, state.pageIndex + 1);
  redraw();
});
addPage.addEventListener('click', () => {
  state.pages.push(makeBlankPage());
  state.pageIndex = state.pages.length -1;
  redraw();
});

function updatePageIndicator(){
  pageIndicator.textContent = `${state.pageIndex + 1} / ${state.pages.length}`;
}

function refreshPagesUI(){
  pagesList.innerHTML = '';
  state.pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = `Page ${i+1}`;
    if (i === state.pageIndex) li.classList.add('active');
    li.addEventListener('click', ()=> { state.pageIndex = i; redraw(); });
    pagesList.appendChild(li);
  });
}

// layers simple UI (just shows page snapshot thumbnail)
function refreshLayersUI(){
  layersList.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = `Base Layer (Page ${state.pageIndex+1})`;
  layersList.appendChild(li);
}

// fit to container
fitBtn.addEventListener('click', () => {
  // reset pan/scale
  state.scale = 1;
  state.panX = 0;
  state.panY = 0;
  redraw();
});

// text input overlay
function createTextInputOverlay(screenX, screenY) {
  const inp = document.createElement('textarea');
  inp.className = 'text-overlay';
  inp.style.position = 'absolute';
  inp.style.left = `${screenX - container.getBoundingClientRect().left}px`;
  inp.style.top = `${screenY - container.getBoundingClientRect().top}px`;
  inp.style.background = 'rgba(255,255,255,0.02)';
  inp.style.color = 'var(--text)';
  inp.style.border = '1px dashed rgba(255,255,255,0.06)';
  inp.style.padding = '6px';
  inp.style.minWidth = '120px';
  inp.style.minHeight = '28px';
  container.appendChild(inp);
  inp.focus();
  function commit() {
    const value = inp.value.trim();
    if (value) {
      pushSnapshotToUndo();
      ctx.save();
      ctx.translate(state.panX, state.panY);
      ctx.scale(state.scale, state.scale);
      ctx.fillStyle = state.color;
      ctx.globalAlpha = state.opacity;
      ctx.font = `${18 + Number(state.size)}px Inter, sans-serif`;
      // map overlay pos to canvas coords
      const rect = container.getBoundingClientRect();
      const cx = (parseFloat(inp.style.left) ) / state.scale;
      const cy = (parseFloat(inp.style.top) + 14) / state.scale;
      ctx.fillText(value, cx, cy);
      ctx.restore();
      commitCanvasToPage();
    }
    inp.remove();
  }
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (e)=> {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      commit();
    }
    if (e.key === 'Escape') inp.remove();
  });
}

// recording (simple: capture canvas stream)
recordBtn.addEventListener('click', async () => {
  if (!state.recorder) {
    const stream = canvas.captureStream(25);
    state.recordingChunks = [];
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    mr.ondataavailable = e => { if (e.data && e.data.size) state.recordingChunks.push(e.data); };
    mr.onstop = () => {
      downloadRecording.disabled = false;
    };
    mr.start();
    state.recorder = mr;
    recordBtn.textContent = '⏺ Stop';
    document.getElementById('status').textContent = 'Recording...';
  } else {
    state.recorder.stop();
    state.recorder = null;
    recordBtn.textContent = '● Record';
    document.getElementById('status').textContent = 'Ready';
  }
});

downloadRecording.addEventListener('click', () => {
  if (!state.recordingChunks.length) return;
  const blob = new Blob(state.recordingChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `smartboard_recording_${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
});

// utility: commit initial blank page and setup
function init() {
  // initial page and size
  resizeCanvas();
  state.pages = [makeBlankPage()];
  state.pageIndex = 0;
  // default UI values
  state.color = colorInput.value;
  state.size = sizeInput.value;
  state.opacity = opacityInput.value;
  updateUndoRedoBtns();
  redraw();
  // register service worker optionally
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{/*no-op*/});
  }
}
init();

// helper to set canvas size and redraw when loaded
window.addEventListener('load', () => setTimeout(resizeCanvas, 50));
