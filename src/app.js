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
  // Connection style (toolbar toggles) and a pending start point (see CONNECTIONS below)
  const conn = { dashed: false, arrow: true, pending: null, pendingText: null };

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
      showError('Nothing to do here');
      return;
    }
    if (res.error) {
      showError(res.error);
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
    revealActiveBox();
    showToast(res.msg || msg);
  }

  /** Scrolls the preview so the selected box (e.g. one just inserted) is in view. */
  function revealActiveBox() {
    const g = activeBoxIndex === -1 ? null : svgWrapper.querySelector(`.ditaa-box[data-box-index="${activeBoxIndex}"]`);
    if (!g) return;
    const box = g.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    const pad = 24;
    let dx = 0, dy = 0;
    if (box.right > view.right - pad) dx = box.right - view.right + pad;
    if (box.left - dx < view.left + pad) dx = box.left - view.left - pad;
    if (box.bottom > view.bottom - pad) dy = box.bottom - view.bottom + pad;
    if (box.top - dy < view.top + pad) dy = box.top - view.top - pad;
    if (dx || dy) viewport.scrollBy({ left: dx, top: dy });
  }

  let toastTimer = null;
  function showToast(msg) {
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('opacity-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('opacity-0'), 2200);
  }

  // Refusals must never look like "nothing happened": a red message that stays a while, in
  // the editor's status line (never over the drawing)
  const errorBanner = document.createElement('span');
  errorBanner.id = 'error-banner';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.className = 'text-rose-400 font-sans font-medium truncate hidden';
  const statusLine = cursorPosEl.parentElement;
  statusLine.insertBefore(errorBanner, statusLine.lastElementChild);
  let errorTimer = null;
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.title = msg; // the whole message, if the status line cuts it short
    errorBanner.classList.remove('hidden');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorBanner.classList.add('hidden'), 6000);
  }
  errorBanner.addEventListener('click', () => errorBanner.classList.add('hidden'));

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
    activeBoxPill.textContent = b ? `· ${b.macroKey ? `[${b.macroKey}]` : (b.lines[0] || 'box')} ${b.c2 - b.c1 + 1}×${b.r2 - b.r1 + 1}` : '';
    activeBoxPill.className = b ? 'text-indigo-300 truncate' : 'text-slate-500 truncate';
  }



  /** The boxes to show selected in the preview: all those inside a block selection, else the caret's box. */
  function previewSelection() {
    if (!blockSel || !lastAst) return activeBoxIndex;
    const b = blockSel;
    return lastAst.boxes.map((x, i) => (x.r1 >= b.r1 && x.r2 <= b.r2 && x.c1 >= b.c1 && x.c2 <= b.c2 ? i : -1)).filter((i) => i >= 0);
  }
  let paintedSelection = '';
  function paintSvg() {
    const sel = previewSelection();
    paintedSelection = String(sel);
    svgWrapper.innerHTML = makeParser().renderSVG(lastAst, sel);
    applyZoom();
  }
  /** Repaints the preview only if the boxes shown selected changed (cheap to call while dragging). */
  function repaintSelectionIfChanged() {
    if (lastAst && String(previewSelection()) !== paintedSelection) paintSvg();
  }

  /** Re-parses the text, refreshes the selection and status bar, and repaints. */
  function refresh() {
    if (conn.pending && editor.value !== conn.pendingText) {
      setPending(null);
      showToast('Connection cancelled: the diagram changed');
    }
    if (blockSel && blockSel.text !== editor.value) blockSel = null; // the text changed under it
    lastAst = makeParser().parse(editor.value);
    updateActiveBoxUI();
    paintSvg();
    updateCursorPos();
    paintOverlay();
  }

  function updateCursorPos() {
    const { r, c } = getCursorRC();
    const n = Math.abs(editor.selectionEnd - editor.selectionStart);
    const b = blockSel;
    cursorPosEl.textContent = `Ln ${r + 1}, Col ${c + 1}` +
      (b ? ` · ${blockLabel(b)}` : n ? ` · ${n} selected` : '');
  }

  /** Caret moved (no text change): update status, repaint only if the selected box changed. */
  function onCaretMove() {
    const prevIdx = activeBoxIndex;
    updateActiveBoxUI();
    updateCursorPos();
    paintOverlay();
    if (prevIdx !== activeBoxIndex && lastAst) paintSvg();
    else repaintSelectionIfChanged();
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

    if (overwriteInput(e)) return;
    // Auto-fit is an insert-mode feature: in overwrite mode every edit is literal text editing
    if (!toggleAutofit.checked || modes.overwrite || e.isComposing) return;
    const op = boxOpFor(e);
    if (!op) return;
    const res = boxEdit(op);
    if (!res) return; // not inside a box: normal text editing
    if (res.error) {
      // The user is always right about what they type: auto-fit couldn't help here, so the
      // keystroke goes in as plain text (a quiet note, not an error)
      showToast(`Typed as plain text (${res.error.replace(/^Cannot [^:]*:\s*/, '')})`);
      return;
    }
    e.preventDefault();
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
    if (modeKeydown(e)) return;
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
      const res = fn();
      if (!e.shiftKey) caretMovesWithBox(res, ...({ ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] })[e.key]);
      applyGridOperationResult(res, label);
    }
  });

  /**
   * After a box move the caret moves with the box (it stays where it was inside it), so the
   * same box stays selected: not an inner box that happens to be at the moved box's centre.
   */
  function caretMovesWithBox(res, dr, dc) {
    if (!res || res.error) return;
    const { r, c } = getCursorRC();
    res.cursorR = r + dr;
    res.cursorC = c + dc;
  }

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
    if (blockSel) return drawBoxAroundBlock(false);
    const { r, c } = getCursorRC();
    const tpl = ['+--------------+', '|  Component   |', '|  cBLU        |', '+--------------+'];
    applyGridOperationResult(Grid2DEditor.smartStampBox(editor.value, r, c, tpl), 'Stamped box');
  });

  $('stamp-rbox').addEventListener('click', () => {
    if (blockSel) return drawBoxAroundBlock(true);
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
        showError('Click inside a box first to apply a shape/color tag');
        return;
      }
      applyGridOperationResult(Grid2DEditor.toggleTag(editor.value, box, btn.getAttribute('data-tag')));
    });
  });

  const requireBox = (fn) => () => {
    const box = activeBox();
    if (!box) {
      showError('Click inside a box (or click a box in the preview) first');
      return;
    }
    fn(box);
  };
  // With a block selected, the arrows move the block's characters (see moveSelectedBlock)
  const shift = (dr, dc, label) => () => (blockSel ? moveSelectedBlock(dr, dc) : requireBox((box) => {
    const res = Grid2DEditor.shiftBoxWithElasticWires(editor.value, box, dr, dc);
    caretMovesWithBox(res, dr, dc);
    applyGridOperationResult(res, label);
  })());
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
  /*************************************************************************
   * IMPORT: an SVG, or a picture of boxes and arrows, becomes ditaa text
   *************************************************************************/
  /** The pixels of a picture file (big pictures are scaled down first). */
  async function pixelsOf(file) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; // transparent parts count as background
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
  }
  const looksLikeSvg = (t) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(t);

  /** Imports an SVG text or a picture file, replacing the editor text (Ctrl+Z undoes it). */
  async function importDiagram(source, name = 'the diagram') {
    let res, picture = false;
    try {
      if (typeof source === 'string') res = DiagramImport.importDiagram(source);
      else if (source.type === 'image/svg+xml' || /\.svg$/i.test(source.name || '')) res = DiagramImport.importDiagram(await source.text());
      else if (/^image\//.test(source.type)) { picture = true; res = DiagramImport.importDiagram(await pixelsOf(source)); }
      else return showError('Import an SVG, or a PNG / JPEG picture of a diagram');
    } catch (err) {
      return showError(`Could not read ${name}: ${err.message || err}`);
    }
    if (res.error) return showError(res.error);
    const what = [`${res.boxes} box${res.boxes === 1 ? '' : 'es'}`, `${res.lines} line${res.lines === 1 ? '' : 's'}`, `${res.arrows} arrow${res.arrows === 1 ? '' : 's'}`].join(', ');
    setBlock(null);
    applyGridOperationResult({ text: res.text, cursorR: 0, cursorC: 0 },
      `Imported ${what}${picture ? ' (text in a picture can\'t be read: boxes with writing got placeholder labels)' : ''}. Ctrl+Z undoes it`);
  }
  const importInput = $('import-file');
  $('btn-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const f = importInput.files && importInput.files[0];
    importInput.value = '';
    if (f) importDiagram(f, f.name);
  });
  // Drop a file on the editor or the preview
  for (const el of [editor, $('canvas-viewport')]) {
    el.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer && e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      importDiagram(f, f.name);
    });
  }
  // Paste a picture (a screenshot), or SVG markup
  editor.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const text = dt.getData('text/plain');
    const pic = [...(dt.files || [])].find((f) => /^image\//.test(f.type));
    if (pic && !text) { e.preventDefault(); e.stopImmediatePropagation(); importDiagram(pic, 'the picture'); return; }
    if (text && looksLikeSvg(text)) { e.preventDefault(); e.stopImmediatePropagation(); importDiagram(text, 'the SVG'); }
  }, true);

  /*************************************************************************
   * PANE DIVIDER: drag to share the width between editor and preview
   *************************************************************************/
  const editorPane = $('editor-pane');
  const previewPane = $('preview-pane');
  const divider = $('pane-divider');
  const wide = window.matchMedia('(min-width: 1024px)');
  let editorShare = null; // percent of the width for the editor; null = the default layout
  try { const v = parseFloat(localStorage.getItem('text-diagram.split')); if (v >= 0 && v <= 100) editorShare = v; } catch (_) { /* ignore */ }
  function applySplit() {
    const on = wide.matches && editorShare !== null;
    // (it may shrink: at 100% the divider still needs its few pixels, so it stays on screen)
    editorPane.style.flex = on ? `0 1 ${editorShare}%` : '';
    previewPane.style.flex = on ? '1 1 0' : '';
    editorPane.style.display = on && editorShare === 0 ? 'none' : '';
    previewPane.style.display = on && editorShare === 100 ? 'none' : '';
    metricsCache = null;
    paintOverlay();
  }
  divider.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    divider.setPointerCapture(ev.pointerId);
    const main = divider.parentElement.getBoundingClientRect();
    const move = (e) => {
      let pct = ((e.clientX - main.left) / main.width) * 100;
      if (pct < 4) pct = 0; // all the way: that side gets the whole width
      if (pct > 96) pct = 100;
      editorShare = Math.round(pct * 10) / 10;
      applySplit();
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      try { localStorage.setItem('text-diagram.split', String(editorShare)); } catch (_) { /* ignore */ }
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('dblclick', () => {
    editorShare = null;
    try { localStorage.removeItem('text-diagram.split'); } catch (_) { /* ignore */ }
    applySplit();
  });
  wide.addEventListener('change', applySplit);

  /*************************************************************************
   * DELETE: the block selection, a whole line (traced), or a box
   *************************************************************************/
  const isLineCell = (cell) => !!lastAst && /^wire/.test((lastAst.cellRole[cell.r] || [])[cell.c] || '');
  /** The innermost box the cell is in or on the wall of. */
  function boxContaining(cell) {
    if (!lastAst) return null;
    const area = (b) => (b.r2 - b.r1) * (b.c2 - b.c1);
    return lastAst.boxes.filter((b) => cell.r >= b.r1 && cell.r <= b.r2 && cell.c >= b.c1 && cell.c <= b.c2)
      .sort((p, q) => area(p) - area(q))[0] || null;
  }
  function deleteBlockSel() {
    const b = blockSel;
    const res = Grid2DEditor.clearBlock(editor.value, b);
    setBlock(null);
    applyGridOperationResult(res, `Deleted the ${blockLabel(b)}`);
  }
  /** Deletes the line through `cell`, traced to its ends (ports it used become plain wall). */
  function deleteLineAt(cell) {
    const res = Grid2DEditor.deleteLine(editor.value, cell.r, cell.c);
    applyGridOperationResult(res, `Deleted the line (${res.count} characters)`);
  }
  /** Deletes a box and everything in it (lines attached to it are left as they are). */
  function deleteBox(box) {
    const name = Grid2DEditor.boxName(lastAst, box);
    applyGridOperationResult(Grid2DEditor.clearBlock(editor.value, box), `Deleted box “${name}”`);
  }
  /** The Del button: the block selection, else a text selection, else the line or box at the caret. */
  $('btn-delete').addEventListener('click', () => {
    editor.focus();
    if (blockSel) return deleteBlockSel();
    if (editor.selectionStart !== editor.selectionEnd) {
      endTypingBurst();
      pushUndoState();
      editor.setRangeText('', editor.selectionStart, editor.selectionEnd, 'start');
      refresh();
      return showToast('Deleted the selection');
    }
    const { r, c } = getCursorRC();
    for (const cell of [{ r, c }, { r, c: c - 1 }]) if (isLineCell(cell)) return deleteLineAt(cell);
    const box = boxContaining({ r, c }) || activeBox();
    if (box) return deleteBox(box);
    showError('Nothing to delete here: select a block, or put the caret on a line or in a box');
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

  /**
   * Character width and line height of the editor, measured on a hidden copy of the
   * textarea itself (same class, so the same font, whatever the browser picked). The
   * difference between 100 and 200 characters / lines cancels out padding and borders.
   * (The computed `font` shorthand can't be used: browsers return '' for it when a
   * property such as font-variant-ligatures has no shorthand form.)
   */
  function editorMetrics() {
    const cs = getComputedStyle(editor);
    const probe = editor.cloneNode(false);
    probe.removeAttribute('id'); // so copy what the #ascii-editor rule sets, from the live element
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;width:50px;height:50px;overflow:scroll';
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontVariantLigatures', 'tabSize']) {
      probe.style[prop] = cs[prop];
    }
    document.body.appendChild(probe);
    const measure = (value) => { probe.value = value; return { w: probe.scrollWidth, h: probe.scrollHeight }; };
    const a = measure('M'.repeat(100)), b = measure('M'.repeat(200));
    const c = measure('M\n'.repeat(99) + 'M'), d = measure('M\n'.repeat(199) + 'M');
    probe.remove();
    let cw = (b.w - a.w) / 100, lh = (d.h - c.h) / 100;
    // Fallback for a browser where the probe can't be measured: canvas text metrics with
    // the editor's explicit family/size, and its computed line height
    if (!(cw > 2 && cw < 40)) {
      const g = document.createElement('canvas').getContext('2d');
      g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      cw = g.measureText('M'.repeat(100)).width / 100;
    }
    if (!(lh > 4 && lh < 80)) lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
    return { cw, lh };
  }

  /** Grid cell under a mouse event in the textarea (columns past a line's end included). */
  function cellAt(ev) {
    const cs = getComputedStyle(editor);
    const { cw, lh } = editorMetrics();
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

  /*************************************************************************
   * CONNECTIONS: right-click a wall to start, right-click another to connect.
   * Line style comes from the two toolbar toggles.
   *************************************************************************/
  try {
    const saved = JSON.parse(localStorage.getItem('text-diagram.conn') || '{}');
    if (typeof saved.dashed === 'boolean') conn.dashed = saved.dashed;
    if (typeof saved.arrow === 'boolean') conn.arrow = saved.arrow;
  } catch (_) { /* storage unavailable: defaults */ }
  const dashedBtn = $('toggle-conn-dashed');
  const arrowBtn = $('toggle-conn-arrow');
  const connStatus = $('conn-status');
  function renderConnToggles() {
    dashedBtn.textContent = conn.dashed ? '┄┄' : '──';
    dashedBtn.title = conn.dashed
      ? 'Connections: dashed lines (click for solid)'
      : 'Connections: solid lines (click for dashed)';
    dashedBtn.setAttribute('aria-pressed', String(conn.dashed));
    arrowBtn.textContent = conn.arrow ? '─▸' : '──';
    arrowBtn.title = conn.arrow
      ? 'Connections end in an arrowhead (click for plain lines)'
      : 'Connections are plain lines (click to add an arrowhead)';
    arrowBtn.setAttribute('aria-pressed', String(conn.arrow));
    try { localStorage.setItem('text-diagram.conn', JSON.stringify({ dashed: conn.dashed, arrow: conn.arrow })); } catch (_) { /* ignore */ }
  }
  dashedBtn.addEventListener('click', () => { conn.dashed = !conn.dashed; renderConnToggles(); });
  arrowBtn.addEventListener('click', () => { conn.arrow = !conn.arrow; renderConnToggles(); });
  renderConnToggles();

  // A pending start belongs to the exact diagram it was placed in: any change to the text
  // (an edit, undo/redo, Clear, loading an example) cancels it, so it can never silently
  // start from a different box.
  function setPending(port, text = null) {
    conn.pending = port;
    conn.pendingText = port ? text : null;
    connStatus.textContent = port
      ? `· Connecting from Ln ${port.r + 1}, Col ${port.c + 1}: click a wall, a line or empty space (Esc cancels)`
      : '';
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && conn.pending && ctxMenu.classList.contains('hidden')) {
      setPending(null);
      showToast('Connection cancelled');
    }
  });

  /** Starts a connection at `cell`: a box wall gets a '+'; a line or empty space just marks it. */
  function startConnectionAt(cell) {
    const res = Grid2DEditor.startConnection(editor.value, cell.r, cell.c);
    const where = 'click a box wall, a line or empty space to connect (Esc cancels)';
    if (res.error) return showError(res.error);
    if (res.text === editor.value) showToast(`Start point: ${where}`);
    else applyGridOperationResult(res, `Start point placed: ${where}`);
    setPending(res.port, editor.value);
  }

  function addConnectionItems(cell) {
    ctxMenu.appendChild(menuHeader('Connection'));
    ctxMenu.appendChild(menuItem('● Start connection here', () => startConnectionAt(cell)));
  }

  /**
   * Finishes the pending connection at `cell`: on a box wall (clicked on, next to or inside
   * the box), on a line (joining it) or in empty space. Success or not, the attempt ends
   * the pending connection, so the user is never stuck in it.
   */
  function connectPendingAt(cell) {
    const res = Grid2DEditor.connectTo(editor.value, conn.pending, cell.r, cell.c, { dashed: conn.dashed, arrow: conn.arrow });
    setPending(null);
    if (res.error) res.error += ' (connection cancelled)';
    applyGridOperationResult(res, 'Connected');
  }

  /** While a connection is pending the menu is just: connect here, or cancel. */
  function openPendingMenu(ev, cell) {
    const t = Grid2DEditor.connectionTarget(editor.value, cell.r, cell.c);
    const style = `${conn.dashed ? 'dashed' : 'solid'}${conn.arrow ? ', arrow' : ''}`;
    const to = !t ? '' : t.kind === 'wall' ? ` to “${t.hit.name}”` : t.kind === 'wire' ? ' to this line' : '';
    ctxMenu.appendChild(menuHeader(`Connection${to}`));
    if (t) ctxMenu.appendChild(menuItem(`→ Connect to here (${style})`, () => connectPendingAt(cell)));
    ctxMenu.appendChild(menuItem('✕ Cancel connection', () => { setPending(null); showToast('Connection cancelled'); }, { hint: 'Esc' }));
    showMenu(ev);
  }

  function showMenu(ev) {
    ctxMenu.classList.remove('hidden');
    const { innerWidth: W, innerHeight: H } = window;
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = `${Math.min(ev.clientX, W - mw - 8)}px`;
    ctxMenu.style.top = `${Math.max(8, Math.min(ev.clientY, H - mh - 8))}px`;
  }

  function openMenu(ev, cell) {
    ctxMenu.innerHTML = '';
    if (conn.pending) return openPendingMenu(ev, cell);
    const text = editor.value;
    const hit = Grid2DEditor.hitBoxSides(text, cell.r, cell.c);
    if (hit) {
      const { name } = hit;
      for (const side of hit.sides) {
        ctxMenu.appendChild(menuHeader(`${SIDE_LABEL[side]} “${name}”`));
        for (const [kind, label] of KINDS) {
          ctxMenu.appendChild(menuItem(`${SIDE_ARROW[side]} ${label}`, () => {
            applyGridOperationResult(Grid2DEditor.insertConnected(editor.value, hit.box, side, kind, { overwrite: modes.overwrite }),
              kind === 'arrow' ? 'Added arrow' : `Added ${label.toLowerCase()} — type its label`);
          }));
        }
      }
      addConnectionItems(cell);
    } else {
      ctxMenu.appendChild(menuHeader('Insert here'));
      for (const [kind, label] of KINDS.slice(0, 3)) {
        ctxMenu.appendChild(menuItem(label, () => {
          applyGridOperationResult(Grid2DEditor.insertShapeAt(editor.value, cell.r, cell.c, kind), `Added ${label.toLowerCase()} — type its label`);
        }));
      }
      if (Grid2DEditor.connectionTarget(text, cell.r, cell.c)) addConnectionItems(cell);
    }
    ctxMenu.appendChild(menuSeparator());
    if (hit) {
      ctxMenu.appendChild(menuItem(`▭ Select box “${hit.name}”`, () => {
        const b = hit.box;
        editor.focus();
        setBlock({ r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2, kind: 'rect' });
        showToast('Box selected: Ctrl+C or Ctrl+X, then click and Ctrl+V to paste it');
      }));
    }
    ctxMenu.appendChild(menuItem('▭ Select row', () => {
      editor.focus();
      setBlock({ r1: cell.r, r2: cell.r, c1: 0, c2: diagramWidth() - 1, kind: 'rows' });
      showToast('Row selected: Ctrl+C, then click a line and Ctrl+V to insert it above that line');
    }));
    ctxMenu.appendChild(menuItem('▯ Select column', () => {
      editor.focus();
      setBlock({ r1: 0, r2: Math.max(0, Grid2DEditor.diagramLineCount(editor.value) - 1), c1: cell.c, c2: cell.c, kind: 'cols' });
      showToast('Column selected: Ctrl+C, then click and Ctrl+V to insert it before that column');
    }));
    if (blockSel) {
      ctxMenu.appendChild(menuItem('▭ Draw box around block', () => drawBoxAroundBlock(false), {
        hint: modes.overwrite ? 'on its edge' : 'around it'
      }));
    }
    // Delete: the block selection, or the line / box right-clicked
    if (blockSel) {
      ctxMenu.appendChild(menuItem('✕ Delete block', deleteBlockSel, { hint: 'Del button' }));
    } else {
      if (isLineCell(cell)) ctxMenu.appendChild(menuItem('✕ Delete line', () => deleteLineAt(cell), { hint: 'the whole line' }));
      const box = boxContaining(cell);
      if (box) ctxMenu.appendChild(menuItem(`✕ Delete box “${Grid2DEditor.boxName(lastAst, box)}”`, () => deleteBox(box)));
    }
    const hasSel = editor.selectionStart !== editor.selectionEnd || !!blockSel;
    ctxMenu.appendChild(menuItem('Cut', () => { editor.focus(); if (blockSel) copyBlock(true); else document.execCommand('cut'); }, { disabled: !hasSel, hint: 'Ctrl+X' }));
    ctxMenu.appendChild(menuItem('Copy', () => { editor.focus(); if (blockSel) copyBlock(false); else document.execCommand('copy'); }, { disabled: !hasSel, hint: 'Ctrl+C' }));
    ctxMenu.appendChild(menuItem('Paste', async () => {
      editor.focus();
      try {
        const clip = await navigator.clipboard.readText();
        // "Paste" pastes where you right-clicked, even inside a block selection (Ctrl+V
        // with a block selected replaces it)
        if (blockSel) setBlock(null);
        if (pasteSpecial(clip)) return;
        // Same path as typing: pasting into a box grows it and replaces a selection there
        const res = toggleAutofit.checked && !modes.overwrite ? boxEdit({ type: 'insert', text: clip }) : null;
        if (res && !res.error) applyGridOperationResult(res);
        else {
          if (res && res.error) showToast(`Pasted as plain text (${res.error.replace(/^Cannot [^:]*:\s*/, '')})`);
          pushUndoState();
          editor.setRangeText(clip, editor.selectionStart, editor.selectionEnd, 'end');
          refresh();
        }
      } catch (_) {
        showError('Press Ctrl+V to paste (the browser blocked clipboard access)');
      }
    }, { hint: 'Ctrl+V' }));
    const tip = document.createElement('div');
    tip.className = 'px-3 pt-1 pb-1 text-[10px] text-slate-500';
    tip.textContent = 'Shift+right-click: browser menu';
    ctxMenu.appendChild(tip);
    showMenu(ev);
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
    if (blockSel && !inBlock(cell)) setBlock(null);
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
      // The same caret a left click gives: the nearest gap in insert mode, the cell in overwrite
      const at = caretCellAt(ev);
      const idx = Grid2DEditor.getIndexFromRowCol(editor.value, at.r, at.c);
      editor.focus();
      editor.selectionStart = editor.selectionEnd = idx;
      virtualCursor = { text: editor.value, idx, r: at.r, c: at.c };
      onCaretMove();
    }
    openMenu(ev, cell);
  });
  document.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) closeMenu(); });
  // While a connection is pending, a left click drops the endpoint there (a wall, a line or
  // empty space; on text it just cancels with a message)
  editor.addEventListener('click', (ev) => {
    if (!conn.pending || ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (editor.selectionStart !== editor.selectionEnd) return; // a drag-selection, not a click
    connectPendingAt(cellAt(ev));
  });

  /*************************************************************************
   * INSERT / OVERWRITE AND BLOCK (RECTANGLE) SELECTION
   * Plain text editing: overwrite replaces the characters under the caret; a block is a
   * rectangle of the text for cut / copy / paste in the middle of a diagram.
   *************************************************************************/
  const ovrBtn = $('toggle-overwrite');
  const blockBtn = $('toggle-block');
  const overlay = $('editor-overlay');
  const modes = { overwrite: false, block: true };
  try { Object.assign(modes, JSON.parse(localStorage.getItem('text-diagram.editmodes')) || {}); } catch (_) { /* ignore */ }
  // { r1, c1, r2, c2, anchor, head, text }: the rectangle, the caret points it was made
  // between (for Shift+Arrows) and the text it was made on
  let blockSel = null;
  let blockDrag = null; // the cell a block drag started on
  let blockClip = null; // { text, kind } of the last block copied: pasting it inserts rows / columns / a rectangle

  function renderModeToggles() {
    const pressed = (btn, on) => {
      btn.setAttribute('aria-pressed', String(on));
      btn.style.background = on ? '#b45309' : '';
      btn.style.color = on ? '#fff' : '';
    };
    ovrBtn.textContent = modes.overwrite ? 'OVR' : 'INS';
    ovrBtn.title = modes.overwrite
      ? 'Overwrite: typing and paste replace the characters under the caret; Backspace/Delete blank them (click or press Insert for insert mode)'
      : 'Insert: typing and paste push text along (click or press Insert for overwrite mode)';
    pressed(ovrBtn, modes.overwrite);
    blockBtn.title = modes.block
      ? 'Block selection (on): drag or Shift+Arrows select a rectangle, whole rows or whole columns; Alt+drag selects lines (click to turn off)'
      : 'Block selection (off): drag selects lines; Alt+drag selects a rectangle (click to turn on)';
    pressed(blockBtn, modes.block);
    try { localStorage.setItem('text-diagram.editmodes', JSON.stringify(modes)); } catch (_) { /* ignore */ }
    paintOverlay();
  }
  ovrBtn.addEventListener('click', () => { modes.overwrite = !modes.overwrite; renderModeToggles(); editor.focus(); });
  blockBtn.addEventListener('click', () => { modes.block = !modes.block; renderModeToggles(); editor.focus(); });

  let metricsCache = null;
  const metrics = () => metricsCache || (metricsCache = editorMetrics());
  window.addEventListener('resize', () => { metricsCache = null; paintOverlay(); });
  editor.addEventListener('scroll', () => paintOverlay());
  editor.addEventListener('focus', () => paintOverlay());
  editor.addEventListener('blur', () => paintOverlay());

  /** Draws the block selection, and in overwrite mode a block caret on the cell it replaces. */
  function paintOverlay() {
    if (!overlay) return;
    const showCaret = modes.overwrite && document.activeElement === editor && editor.selectionStart === editor.selectionEnd && !blockSel;
    // Leave the page alone when there's nothing to draw: changing it during a mouse drag
    // would cancel the browser's own text selection
    if (!blockSel && !showCaret && !moveDrag) {
      if (overlay.firstChild) overlay.textContent = '';
      return;
    }
    overlay.textContent = '';
    const { cw, lh } = metrics();
    const cs = getComputedStyle(editor);
    const ox = editor.offsetLeft + editor.clientLeft + parseFloat(cs.paddingLeft) - editor.scrollLeft;
    const oy = editor.offsetTop + editor.clientTop + parseFloat(cs.paddingTop) - editor.scrollTop;
    const rect = (r1, c1, r2, c2, style, cls) => {
      const d = document.createElement('div');
      d.className = cls;
      d.style.cssText = `position:absolute;left:${ox + c1 * cw}px;top:${oy + r1 * lh}px;` +
        `width:${(c2 - c1 + 1) * cw}px;height:${(r2 - r1 + 1) * lh}px;${style}`;
      overlay.appendChild(d);
    };
    if (blockSel) {
      const b = blockSel;
      rect(b.r1, b.c1, b.r2, b.c2, 'background:rgba(99,102,241,.32);outline:1px dashed rgba(165,180,252,.9)', 'block-sel');
    }
    if (moveDrag && (moveDrag.dr || moveDrag.dc)) {
      // Where the dragged block will land, showing its text
      const b = moveDrag.block, { dr, dc } = moveDrag;
      rect(b.r1 + dr, b.c1 + dc, b.r2 + dr, b.c2 + dc,
        `background:rgba(15,23,42,.88);outline:1px solid rgba(165,180,252,.95);color:#e0e7ff;white-space:pre;overflow:hidden;` +
        `font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:${lh}px;letter-spacing:${cs.letterSpacing}`, 'block-ghost');
      overlay.lastChild.textContent = Grid2DEditor.blockText(editor.value, b);
    }
    if (showCaret) {
      const { r, c } = getCursorRC();
      rect(r, c, r, c, 'background:rgba(251,191,36,.45)', 'ovr-caret');
    }
  }

  function setBlock(b) {
    blockSel = b ? {
      anchor: { r: b.r1, c: b.c1 }, head: { r: b.r2, c: b.c2 + 1 }, ...b, text: editor.value
    } : null;
    if (blockSel) blockSel.kind = Grid2DEditor.blockKind(editor.value, blockSel);
    repaintSelectionIfChanged();
    if (b) {
      // The caret sits at the block's top-left, so keys and paste go to the editor. Moving
      // it must not scroll the view (a drag may be scrolling it the other way).
      const { scrollTop, scrollLeft } = editor;
      const idx = Grid2DEditor.getIndexFromRowCol(editor.value, b.r1, b.c1);
      editor.selectionStart = editor.selectionEnd = idx;
      virtualCursor = { text: editor.value, idx, r: b.r1, c: b.c1 };
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;
    }
    updateCursorPos();
    paintOverlay();
  }
  const inBlock = (cell) => blockSel && cell.r >= blockSel.r1 && cell.r <= blockSel.r2 && cell.c >= blockSel.c1 && cell.c <= blockSel.c2;
  const normRect = (a, b) => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });

  /** Puts the caret at a cell, even past the end of its line (overwrite and block modes). */
  function caretToCell(cell) {
    const idx = Grid2DEditor.getIndexFromRowCol(editor.value, cell.r, cell.c);
    editor.selectionStart = editor.selectionEnd = idx;
    virtualCursor = { text: editor.value, idx, r: cell.r, c: cell.c };
    onCaretMove();
  }

  /** The rectangle between two caret points (a zero-width one is the column at that point). */
  function rectFromPoints(a, h) {
    const c1 = Math.min(a.c, h.c), c2 = a.c === h.c ? a.c : Math.max(a.c, h.c) - 1;
    return { r1: Math.min(a.r, h.r), r2: Math.max(a.r, h.r), c1, c2, anchor: a, head: h };
  }
  /** The rectangle of the cells dragged over, from `a` to `b` (both included). */
  const dragRect = (a, b) => rectFromPoints(
    { r: a.r, c: a.c <= b.c ? a.c : a.c + 1 }, { r: b.r, c: b.c >= a.c ? b.c + 1 : b.c });

  /** Where a plain click puts the caret: the nearest gap between characters, on the line. */
  function caretCellAt(ev) {
    const cell = cellAt(ev);
    if (modes.overwrite) return cell; // the cell typing replaces, even past the line's end
    const { cw } = metrics();
    const cs = getComputedStyle(editor);
    const x = ev.clientX - editor.getBoundingClientRect().left - editor.clientLeft - parseFloat(cs.paddingLeft) + editor.scrollLeft;
    const line = editor.value.split('\n')[cell.r];
    return { r: cell.r, c: Math.min(Math.max(0, Math.round(x / cw)), line === undefined ? 0 : line.length) };
  }

  // In block mode a drag selects a rectangle (Alt+drag: lines, as usual); with block mode
  // off it's the other way round. A plain click just places the caret; Shift+click extends.
  editor.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.detail > 1) return; // double-click selects a word as usual
    // Pressing inside the block selection picks it up: drag it where it should go (with
    // Alt or Shift the press starts or extends a selection instead)
    if (blockSel && !ev.shiftKey && !ev.altKey && inBlock(cellAt(ev))) {
      ev.preventDefault();
      editor.focus();
      moveDrag = { start: cellAt(ev), block: { ...blockSel }, dr: 0, dc: 0 };
      return;
    }
    if (modes.block === ev.altKey) {
      if (blockSel) setBlock(null);
      return;
    }
    ev.preventDefault();
    editor.focus();
    if (ev.shiftKey) {
      const from = blockSel ? blockSel.anchor : getCursorRC();
      setBlock({ ...rectFromPoints(from, cellAt(ev)), kind: 'rect' });
      return;
    }
    blockDrag = cellAt(ev);
    setBlock(null);
    caretToCell(caretCellAt(ev));
  });
  let dragPointer = null; // where the mouse is during a block drag (it may be outside the editor)
  let autoScrollFrame = null;
  let moveDrag = null; // { start, block, dr, dc }: a block being dragged to a new place
  function dragTo(pt) {
    const cell = cellAt(pt);
    if (moveDrag) {
      const b = moveDrag.block;
      moveDrag.dr = Math.max(cell.r - moveDrag.start.r, -b.r1);
      moveDrag.dc = Math.max(cell.c - moveDrag.start.c, -b.c1);
      paintOverlay();
      return;
    }
    // A mouse drag is always a rectangle, even if it goes past the text: whole rows /
    // columns come from Select row / column or the keyboard (Shift+End, Shift+Down)
    if (cell.r !== blockDrag.r || cell.c !== blockDrag.c || blockSel) setBlock({ ...dragRect(blockDrag, cell), kind: 'rect' });
  }
  // The move cursor over a block selection says it can be dragged
  editor.addEventListener('mousemove', (ev) => {
    if (blockDrag || moveDrag) return;
    editor.style.cursor = blockSel && inBlock(cellAt(ev)) ? 'move' : '';
  });
  /**
   * While a block drag is near or past an edge of the editor, scroll that way (faster the
   * further out the mouse is) and keep growing the block, so it can reach text that didn't fit.
   */
  function autoScrollStep() {
    autoScrollFrame = null;
    if ((!blockDrag && !moveDrag) || !dragPointer) return;
    const rect = editor.getBoundingClientRect();
    const left = rect.left + editor.clientLeft, top = rect.top + editor.clientTop;
    const right = left + editor.clientWidth, bottom = top + editor.clientHeight;
    const EDGE = 12;
    const speed = (d) => Math.sign(d) * Math.min(48, 4 + Math.ceil(Math.abs(d) / 3));
    const { x, y } = dragPointer;
    const dx = x < left + EDGE ? speed(x - (left + EDGE)) : x > right - EDGE ? speed(x - (right - EDGE)) : 0;
    const dy = y < top + EDGE ? speed(y - (top + EDGE)) : y > bottom - EDGE ? speed(y - (bottom - EDGE)) : 0;
    if (!dx && !dy) return;
    const before = editor.scrollLeft + ',' + editor.scrollTop;
    editor.scrollLeft += dx;
    editor.scrollTop += dy;
    if (editor.scrollLeft + ',' + editor.scrollTop === before) return; // at the end already
    dragTo({ clientX: x, clientY: y });
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  }
  document.addEventListener('mousemove', (ev) => {
    if (!blockDrag && !moveDrag) return;
    dragPointer = { x: ev.clientX, y: ev.clientY };
    dragTo(ev);
    if (!autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScrollStep);
  });
  document.addEventListener('mouseup', (ev) => {
    if (moveDrag) {
      const { block, dr, dc } = moveDrag;
      moveDrag = null;
      if (dr || dc) {
        // Drop it there: on empty space it's just placed; on top of something, OVR writes
        // over it and INS makes room (as pasting a block does)
        const res = Grid2DEditor.dragBlock(editor.value, block, dr, dc, { overwrite: modes.overwrite });
        applyGridOperationResult(res, `Moved the ${blockLabel(blockSel || block)}`);
        setBlock({ ...res.block, kind: 'rect' });
      } else {
        // A click inside the selection (no drag): drop the selection, caret there
        setBlock(null);
        caretToCell(caretCellAt(ev));
      }
      paintOverlay();
    }
    blockDrag = null;
    dragPointer = null;
    if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = null;
  });

  /** Scrolls the editor just enough to show the cell (r, c), e.g. the corner Shift+Arrows move. */
  function revealCell(r, c) {
    const { cw, lh } = metrics();
    const cs = getComputedStyle(editor);
    const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
    const x = padL + c * cw, y = padT + r * lh;
    if (x < editor.scrollLeft + padL) editor.scrollLeft = Math.max(0, x - padL);
    else if (x + cw > editor.scrollLeft + editor.clientWidth - padL) editor.scrollLeft = x + cw - editor.clientWidth + padL;
    if (y < editor.scrollTop + padT) editor.scrollTop = Math.max(0, y - padT);
    else if (y + lh > editor.scrollTop + editor.clientHeight - padT) editor.scrollTop = y + lh - editor.clientHeight + padT;
  }

  /** Block mode: Shift+Arrows grow the rectangle from the caret; Shift+Home / End reach the diagram's edges. */
  function extendBlockByKey(e) {
    if (!modes.block || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    const steps = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (!steps[e.key] && e.key !== 'Home' && e.key !== 'End') return false;
    e.preventDefault();
    const a = blockSel ? blockSel.anchor : getCursorRC();
    const h = blockSel ? { ...blockSel.head } : { ...a };
    if (e.key === 'Home') h.c = 0;
    else if (e.key === 'End') h.c = diagramWidth() + 1; // past the longest line: whole rows
    else { h.r = Math.max(0, h.r + steps[e.key][0]); h.c = Math.max(0, h.c + steps[e.key][1]); }
    setBlock(rectFromPoints(a, h));
    revealCell(h.r, Math.max(0, h.c - (h.c > a.c ? 1 : 0))); // keep the moving corner in view
    return true;
  }
  const diagramWidth = () => {
    const lines = editor.value.split('\n').slice(0, Grid2DEditor.diagramLineCount(editor.value));
    return Math.max(1, ...lines.map((l) => l.length));
  };

  // In overwrite mode a click puts the caret on the cell clicked (the one typing replaces),
  // even past the end of its line
  editor.addEventListener('click', (ev) => {
    if (!modes.overwrite || modes.block !== ev.altKey || ev.button !== 0) return;
    if (editor.selectionStart !== editor.selectionEnd || conn.pending) return;
    const cell = cellAt(ev);
    const cur = getCursorRC();
    if (cur.r !== cell.r || cur.c !== cell.c) caretToCell(cell);
  });

  /** Applies a plain-text result at the caret within the current typing burst (no auto-fit). */
  function applyTyped(res) {
    if (res.text !== editor.value) editor.value = res.text;
    const idx = Grid2DEditor.getIndexFromRowCol(editor.value, res.cursorR, res.cursorC);
    editor.selectionStart = editor.selectionEnd = idx;
    virtualCursor = { text: editor.value, idx, r: res.cursorR, c: res.cursorC };
    refresh();
  }

  /** Overwrite mode: a typed character replaces the one under the caret; Backspace/Delete blank. */
  function overwriteInput(e) {
    if (!modes.overwrite || e.isComposing || editor.selectionStart !== editor.selectionEnd) return false;
    const { r, c } = getCursorRC();
    const G = Grid2DEditor;
    let res;
    if (e.inputType === 'insertText' && e.data) res = G.overwriteBlock(editor.value, r, c, e.data);
    else if (e.inputType === 'deleteContentBackward' && c > 0) res = { ...G.overwriteBlock(editor.value, r, c - 1, ' '), cursorR: r, cursorC: c - 1 };
    else if (e.inputType === 'deleteContentForward') res = { ...G.overwriteBlock(editor.value, r, c, ' '), cursorR: r, cursorC: c };
    else return false; // Enter, paste (see below), and Backspace at the start of a line work as usual
    e.preventDefault();
    applyTyped(res);
    return true;
  }

  const blockLabel = (b) => (b.kind === 'rows' ? `${b.r2 - b.r1 + 1} row${b.r2 > b.r1 ? 's' : ''}`
    : b.kind === 'cols' ? `${b.c2 - b.c1 + 1} column${b.c2 > b.c1 ? 's' : ''}`
      : `${b.r2 - b.r1 + 1}×${b.c2 - b.c1 + 1} block`);

  /**
   * Copies the block (and with `cut`, removes it: in insert mode its rows / columns / room
   * go, in overwrite mode it's blanked).
   */
  function copyBlock(cut) {
    const b = blockSel;
    blockClip = Grid2DEditor.blockCopy(editor.value, b);
    pendingCopy = blockClip.text;
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    pendingCopy = null;
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(blockClip.text).catch(() => {});
    const where = b.kind === 'rows' ? 'click a line and Ctrl+V to insert above it'
      : b.kind === 'cols' ? 'click a column and Ctrl+V to insert before it' : 'click and Ctrl+V to paste';
    if (cut) {
      const res = Grid2DEditor.removeBlock(editor.value, b, modes.overwrite);
      setBlock(null);
      applyGridOperationResult(res, `Cut ${blockLabel(b)}: ${where}`);
    } else {
      showToast(`Copied ${blockLabel(b)}: ${where}`);
    }
  }
  /**
   * Draws a box around the block selection: in insert mode room is made first (a line above
   * and below, a column either side) so nothing is covered; in overwrite mode the border is
   * drawn on the block's edge, over what is there. Lines crossing the border join it with '+'.
   */
  function drawBoxAroundBlock(rounded) {
    const b = blockSel;
    const res = Grid2DEditor.drawBoxAround(editor.value, b, { wrap: !modes.overwrite, rounded });
    if (!res.error) setBlock(null);
    applyGridOperationResult(res, modes.overwrite ? 'Drew a box on the block\'s edge' : 'Drew a box around the block');
  }
  /**
   * Moves the selected block's characters one cell (Alt+Arrows or the ← ↑ ↓ → buttons) and
   * keeps it selected, so pressing again keeps moving it: e.g. select everything and move it
   * right and down to make room for a box around it.
   */
  function moveSelectedBlock(dr, dc) {
    const b = blockSel;
    const res = Grid2DEditor.moveBlock(editor.value, b, dr, dc, { overwrite: modes.overwrite });
    if (res.error) return showError(res.error);
    const keepKind = (b.kind === 'rows' && dc === 0) || (b.kind === 'cols' && dr === 0);
    applyGridOperationResult(res, `Moved the ${blockLabel(b)} ${dr < 0 ? '↑' : dr > 0 ? '↓' : dc < 0 ? '←' : '→'}`);
    setBlock({ ...res.block, kind: keepKind ? b.kind : 'rect' });
    revealCell(dr > 0 ? res.block.r2 : res.block.r1, dc > 0 ? res.block.c2 : res.block.c1);
  }
  let pendingCopy = null;
  editor.addEventListener('copy', (e) => {
    if (pendingCopy === null && blockSel) blockClip = Grid2DEditor.blockCopy(editor.value, blockSel);
    else if (pendingCopy === null) { blockClip = null; return; }
    e.clipboardData.setData('text/plain', blockClip.text);
    e.preventDefault();
  });
  editor.addEventListener('cut', (e) => {
    if (pendingCopy === null && !blockSel) { blockClip = null; return; }
    e.preventDefault();
    if (pendingCopy === null) copyBlock(true);
  });

  /**
   * Paste as a block where that's what's wanted: over a block selection (replacing it), in
   * overwrite mode (writing over the text at the caret), or a copied block in insert mode
   * (inserted as columns on consecutive lines). Returns false for an ordinary paste.
   */
  function pasteSpecial(clip) {
    const G = Grid2DEditor;
    const text = clip.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const kind = blockClip !== null && text === blockClip.text.replace(/\n$/, '') ? blockClip.kind : null;
    const collapsed = editor.selectionStart === editor.selectionEnd;
    const paste = (t, r, c) => (modes.overwrite ? G.pasteBlockOverwrite : G.pasteBlockInsert).call(G, t, r, c, text, kind || 'rect');
    let res, msg;
    if (blockSel) {
      const b = blockSel;
      res = paste(G.removeBlock(editor.value, b, modes.overwrite).text, b.r1, b.c1);
      msg = `Pasted over the ${blockLabel(b)}`;
    } else if ((modes.overwrite || kind) && collapsed) {
      const { r, c } = getCursorRC();
      res = paste(editor.value, r, c);
      msg = modes.overwrite ? 'Pasted over the text (overwrite)'
        : kind === 'rows' ? 'Inserted the rows' : kind === 'cols' ? 'Inserted the columns' : 'Inserted the block';
    } else {
      return false;
    }
    setBlock(null);
    applyGridOperationResult(res, msg);
    return true;
  }
  editor.addEventListener('paste', (e) => {
    const clip = e.clipboardData && e.clipboardData.getData('text/plain');
    if (clip && pasteSpecial(clip)) e.preventDefault();
  });

  /** Insert toggles overwrite; with a block selected, Delete/Backspace remove it and other keys drop it. */
  function modeKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Insert' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      modes.overwrite = !modes.overwrite;
      renderModeToggles();
      showToast(modes.overwrite ? 'Overwrite mode' : 'Insert mode');
      return true;
    }
    if (extendBlockByKey(e)) return true;
    if (!blockSel) return false;
    const MOVES = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (e.altKey && !e.shiftKey && !mod && MOVES[e.key]) {
      e.preventDefault();
      moveSelectedBlock(...MOVES[e.key]);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const b = blockSel;
      const res = Grid2DEditor.removeBlock(editor.value, b, modes.overwrite);
      setBlock(null);
      applyGridOperationResult(res, `Deleted ${blockLabel(b)}`);
      return true;
    }
    if (mod && !e.altKey && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      copyBlock(e.key === 'x' || e.key === 'X');
      return true;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) return false; // the paste event handles it
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return false;
    if (e.key === 'Escape') {
      setBlock(null);
      return true;
    }
    setBlock(null); // any other key: the block is dropped and the key works as usual
    return false;
  }
  renderModeToggles();
  applySplit();

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  editor.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  /*************************************************************************
   * INIT
   *************************************************************************/
  editor.value = PRESETS.arch;
  refresh();
})();
