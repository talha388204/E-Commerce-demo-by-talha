/* Smart Board — Vanilla JS MVP
   - Stroke layer: HTML5 Canvas (pen/highlighter/eraser with smoothing)
   - Object layer: SVG (rect/ellipse/line/arrow/text/sticky/image)
   - Layers list: shows objects, toggle visibility/lock, z-order
   - Pages: simple state switching
   - Zoom/Pan, Grid, Snap, Undo/Redo, Export PNG/SVG
   - Keyboard: V,P,H,E,T,S,I,N,L, Space(hold), Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S, F
*/

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const state = {
  tool: 'select',
  pen: { color:'#22D3EE', size:4, smoothing:true, pressure:true },
  high: { color:'#FDE047', size:20, alpha:0.35 },
  shape: { kind:'rect', stroke:'#22D3EE', fill:'#00000000', width:2 },
  zoom: 1,
  offset: { x:0, y:0 },
  grid: false,
  snap: false,
  isPanning: false,
  pages: [],
  pageIndex: 0,
  history: { stack:[], ptr:-1 },
  drawing: { active:false, points:[], mode:null }, // mode: pen/highlighter/eraser/shape
  selection: null,
  laser: { active:false },
  objects: [], // per page, we keep in pages[pi].objects
};

const els = {
  stage: $('#canvas-stage'),
  stroke: $('#stroke-canvas'),
  grid: $('#grid-canvas'),
  svg: $('#svg-layer'),
  laser: $('#laser-dot'),
  layerList: $('#layer-list'),
  pagesCarousel: $('#pages-carousel'),
  pageIdx: $('#page-index'),
  pagePrev: $('#page-prev'),
  pageNext: $('#page-next'),
  pageAdd: $('#page-add'),
  penPanel: $('#pen-panel'),
  highPanel: $('#high-panel'),
  shapesPanel: $('#shapes-panel'),
  imageInput: $('#image-input'),
  gridBtn: $('#grid-btn'),
  snapBtn: $('#snap-btn'),
  zoomRange: $('#zoom-range'),
  zoomLabel: $('#zoom-label'),
  fitBtn: $('#fit-btn'),
  quickExport: $('#quick-export'),
  exportMenuBtn: $('#export-menu'),
  exportDropdown: $('#export-dropdown'),
  shareBtn: $('#share-btn'),
  shareModal: $('#share-modal'),
  rail: $('.right-rail'),
  railToggle: $('#rail-toggle'),
  undoTop: document.querySelector('[data-action="undo"]'),
  redoTop: document.querySelector('[data-action="redo"]'),
  undoBottom: $('#undo-bottom'),
  redoBottom: $('#redo-bottom'),
  clearPage: $('#clear-page'),
};
let ctx, gridCtx, dpi = window.devicePixelRatio || 1;

// Init canvases
function resizeCanvases() {
  const r = els.stage.getBoundingClientRect();
  [els.stroke, els.grid].forEach(c => {
    c.width = Math.round(r.width * dpi);
    c.height = Math.round(r.height * dpi);
    c.style.width = r.width+'px';
    c.style.height = r.height+'px';
  });
  ctx = els.stroke.getContext('2d');
  gridCtx = els.grid.getContext('2d');
  drawGrid();
  renderAll();
}

// Grid
function drawGrid() {
  const step = 32;
  gridCtx.clearRect(0,0,els.grid.width, els.grid.height);
  if(!state.grid) return;
  gridCtx.save();
  gridCtx.scale(dpi, dpi);
  gridCtx.globalAlpha = 0.25;
  gridCtx.strokeStyle = '#24404f';
  gridCtx.lineWidth = 1;
  const r = els.stage.getBoundingClientRect();
  for(let x= (state.offset.x % step); x<r.width; x+=step){
    gridCtx.beginPath(); gridCtx.moveTo(x,0); gridCtx.lineTo(x,r.height); gridCtx.stroke();
  }
  for(let y= (state.offset.y % step); y<r.height; y+=step){
    gridCtx.beginPath(); gridCtx.moveTo(0,y); gridCtx.lineTo(r.width,y); gridCtx.stroke();
  }
  gridCtx.restore();
}

