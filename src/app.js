/* text-diagram studio UI controller. Depends on src/engine.js (window.DitaaEngine). */
(function () {
  'use strict';
  const { DitaaParser, Grid2DEditor } = window.DitaaEngine;

  /*************************************************************************
   * PRESET DIAGRAMS
   *************************************************************************/
  const PRESETS = {
    arch: `+-------------------+        = = = = = >       /-------------------\\
|    API Gateway    |     dashed/dotted wire   |   Auth Verifier   |
|    cBLU           +------=------------------>|   {mo} cYEL       |
+---------+---^-----+                          \\---------+---------/
          |   |                                          :
          |   | inline '^' on border                     : dashed vertical
          |   | (zero extra line wasted!)                v
          |   +--------------------------------+---------+---------+
          |                                    |   Session Cache   |
          v                                    |   {s} cPNK {*}    |
+---------+---------+                          +-------------------+
|     [D] cGRE      |
+---------+---------+       +-----+       +-----+       /-----+-----\\
          |                 | [A] +------>| [Q] +------>| [S] {d}   |
          +---------------->|cYEL |       |cBLU |       | cGRE      |
                            +-----+       +--+--+       \\-----------/
                                ^            |
                                +-----=------+

# Legend Macros (Automatically expands compact 4x4 boxes above!):
# [D] = Diagram Engine
# [A] = Audit Worker
# [Q] = Queue Broker
# [S] = Cold Archive`,

    showcase: `+--------------------+     solid wire      /--------------------\\
|  Sharp Rectangle   +-------------------->|  Rounded Box       |
|  cBLU              |                     |  cGRE              |
+---------+----------+                     \\---------+----------/
          |                                          :
          |                           dashed wire    :
          v                                          v
+---------+----------+     dashed arrow    +---------+----------+
|  Storage Cylinder  +---------=---------->|  Document Shape    |
|  {s} cYEL          |                     |  {d} cPNK          |
+--------------------+                     +--------------------+

+--------------------+                     +--------------------+
|  I/O Parallelogram |     junction dot    |  Manual Trapezoid  |
|  {io} cRED         +----------*--------->|  {mo} cBLU         |
+--------------------+          |          +---------^----------+
                                |                    |
                                |          /---------+----------\\
                                +--------->|  Pill / Ellipse    |
                                           |  {o} {*} cYEL      |
                                           \\--------------------/`,

    microservices: `      +-----+         +-----+         +-----+         +-----+
      | [G] +-------->| [A] +-------->| [R] +-------->| [W] |
      |cBLU |         |cYEL |         |cGRE |         |cPNK |
      +--+--+         +--+--+         +--+--^         +--+--+
         |               |               |  |            :
         |               v               |  +------------+
         |            +--+--+            v
         +----------->| [L] |         +--+--+
                      | {d} |         | [D] |
                      +-----+         | {s} |
                                      +-----+

# Legend (Toggle '4x4 Legend' mode above to compare inline vs table):
# [G] = Edge Gateway
# [A] = Auth Token Service
# [R] = Rate Limiter
# [W] = Webhook Dispatcher
# [L] = Audit Log Stream
# [D] = Primary Postgres DB`,

    legacy_comparison: `+-------------------------------------------------------+
|  INLINE '^' BORDER ARROWS (NO EXTRA ROW NEEDED!)      |
|  cBLU                                                 |
+------+------------------+------------------+----------+
       |                  |                  |
       v                  v                  v
  +----+----+        +----+----+        +----+----+
  | Node 01 |        | Node 02 |        | Node 03 |
  | cGRE    |        | cYEL    |        | cPNK    |
  +----^----+        +----^----+        +----^----+
       |                  |                  |
       +------------------+------------------+
                          |
                  retry feedback loop`,

    flowchart: `        /-------------\\
        |  Start {o}  |
        \\------+------/
               |
               v
        +------+------+
        | Read input  |
        +------+------+
               |
               v
       +-------+-------+           +-------+-------+
       |               |    no     |  Show error   |
       +  Valid? {c}   +---------->|  cRED         |
       |               |           +-------+-------+
       +-------+-------+                   |
               | yes                       |
               v                           |
       +-------+-------+                   |
       |               |    no             |
       +  Cached? {c}  +------+            |
       |  cYEL         |      |            |
       +-------+-------+      |            |
               | yes          v            |
               |       +------+------+     |
               |       |   Process   |     |
               |       |   cGRE      |     |
               |       +------+------+     |
               |              |            |
               v              v            |
        /------+--------------+-------\\    |
        |          End {o}            |<---+
        \\-----------------------------/`,

    nested: `+-----------------------------------------------+
|  Cluster  c#E0E7FF                            |
|                                               |
|   +-----------+          +---------------+    |
|   |  Ingress  +--------->|  App Service  |    |
|   |  cBLU     |          |  cGRE         |    |
|   +-----------+          +-------+-------+    |
|                                  |            |
|                                  v            |
|                          +-------+-------+    |
|                          |  Database {s} |    |
|                          +---------------+    |
+-----------------------------------------------+`
  };

  /*************************************************************************
   * DOM
   *************************************************************************/
  const $ = (id) => document.getElementById(id);
  const editor = $('ascii-editor');
  const viewport = $('canvas-viewport');
  const svgWrapper = $('svg-wrapper');
  const presetSelect = $('preset-select');
  const cursorPosEl = $('cursor-pos');
  const gridDimsEl = $('grid-dims');
  const detectedStatsEl = $('detected-stats');
  const activeBoxPill = $('active-box-pill');
  const toastEl = $('toast-indicator');
  const zoomLabel = $('zoom-label');

  const toggleInlineArrows = $('toggle-inline-arrows');
  const selectLegendMode = $('select-legend-mode');
  const toggleShadows = $('toggle-shadows');
  const toggleGrid = $('toggle-grid');
  const toggleLightCanvas = $('toggle-light-canvas');
  const toggleAutofit = $('toggle-autofit');

  let currentZoom = 1;
  let lastAst = null;
  let activeBoxIndex = -1;
  // Grid ops may want the caret past the end of a (whitespace-trimmed) line; remember the intended column.
  let virtualCursor = null;

  function makeParser() {
    return new DitaaParser({
      healInlineArrows: toggleInlineArrows.checked,
      legendMode: selectLegendMode.value,
      showShadows: toggleShadows.checked,
      showGrid: toggleGrid.checked,
      lightCanvas: toggleLightCanvas.checked
    });
  }

  function getCursorRC() {
    if (virtualCursor && virtualCursor.text === editor.value && virtualCursor.idx === editor.selectionStart) {
      return { r: virtualCursor.r, c: virtualCursor.c };
    }
    return Grid2DEditor.getRowColFromIndex(editor.value, editor.selectionStart);
  }

  function activeBox() {
    return activeBoxIndex !== -1 && lastAst ? lastAst.boxes[activeBoxIndex] : null;
  }

  /*************************************************************************
   * UNDO / REDO (covers typing too: one snapshot per typing burst)
   *************************************************************************/
  const undoStack = [];
  const redoStack = [];
  let typingBurstTimer = null;

  function pushUndoState() {
    const top = undoStack[undoStack.length - 1];
    if (!top || top.text !== editor.value) {
      undoStack.push({ text: editor.value, selStart: editor.selectionStart });
      if (undoStack.length > 200) undoStack.shift();
    }
    redoStack.length = 0;
  }

  function endTypingBurst() {
    clearTimeout(typingBurstTimer);
    typingBurstTimer = null;
  }

  function restore(snapshot) {
    endTypingBurst();
    editor.value = snapshot.text;
    editor.selectionStart = editor.selectionEnd = snapshot.selStart;
    refresh();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push({ text: editor.value, selStart: editor.selectionStart });
    restore(undoStack.pop());
    showToast('Undo');
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push({ text: editor.value, selStart: editor.selectionStart });
    restore(redoStack.pop());
    showToast('Redo');
  }

  /** Replaces the whole editor text as one undoable step. */
  function setEditorText(text, caretIdx = 0) {
    endTypingBurst();
    pushUndoState();
    editor.value = text;
    editor.selectionStart = editor.selectionEnd = Math.min(caretIdx, text.length);
    refresh();
  }

  function applyGridOperationResult(res, msg) {
    if (!res) {
      showToast('Nothing to do here');
      return;
    }
    if (res.error) {
      showToast(res.error);
      return;
    }
    endTypingBurst();
    pushUndoState();
    editor.value = res.text;
    const newIdx = Grid2DEditor.getIndexFromRowCol(editor.value, res.cursorR, res.cursorC);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = newIdx;
    virtualCursor = { text: editor.value, idx: newIdx, r: res.cursorR, c: res.cursorC };
    if (res.selC1 !== undefined) {
      // Select the new shape's placeholder label so typing replaces it
      editor.selectionStart = Grid2DEditor.getIndexFromRowCol(editor.value, res.cursorR, res.selC1);
      editor.selectionEnd = Grid2DEditor.getIndexFromRowCol(editor.value, res.cursorR, res.selC2);
    }
    refresh();
    showToast(res.msg || msg);
  }

  let toastTimer = null;
  function showToast(msg) {
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('opacity-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('opacity-0'), 2200);
  }

  /*************************************************************************
   * RENDERING
   *************************************************************************/
  function detectActiveBoxAtCursor() {
    if (!lastAst) return -1;
    const { r, c } = getCursorRC();
    // Prefer the innermost (smallest) box under the caret
    let best = -1;
    let bestArea = Infinity;
    lastAst.boxes.forEach((b, i) => {
      if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) {
        const a = (b.r2 - b.r1) * (b.c2 - b.c1);
        if (a < bestArea) { best = i; bestArea = a; }
      }
    });
    return best;
  }

  function updateActiveBoxUI() {
    activeBoxIndex = detectActiveBoxAtCursor();
    const b = activeBox();
    if (b) {
      const title = b.macroKey ? `[${b.macroKey}]` : (b.lines[0] || 'Box');
      activeBoxPill.textContent = `Selected: "${title}" (${b.c2 - b.c1 + 1}×${b.r2 - b.r1 + 1})`;
      activeBoxPill.className = 'text-[11px] font-mono px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 truncate max-w-[230px]';
    } else {
      activeBoxPill.textContent = 'No Box Selected (Click box)';
      activeBoxPill.className = 'text-[11px] font-mono px-2.5 py-1 rounded-md bg-slate-800/90 text-slate-400 border border-slate-700 truncate max-w-[230px]';
    }
  }

  function paintSvg() {
    svgWrapper.innerHTML = makeParser().renderSVG(lastAst, activeBoxIndex);
    applyZoom();
  }

  /** Re-parses the text, refreshes the selection and status bar, and repaints. */
  function refresh() {
    lastAst = makeParser().parse(editor.value);
    updateActiveBoxUI();
    paintSvg();
    updateCursorPos();
    gridDimsEl.textContent = `Grid: ${lastAst.numCols}×${lastAst.numRows}`;
    const legendCount = Object.keys(lastAst.legends).length;
    const inlineCount = lastAst.arrows.filter((a) => a.inline).length;
    detectedStatsEl.textContent = `${lastAst.boxes.length} Boxes • ${inlineCount} Inline '^' • ${legendCount} Legends`;
  }

  function updateCursorPos() {
    const { r, c } = getCursorRC();
    cursorPosEl.textContent = `Row ${r + 1}, Col ${c + 1}`;
  }

  /** Caret moved (no text change): update status, repaint only if the selected box changed. */
  function onCaretMove() {
    const prevIdx = activeBoxIndex;
    updateActiveBoxUI();
    updateCursorPos();
    if (prevIdx !== activeBoxIndex && lastAst) paintSvg();
  }

  /** Clean SVG for export: no selection outline. */
  function exportSvgMarkup() {
    return makeParser().renderSVG(makeParser().parse(editor.value), -1);
  }

  /*************************************************************************
   * EDITOR EVENTS
   *************************************************************************/
  // Typing inside a box: grow the box (and shift the rest of the diagram) instead of
  // pushing its right wall out of line. Returns the engine op for an input event, or null.
  function boxOpFor(e) {
    switch (e.inputType) {
      case 'insertText':
        return e.data ? { type: 'insert', text: e.data } : null;
      case 'insertFromPaste':
      case 'insertFromDrop':
      case 'insertReplacementText': {
        const t = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || e.data;
        return t ? { type: 'insert', text: t } : null;
      }
      case 'insertLineBreak':
      case 'insertParagraph':
        return { type: 'newline' };
      case 'deleteContentBackward':
        return { type: 'backspace' };
      case 'deleteContentForward':
        return { type: 'delete' };
      default:
        return null;
    }
  }

  /** Auto-fit edit at the editor's current selection (keyboard and menu share this). */
  function boxEdit(op) {
    const caret = editor.selectionStart === editor.selectionEnd ? getCursorRC() : null;
    return Grid2DEditor.editAtSelection(editor.value, editor.selectionStart, editor.selectionEnd, op, caret);
  }

  editor.addEventListener('beforeinput', (e) => {
    // Snapshot once at the start of each typing burst
    if (!typingBurstTimer) pushUndoState();
    clearTimeout(typingBurstTimer);
    typingBurstTimer = setTimeout(() => { typingBurstTimer = null; }, 700);

    if (!toggleAutofit.checked || e.isComposing) return;
    const op = boxOpFor(e);
    if (!op) return;
    const res = boxEdit(op);
    if (!res) return; // not inside a box: normal text editing
    e.preventDefault();
    if (res.error) {
      showToast(res.error);
      return;
    }
    if (res.text !== editor.value) editor.value = res.text; // a typed space can leave the text unchanged; the caret still moves
    const idx = Grid2DEditor.getIndexFromRowCol(editor.value, res.cursorR, res.cursorC);
    editor.selectionStart = editor.selectionEnd = idx;
    virtualCursor = { text: editor.value, idx, r: res.cursorR, c: res.cursorC };
    refresh();
  });
  editor.addEventListener('input', refresh);
  editor.addEventListener('click', onCaretMove);
  editor.addEventListener('keyup', onCaretMove);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) onCaretMove();
  });

  editor.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }

    // Alt+Arrows shift the active box, Alt+Shift+Arrows resize it
    if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const box = activeBox();
      if (!box) return;
      e.preventDefault();
      const G = Grid2DEditor;
      const t = editor.value;
      const ops = e.shiftKey
        ? {
            ArrowRight: [() => G.resizeBox(t, box, 2, 0), 'Expanded width +2'],
            ArrowLeft: [() => G.resizeBox(t, box, -2, 0), 'Shrank width -2'],
            ArrowDown: [() => G.resizeBox(t, box, 0, 1), 'Expanded height +1'],
            ArrowUp: [() => G.resizeBox(t, box, 0, -1), 'Shrank height -1']
          }
        : {
            ArrowRight: [() => G.shiftBoxWithElasticWires(t, box, 0, 1), 'Shifted Box →'],
            ArrowLeft: [() => G.shiftBoxWithElasticWires(t, box, 0, -1), 'Shifted Box ←'],
            ArrowDown: [() => G.shiftBoxWithElasticWires(t, box, 1, 0), 'Shifted Box ↓'],
            ArrowUp: [() => G.shiftBoxWithElasticWires(t, box, -1, 0), 'Shifted Box ↑']
          };
      const [fn, label] = ops[e.key];
      applyGridOperationResult(fn(), label);
    }
  });

  presetSelect.addEventListener('change', (e) => {
    const key = e.target.value;
    if (PRESETS[key]) setEditorText(PRESETS[key]);
  });

  [toggleInlineArrows, selectLegendMode, toggleShadows, toggleGrid, toggleLightCanvas].forEach((el) => {
    el.addEventListener('change', refresh);
  });

  // Click a box in the preview to select it (delegated: survives every repaint)
  svgWrapper.addEventListener('click', (ev) => {
    const gEl = ev.target.closest('.ditaa-box');
    if (!gEl || !lastAst) return;
    const idx = parseInt(gEl.getAttribute('data-box-index'), 10);
    const box = lastAst.boxes[idx];
    if (!box) return;
    // Put the caret just inside the box's top-left so the innermost box is selected
    const r = box.r1 + 1;
    const c = box.c1 + 1;
    const charIdx = Grid2DEditor.getIndexFromRowCol(editor.value, r, c);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = charIdx;
    virtualCursor = { text: editor.value, idx: charIdx, r, c };
    onCaretMove();
    showToast(`Selected box #${idx + 1} — use Shift/Size buttons or Alt+Arrows`);
  });

  /*************************************************************************
   * STAMPERS
   *************************************************************************/
  $('stamp-box').addEventListener('click', () => {
    const { r, c } = getCursorRC();
    const tpl = ['+--------------+', '|  Component   |', '|  cBLU        |', '+--------------+'];
    applyGridOperationResult(Grid2DEditor.smartStampBox(editor.value, r, c, tpl), 'Stamped box');
  });

  $('stamp-rbox').addEventListener('click', () => {
    const { r, c } = getCursorRC();
    const tpl = ['/--------------\\', '|  Service     |', '|  cGRE        |', '\\--------------/'];
    applyGridOperationResult(Grid2DEditor.smartStampBox(editor.value, r, c, tpl), 'Stamped rounded box');
  });

  $('stamp-4x4').addEventListener('click', () => {
    const { r, c } = getCursorRC();
    const key = Grid2DEditor.nextMacroKey(editor.value);
    const tpl = Grid2DEditor.macroBoxTemplate(key);
    applyGridOperationResult(
      Grid2DEditor.smartStampBox(editor.value, r, c, tpl, { key, val: `Module ${key}` }),
      `Stamped [${key}] macro box + legend entry`
    );
  });

  const stampArrow = (type, msg) => () => {
    const { r, c } = getCursorRC();
    applyGridOperationResult(Grid2DEditor.smartStampArrow(editor.value, r, c, activeBox(), type), msg);
  };
  $('stamp-diamond').addEventListener('click', () => {
    const { r, c } = getCursorRC();
    applyGridOperationResult(
      Grid2DEditor.smartStampBox(editor.value, r, c, Grid2DEditor.diamondTemplate()),
      'Stamped {c} decision diamond (ports on all 4 vertices)'
    );
  });

  $('stamp-arrow-right').addEventListener('click', stampArrow('solid-right', 'Attached solid arrow (click +Box+ next)'));
  $('stamp-darrow-right').addEventListener('click', stampArrow('dashed-right', 'Attached dashed arrow (click +Box+ next)'));
  $('stamp-arrow-down').addEventListener('click', stampArrow('solid-down', 'Attached down arrow (click +Box+ next)'));

  $('stamp-inline-up').addEventListener('click', () => {
    const box = activeBox();
    if (box) {
      applyGridOperationResult(Grid2DEditor.addInlineUpArrow(editor.value, box), 'Added inline ^ on bottom border');
    } else {
      const { r, c } = getCursorRC();
      applyGridOperationResult(
        Grid2DEditor.smartStampBox(editor.value, r, c, ['+------^-------+']),
        'Stamped inline +---^---+ border'
      );
    }
  });

  document.querySelectorAll('.tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = activeBox();
      if (!box) {
        showToast('Click inside a box first to apply a shape/color tag');
        return;
      }
      applyGridOperationResult(Grid2DEditor.toggleTag(editor.value, box, btn.getAttribute('data-tag')));
    });
  });

  const requireBox = (fn) => () => {
    const box = activeBox();
    if (!box) {
      showToast('Click inside a box (or click a box in the preview) first');
      return;
    }
    fn(box);
  };
  const shift = (dr, dc, label) => requireBox((box) =>
    applyGridOperationResult(Grid2DEditor.shiftBoxWithElasticWires(editor.value, box, dr, dc), label));
  const resize = (dw, dh, label) => requireBox((box) =>
    applyGridOperationResult(Grid2DEditor.resizeBox(editor.value, box, dw, dh), label));

  $('shift-left').addEventListener('click', shift(0, -1, 'Shifted Box Left ←'));
  $('shift-right').addEventListener('click', shift(0, 1, 'Shifted Box Right →'));
  $('shift-up').addEventListener('click', shift(-1, 0, 'Shifted Box Up ↑'));
  $('shift-down').addEventListener('click', shift(1, 0, 'Shifted Box Down ↓'));
  $('resize-wider').addEventListener('click', resize(2, 0, 'Expanded Box Width +2'));
  $('resize-narrower').addEventListener('click', resize(-2, 0, 'Shrank Box Width -2'));
  $('resize-taller').addEventListener('click', resize(0, 1, 'Expanded Box Height +1'));
  $('resize-shorter').addEventListener('click', resize(0, -1, 'Shrank Box Height -1'));

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-clear').addEventListener('click', () => {
    setEditorText('');
    editor.focus();
  });

  /*************************************************************************
   * ZOOM (sizes the SVG itself so the viewport scrolls correctly)
   *************************************************************************/
  function applyZoom() {
    const svgEl = svgWrapper.querySelector('svg');
    if (svgEl) {
      const w = parseFloat(svgEl.getAttribute('width'));
      const h = parseFloat(svgEl.getAttribute('height'));
      svgEl.style.width = `${w * currentZoom}px`;
      svgEl.style.height = `${h * currentZoom}px`;
      svgEl.style.display = 'block';
    }
    zoomLabel.textContent = `${Math.round(currentZoom * 100)}%`;
  }
  $('btn-zoom-in').addEventListener('click', () => {
    currentZoom = Math.min(3, +(currentZoom + 0.15).toFixed(2));
    applyZoom();
  });
  $('btn-zoom-out').addEventListener('click', () => {
    currentZoom = Math.max(0.25, +(currentZoom - 0.15).toFixed(2));
    applyZoom();
  });
  $('btn-zoom-reset').addEventListener('click', () => {
    const svgEl = svgWrapper.querySelector('svg');
    if (!svgEl) return;
    const w = parseFloat(svgEl.getAttribute('width'));
    const h = parseFloat(svgEl.getAttribute('height'));
    const availW = viewport.clientWidth - 48;
    const availH = viewport.clientHeight - 48;
    currentZoom = Math.max(0.25, Math.min(1.5, availW / w, availH / h));
    applyZoom();
  });

  /*************************************************************************
   * EXPORT
   *************************************************************************/
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('btn-download-svg').addEventListener('click', () => {
    download(new Blob([exportSvgMarkup()], { type: 'image/svg+xml;charset=utf-8' }), `diagram-${Date.now()}.svg`);
    showToast('Downloaded SVG');
  });

  $('btn-download-png').addEventListener('click', () => {
    const markup = exportSvgMarkup();
    const m = markup.match(/width="([\d.]+)" height="([\d.]+)"/);
    const w = m ? parseFloat(m[1]) : 800;
    const h = m ? parseFloat(m[2]) : 600;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return showToast('PNG export failed');
        download(pngBlob, `diagram-${Date.now()}.png`);
        showToast('Downloaded 2x PNG');
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('PNG export failed');
    };
    img.src = url;
  });

  /*************************************************************************
   * STRICT LEGACY DITAA MODAL
   *************************************************************************/
  const legacyModal = $('legacy-modal');
  const legacyOutput = $('legacy-ascii-output');
  const legacyDiffSummary = $('legacy-diff-summary');

  function openModal() {
    const res = DitaaParser.exportStrictLegacyDitaa(editor.value);
    legacyOutput.textContent = res.sanitizedText;
    legacyDiffSummary.textContent =
      `Healed ${res.healedArrowsCount} inline arrow(s) • Inserted ${res.insertedRowsCount} spacer row(s)` +
      (res.droppedArrowsCount ? ` • ${res.droppedArrowsCount} arrow(s) could not be kept` : '');
    legacyModal.classList.remove('hidden');
    legacyModal.classList.add('flex');
  }
  function closeModal() {
    legacyModal.classList.add('hidden');
    legacyModal.classList.remove('flex');
  }

  $('btn-legacy-modal').addEventListener('click', openModal);
  $('btn-close-modal').addEventListener('click', closeModal);
  legacyModal.addEventListener('click', (e) => {
    if (e.target === legacyModal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !legacyModal.classList.contains('hidden')) closeModal();
  });

  $('btn-copy-legacy').addEventListener('click', async () => {
    const text = legacyOutput.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
    showToast('Copied sanitized ditaa');
  });

  $('btn-apply-legacy').addEventListener('click', () => {
    setEditorText(legacyOutput.textContent);
    closeModal();
  });


  /*************************************************************************
   * RIGHT-CLICK MENU: connected shapes around a box, shapes in empty space,
   * plus Cut / Copy / Paste. Shift+right-click opens the browser's own menu.
   *************************************************************************/
  const ctxMenu = document.createElement('div');
  ctxMenu.id = 'ctx-menu';
  ctxMenu.className = 'fixed z-50 hidden min-w-[220px] py-1 rounded-lg bg-slate-900 border border-slate-700 shadow-2xl text-xs text-slate-200 select-none';
  ctxMenu.setAttribute('role', 'menu');
  document.body.appendChild(ctxMenu);

  const SIDE_LABEL = { right: 'Right of', below: 'Below', left: 'Left of', above: 'Above' };
  const SIDE_ARROW = { right: '→', below: '↓', left: '←', above: '↑' };
  const KINDS = [
    ['box', 'Box'],
    ['rbox', 'Rounded box'],
    ['diamond', 'Diamond {c}'],
    ['arrow', 'Arrow only']
  ];

  /** Grid cell under a mouse event in the textarea (columns past a line's end included). */
  function cellAt(ev) {
    const cs = getComputedStyle(editor);
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    probe.textContent = 'M'.repeat(100);
    document.body.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
    const rect = editor.getBoundingClientRect();
    const x = ev.clientX - rect.left - editor.clientLeft - parseFloat(cs.paddingLeft) + editor.scrollLeft;
    const y = ev.clientY - rect.top - editor.clientTop - parseFloat(cs.paddingTop) + editor.scrollTop;
    return { r: Math.max(0, Math.floor(y / lh)), c: Math.max(0, Math.floor(x / cw)) };
  }

  function closeMenu() {
    ctxMenu.classList.add('hidden');
    ctxMenu.innerHTML = '';
  }

  function menuItem(label, action, { disabled = false, hint = '' } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.setAttribute('role', 'menuitem');
    el.className = 'w-full flex items-center justify-between gap-4 px-3 py-1.5 text-left ' +
      (disabled ? 'text-slate-500 cursor-default' : 'hover:bg-indigo-600 hover:text-white');
    el.innerHTML = `<span></span><span class="text-slate-500 font-mono text-[10px]"></span>`;
    el.firstChild.textContent = label;
    el.lastChild.textContent = hint;
    el.disabled = disabled;
    if (!disabled) el.addEventListener('click', () => { closeMenu(); action(); });
    return el;
  }

  function menuHeader(text) {
    const el = document.createElement('div');
    el.className = 'px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-indigo-300';
    el.textContent = text;
    return el;
  }

  function menuSeparator() {
    const el = document.createElement('div');
    el.className = 'my-1 border-t border-slate-800';
    return el;
  }

  function openMenu(ev, cell) {
    ctxMenu.innerHTML = '';
    const text = editor.value;
    const hit = Grid2DEditor.hitBoxSides(text, cell.r, cell.c);
    if (hit) {
      const name = hit.box.macroKey ? `[${hit.box.macroKey}]` : hit.box.lines[0] || 'box';
      for (const side of hit.sides) {
        ctxMenu.appendChild(menuHeader(`${SIDE_LABEL[side]} “${name}”`));
        for (const [kind, label] of KINDS) {
          ctxMenu.appendChild(menuItem(`${SIDE_ARROW[side]} ${label}`, () => {
            applyGridOperationResult(Grid2DEditor.insertConnected(editor.value, hit.box, side, kind),
              kind === 'arrow' ? 'Added arrow' : `Added ${label.toLowerCase()} — type its label`);
          }));
        }
      }
    } else {
      ctxMenu.appendChild(menuHeader('Insert here'));
      for (const [kind, label] of KINDS.slice(0, 3)) {
        ctxMenu.appendChild(menuItem(label, () => {
          applyGridOperationResult(Grid2DEditor.insertShapeAt(editor.value, cell.r, cell.c, kind), `Added ${label.toLowerCase()} — type its label`);
        }));
      }
    }
    ctxMenu.appendChild(menuSeparator());
    const hasSel = editor.selectionStart !== editor.selectionEnd;
    ctxMenu.appendChild(menuItem('Cut', () => { editor.focus(); document.execCommand('cut'); }, { disabled: !hasSel, hint: 'Ctrl+X' }));
    ctxMenu.appendChild(menuItem('Copy', () => { editor.focus(); document.execCommand('copy'); }, { disabled: !hasSel, hint: 'Ctrl+C' }));
    ctxMenu.appendChild(menuItem('Paste', async () => {
      editor.focus();
      try {
        const clip = await navigator.clipboard.readText();
        // Same path as typing: pasting into a box grows it and replaces a selection there
        const res = toggleAutofit.checked ? boxEdit({ type: 'insert', text: clip }) : null;
        if (res && !res.error) applyGridOperationResult(res);
        else if (res && res.error) showToast(res.error);
        else {
          pushUndoState();
          editor.setRangeText(clip, editor.selectionStart, editor.selectionEnd, 'end');
          refresh();
        }
      } catch (_) {
        showToast('Press Ctrl+V to paste (the browser blocked clipboard access)');
      }
    }, { hint: 'Ctrl+V' }));
    const tip = document.createElement('div');
    tip.className = 'px-3 pt-1 pb-1 text-[10px] text-slate-500';
    tip.textContent = 'Shift+right-click: browser menu';
    ctxMenu.appendChild(tip);

    ctxMenu.classList.remove('hidden');
    const { innerWidth: W, innerHeight: H } = window;
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = `${Math.min(ev.clientX, W - mw - 8)}px`;
    ctxMenu.style.top = `${Math.max(8, Math.min(ev.clientY, H - mh - 8))}px`;
  }

  // The browser may move the caret on the right-button press; remember the selection first
  let selBeforeRightClick = null;
  editor.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {
      selBeforeRightClick = { s: editor.selectionStart, e: editor.selectionEnd, value: editor.value };
    }
  });

  editor.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey) return; // browser menu
    ev.preventDefault();
    const cell = cellAt(ev);
    // Right-clicking inside a selection keeps it (so Cut/Copy/Paste act on it)
    const saved = selBeforeRightClick;
    selBeforeRightClick = null;
    if (saved && saved.s !== saved.e && saved.value === editor.value) {
      const idx = Grid2DEditor.getIndexFromRowCol(editor.value, cell.r, cell.c);
      if (idx >= saved.s && idx <= saved.e) {
        editor.focus();
        editor.selectionStart = saved.s;
        editor.selectionEnd = saved.e;
      }
    }
    // Without a selection, move the caret to the click (as a left click would)
    if (editor.selectionStart === editor.selectionEnd) {
      const idx = Grid2DEditor.getIndexFromRowCol(editor.value, cell.r, cell.c);
      editor.focus();
      editor.selectionStart = editor.selectionEnd = idx;
      virtualCursor = { text: editor.value, idx, r: cell.r, c: cell.c };
      onCaretMove();
    }
    openMenu(ev, cell);
  });
  document.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  editor.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  /*************************************************************************
   * INIT
   *************************************************************************/
  editor.value = PRESETS.arch;
  refresh();
})();