// Pages
function makeEmptyPage(){
  return { strokes: [], objects: [], bg: null };
}
function ensureFirstPage(){
  if(state.pages.length===0){
    state.pages.push(makeEmptyPage());
    state.pageIndex=0;
  }
  updatePageUI();
}
function updatePageUI(){
  els.pageIdx.textContent = `${state.pageIndex+1} / ${state.pages.length}`;
  els.pagesCarousel.innerHTML='';
  state.pages.forEach((p,i)=>{
    const d = document.createElement('div');
    d.className = 'page-thumb'+(i===state.pageIndex?' active':'');
    d.title = `Page ${i+1}`;
    d.innerHTML = `<div class="page-num">${i+1}</div>`;
    d.onclick = ()=>switchPage(i);
    els.pagesCarousel.appendChild(d);
  });
}
function switchPage(i){
  saveSnapshot('switch_page');
  state.pageIndex = i;
  renderAll();
  updatePageUI();
}
function addPage(){
  state.pages.splice(state.pageIndex+1, 0, makeEmptyPage());
  switchPage(state.pageIndex+1);
}
function duplicatePage(){
  const cur = currentPage();
  const clone = JSON.parse(JSON.stringify(cur));
  state.pages.splice(state.pageIndex+1, 0, clone);
  switchPage(state.pageIndex+1);
}
function deletePage(){
  if(state.pages.length<=1) return;
  state.pages.splice(state.pageIndex,1);
  state.pageIndex = Math.max(0, state.pageIndex-1);
  renderAll(); updatePageUI();
}
function currentPage(){ return state.pages[state.pageIndex]; }

// History (simplified)
function saveSnapshot(label='op'){
  const snap = {
    pageIndex: state.pageIndex,
    pages: JSON.parse(JSON.stringify(state.pages))
  };
  // truncate redo
  state.history.stack = state.history.stack.slice(0, state.history.ptr+1);
  state.history.stack.push(snap);
  state.history.ptr++;
}
function undo(){
  if(state.history.ptr<=0) return;
  state.history.ptr--;
  const snap = state.history.stack[state.history.ptr];
  state.pages = JSON.parse(JSON.stringify(snap.pages));
  state.pageIndex = snap.pageIndex;
  renderAll(); updatePageUI();
}
function redo(){
  if(state.history.ptr >= state.history.stack.length-1) return;
  state.history.ptr++;
  const snap = state.history.stack[state.history.ptr];
  state.pages = JSON.parse(JSON.stringify(snap.pages));
  state.pageIndex = snap.pageIndex;
  renderAll(); updatePageUI();
}

// Tools activation panels
function setTool(tool){
  state.tool = tool;
  $$('.tool-btn').forEach(b=>b.classList.toggle('active', b.dataset.tool===tool));
  [els.penPanel, els.highPanel, els.shapesPanel].forEach(p=>p.classList.add('hidden'));
  if(tool==='pen') positionPanel(els.penPanel);
  if(tool==='highlighter') positionPanel(els.highPanel);
  if(tool==='shapes') positionPanel(els.shapesPanel);
  // selection behaviors
  if(tool==='select'){
    els.svg.style.pointerEvents = 'auto';
  } else {
    els.svg.style.pointerEvents = 'none';
  }
}
function positionPanel(panel){
  const penBtn = document.querySelector(`.tool-btn[data-tool="${state.tool}"]`);
  if(!penBtn) return;
  const r = penBtn.getBoundingClientRect();
  panel.style.top = (r.top-8)+'px';
  panel.classList.remove('hidden');
}

// Stroke drawing
function stageToLocal(e){
  const rect = els.stage.getBoundingClientRect();
  const x = (e.clientX - rect.left - state.offset.x)/state.zoom;
  const y = (e.clientY - rect.top - state.offset.y)/state.zoom;
  return {x,y};
}
function startDraw(e){
  if(e.button===1) return; // ignore middle
  const isSpacePan = state.isPanning;
  if(isSpacePan || state.tool==='hand') return; // panning handled elsewhere

  if(state.tool==='pen' || state.tool==='highlighter' || state.tool==='eraser'){
    const p = stageToLocal(e);
    state.drawing.active = true;
    state.drawing.mode = state.tool;
    state.drawing.points = [{x:p.x,y:p.y, t: performance.now(), p:e.pressure||0.5}];
  } else if(state.tool==='shapes'){
    const p = stageToLocal(e);
    state.drawing.active = true;
    state.drawing.mode = 'shape';
    state.drawing.shapeStart = p;
    state.drawing.shape = { kind: state.shape.kind, x:p.x, y:p.y, w:0, h:0, stroke:state.shape.stroke, fill:state.shape.fill, width: state.shape.width };
    previewShape(state.drawing.shape);
  } else if(state.tool==='text'){
    const p = stageToLocal(e);
    createText(p.x, p.y);
  } else if(state.tool==='sticky'){
    const p = stageToLocal(e);
    createSticky(p.x, p.y);
  } else if(state.tool==='image'){
    els.imageInput.click();
  }
}
function moveDraw(e){
  if(state.laser.active){
    const rect = els.stage.getBoundingClientRect();
    els.laser.style.left = (e.clientX - rect.left - 9)+'px';
    els.laser.style.top = (e.clientY - rect.top - 9)+'px';
  }

  if(state.isPanning || state.tool==='hand'){
    // CSS translate for stage children
    if(state.panning){
      const dx = e.clientX - state.panning.sx;
      const dy = e.clientY - state.panning.sy;
      state.offset.x = state.panning.ox + dx;
      state.offset.y = state.panning.oy + dy;
      applyTransform();
      drawGrid();
    }
    return;
  }

  if(!state.drawing.active) return;
  if(state.drawing.mode==='shape'){
    const p = stageToLocal(e);
    const s = state.drawing.shapeStart;
    state.drawing.shape.w = p.x - s.x;
    state.drawing.shape.h = p.y - s.y;
    previewShape(state.drawing.shape);
  } else {
    const p = stageToLocal(e);
    state.drawing.points.push({x:p.x, y:p.y, t: performance.now(), p:e.pressure||0.5});
    renderStrokesTemp();
  }
}
function endDraw(){
  if(!state.drawing.active) return;
  if(state.drawing.mode==='shape'){
    commitShape(state.drawing.shape);
    clearShapePreview();
    saveSnapshot('shape');
  } else {
    commitStroke();
    saveSnapshot('stroke');
  }
  state.drawing.active=false; state.drawing.mode=null; state.drawing.points=[];
}

// Smoothing util (quadratic)
function drawSmoothedPath(ctx, pts, color, size, mode){
  if(pts.length<2) return;
  ctx.save();
  ctx.scale(dpi, dpi);
  ctx.lineJoin='round'; ctx.lineCap='round';
  if(mode==='highlighter'){
    ctx.globalAlpha = state.high.alpha;
    ctx.strokeStyle = state.high.color;
  } else if(mode==='eraser'){
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for(let i=1;i<pts.length-1;i++){
    const midX = (pts[i].x + pts[i+1].x)/2;
    const midY = (pts[i].y + pts[i+1].y)/2;
    let w = size;
    if(state.pen.pressure && pts[i].p){ w = Math.max(0.5, size * (0.4 + 0.6*pts[i].p)); }
    ctx.lineWidth = w;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(midX, midY);
  }
  ctx.restore();
}
function renderStrokesTemp(){
  ctx.clearRect(0,0,els.stroke.width, els.stroke.height);
  // draw committed strokes
  const strokes = currentPage().strokes;
  ctx.save(); ctx.scale(dpi, dpi);
  strokes.forEach(s=>{
    drawSmoothedPath(ctx, s.points, s.color, s.size, s.mode);
  });
  ctx.restore();
  // draw active
  if(state.drawing.points.length>1){
    drawSmoothedPath(ctx, state.drawing.points, state.pen.color, state.pen.size, state.drawing.mode==='highlighter'?'highlighter':state.drawing.mode==='eraser'?'eraser':'pen');
  }
}
function commitStroke(){
  const mode = state.drawing.mode;
  if(mode==='eraser'){
    // already erased on temp; commit by redrawing without previous strokes where erased applied
    // Simplified: we render onto a backing bitmap instead of tracking vector erasures.
  }
  const pts = state.pen.smoothing ? state.drawing.points : state.drawing.points.slice(0);
  if(pts.length<2) return;
  const stro = {
    id: 'st_'+Date.now()+Math.random().toString(36).slice(2,6),
    mode: mode==='highlighter'?'highlighter': mode==='eraser'?'eraser':'pen',
    color: mode==='highlighter'? state.high.color : state.pen.color,
    size: mode==='highlighter'? state.high.size : state.pen.size,
    points: pts
  };
  currentPage().strokes.push(stro);
  renderStrokesTemp();
  refreshLayers();
}

// Shapes + Text + Sticky (SVG)
function svgNS(){ return 'http://www.w3.org/2000/svg'; }
function previewShape(s){
  clearShapePreview();
  const g = document.createElementNS(svgNS(),'g');
  g.setAttribute('data-preview','1');
  addShapePath(g, s);
  els.svg.appendChild(g);
}
function clearShapePreview(){
  els.svg.querySelectorAll('[data-preview]').forEach(n=>n.remove());
}
function addShapePath(g, s){
  const stroke = s.stroke; const fill = s.fill; const sw = s.width;
  if(s.kind==='rect'){
    const x = Math.min(s.x, s.x+s.w), y = Math.min(s.y, s.y+s.h);
    const w = Math.abs(s.w), h = Math.abs(s.h);
    const r = document.createElementNS(svgNS(),'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('rx','8'); r.setAttribute('ry','8');
    r.setAttribute('fill', fill); r.setAttribute('stroke', stroke); r.setAttribute('stroke-width', sw);
    g.appendChild(r);
  } else if(s.kind==='ellipse'){
    const cx = s.x + s.w/2, cy = s.y + s.h/2;
    const rx = Math.abs(s.w/2), ry = Math.abs(s.h/2);
    const el = document.createElementNS(svgNS(),'ellipse');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('rx', rx); el.setAttribute('ry', ry);
    el.setAttribute('fill', fill); el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', sw);
    g.appendChild(el);
  } else if(s.kind==='line' || s.kind==='arrow'){
    const x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
    const ln = document.createElementNS(svgNS(),'line');
    ln.setAttribute('x1', x1); ln.setAttribute('y1', y1); ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
    ln.setAttribute('stroke', stroke); ln.setAttribute('stroke-width', sw);
    ln.setAttribute('stroke-linecap','round');
    g.appendChild(ln);
    if(s.kind==='arrow'){
      const marker = ensureArrowMarker();
      ln.setAttribute('marker-end','url(#arrow)');
    }
  }
}
function ensureArrowMarker(){
  let defs = els.svg.querySelector('defs');
  if(!defs){ defs = document.createElementNS(svgNS(),'defs'); els.svg.appendChild(defs); }
  let m = els.svg.querySelector('#arrow');
  if(m) return m;
  m = document.createElementNS(svgNS(),'marker');
  m.setAttribute('id','arrow'); m.setAttribute('viewBox','0 0 10 10'); m.setAttribute('refX','8'); m.setAttribute('refY','5');
  m.setAttribute('markerWidth','6'); m.setAttribute('markerHeight','6'); m.setAttribute('orient','auto-start-reverse');
  const path = document.createElementNS(svgNS(),'path');
  path.setAttribute('d','M 0 0 L 10 5 L 0 10 z'); path.setAttribute('fill', state.shape.stroke);
  m.appendChild(path); els.svg.querySelector('defs').appendChild(m); return m;
}
function commitShape(s){
  const g = document.createElementNS(svgNS(),'g');
  g.setAttribute('data-obj','shape');
  addShapePath(g, s);
  g.dataset.name = `${s.kind}`;
  g.dataset.locked = 'false';
  g.dataset.visible = 'true';
  currentPage().objects.push(serializeSVGGroup(g));
  refreshLayers();
  renderObjects();
}

// Serialize/deserialize SVG objects
function serializeSVGGroup(g){
  return { id:'ob_'+Date.now()+Math.random().toString(36).slice(2,5), svg: g.outerHTML, name: g.dataset.name || 'Object', visible:true, locked:false };
}
function renderObjects(){
  els.svg.innerHTML = ''; // re-render all (simple)
  const objs = currentPage().objects.filter(o=>o.visible);
  objs.forEach(o=>{
    const frag = new DOMParser().parseFromString(o.svg,'image/svg+xml').documentElement;
    els.svg.appendChild(frag);
  });
}
function refreshLayers(){
  const list = els.layerList;
  list.innerHTML='';
  // Strokes layer meta + objects
  currentPage().objects.forEach((o, idx)=>{
    const li = document.createElement('li');
    li.className='layer-item';
    li.innerHTML = `
      <div class="layer-thumb"></div>
      <div class="layer-name">${o.name || 'Object'}</div>
      <button class="ghost small vis">${o.visible?'👁':'🚫'}</button>
      <button class="ghost small lock">${o.locked?'🔒':'🔓'}</button>
      <button class="ghost small del">🗑</button>
    `;
    li.querySelector('.vis').onclick = ()=>{ o.visible=!o.visible; renderObjects(); refreshLayers(); };
    li.querySelector('.lock').onclick = ()=>{ o.locked=!o.locked; refreshLayers(); };
    li.querySelector('.del').onclick = ()=>{ currentPage().objects.splice(idx,1); renderObjects(); refreshLayers(); saveSnapshot('delete_obj'); };
    list.appendChild(li);
  });
}

// Text
function createText(x,y){
  const g = document.createElementNS(svgNS(),'g');
  const rect = document.createElementNS(svgNS(),'rect');
  rect.setAttribute('x',x); rect.setAttribute('y',y-20); rect.setAttribute('rx','6'); rect.setAttribute('ry','6');
  rect.setAttribute('width','200'); rect.setAttribute('height','40');
  rect.setAttribute('fill','rgba(255,255,255,0.02)'); rect.setAttribute('stroke','rgba(255,255,255,0.15)'); rect.setAttribute('stroke-width','1');
  const text = document.createElementNS(svgNS(),'text');
  text.setAttribute('x', x+10); text.setAttribute('y', y+5);
  text.setAttribute('fill', '#e6f3ff'); text.setAttribute('font-size','18'); text.textContent='Edit me';
  g.appendChild(rect); g.appendChild(text);
  g.setAttribute('data-obj','text'); g.dataset.name = 'Text'; g.dataset.locked='false'; g.dataset.visible='true';
  const obj = serializeSVGGroup(g);
  currentPage().objects.push(obj);
  renderObjects(); refreshLayers(); saveSnapshot('text_add');
  // Simple inline edit via prompt
  setTimeout(()=>{
    const newText = prompt('Text:', 'Edit me');
    if(newText!==null){
      const doc = new DOMParser().parseFromString(obj.svg,'image/svg+xml');
      doc.querySelector('text').textContent = newText;
      obj.svg = doc.documentElement.outerHTML;
      renderObjects(); refresh
