/*
 * Import: turns a drawing (an SVG file, or a PNG / JPEG picture of boxes and arrows) into
 * ditaa ASCII text, as well as it can.
 *
 *   DiagramImport.fromSVG(svgText)          -> scene
 *   DiagramImport.fromPixels(width, height, rgba) -> scene   (rgba: 4 bytes per pixel)
 *   DiagramImport.toAscii(scene)            -> { text, boxes, lines, arrows, labels, notes }
 *
 * A scene is what was found, in the drawing's own coordinates:
 *   { boxes: [{ x1, y1, x2, y2, rounded, dashed, shape, fill, label: [] }],
 *     texts: [{ x, y, text, size, anchor }],     (x, y: start / middle / end, and middle of the line)
 *     segs:  [{ x1, y1, x2, y2, dashed }],       (horizontal or vertical)
 *     heads: [{ x, y, dir }] }                   (arrowhead tips; dir: up / right / down / left)
 *
 * No DOM is needed (it runs in Node for the tests); the app reads files and pixels.
 */
(function (root) {
  'use strict';

  const ENGINE = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.DitaaEngine;
  const COLOR_MAP = ENGINE.COLOR_MAP || {};

  /* ======================================================================
   * Small helpers
   * ====================================================================== */

  const median = (xs) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  function parseColor(v) {
    if (!v) return null;
    v = String(v).trim().toLowerCase();
    if (v === 'none' || v === 'transparent' || v.startsWith('url(')) return null;
    let m = v.match(/^#([0-9a-f]{3})$/);
    if (m) return '#' + m[1].split('').map((ch) => ch + ch).join('');
    m = v.match(/^#([0-9a-f]{6})/);
    if (m) return '#' + m[1];
    m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
    const named = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080' };
    return named[v] || null;
  }
  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const colorDist = (a, b) => { const p = rgbOf(a), q = rgbOf(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const isPale = (hex) => { const [r, g, b] = rgbOf(hex); return r > 235 && g > 235 && b > 235; };

  /** The ditaa color tag for a fill: a named one when it's close, else c#RRGGBB; none for white. */
  function colorTag(fill) {
    if (!fill || isPale(fill)) return '';
    let best = null;
    for (const [key, hex] of Object.entries(COLOR_MAP)) {
      const h = parseColor(typeof hex === 'string' ? hex : hex && (hex.fill || hex.bg));
      if (!h) continue;
      const d = colorDist(fill, h);
      if (!best || d < best.d) best = { key, d };
    }
    if (best && best.d < 4) return best.key; // (only near-exact: anything else keeps its own color)
    return 'c' + fill.toUpperCase();
  }

  /* ======================================================================
   * SVG: a small XML reader (no DOM), transforms, paths
   * ====================================================================== */

  function parseXml(src) {
    src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => t.replace(/</g, '&lt;'));
    const rootNode = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootNode];
    const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[5] !== undefined) {
        const t = decode(m[5]);
        if (t.trim()) stack[stack.length - 1].children.push({ name: '#text', text: t });
        continue;
      }
      const [, close, name, attrText, selfClose] = m;
      const local = name.replace(/^.*:/, '').toLowerCase();
      if (close) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === local) { stack.length = i; break; }
        }
        continue;
      }
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let a;
      while ((a = ar.exec(attrText))) attrs[a[1].replace(/^.*:/, '').toLowerCase()] = decode(a[3] ?? a[4] ?? a[5] ?? '');
      const node = { name: local, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    return rootNode;
  }
  function decode(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  // Text of a node: inline elements run on, block ones (div, p, li, br) start new lines
  const textOf = (n) => {
    if (n.name === '#text') return n.text;
    if (n.name === 'br') return '\n';
    const inner = (n.children || []).map(textOf).join('');
    return ['div', 'p', 'li', 'tr', 'h1', 'h2', 'h3'].includes(n.name) ? inner + '\n' : inner;
  };

  // 2D affine matrices [a b c d e f]
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  function parseTransform(t) {
    let m = [1, 0, 0, 1, 0, 0];
    if (!t) return m;
    const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
    let x;
    while ((x = re.exec(t))) {
      const v = x[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let n = [1, 0, 0, 1, 0, 0];
      if (x[1] === 'matrix' && v.length === 6) n = v;
      if (x[1] === 'translate') n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      if (x[1] === 'scale') n = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
      if (x[1] === 'rotate') {
        const r = ((v[0] || 0) * Math.PI) / 180, cx = v[1] || 0, cy = v[2] || 0;
        const c = Math.cos(r), s = Math.sin(r);
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
      }
      m = mul(m, n);
    }
    return m;
  }

  /** Subpaths of a path's d: [{ pts: [[x, y]...], closed, curved }] (curves keep their end points). */
  function parsePath(d) {
    const toks = (d || '').match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    const subs = [];
    let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
    const num = () => parseFloat(toks[i++]);
    const start = () => { cur = { pts: [[x, y]], closed: false, curved: false }; subs.push(cur); };
    const to = (nx, ny, curved) => { if (!cur) start(); x = nx; y = ny; cur.pts.push([x, y]); if (curved) cur.curved = true; };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      if (!cmd) break;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; } cur = null; continue; }
      if (i >= toks.length || /[a-zA-Z]/.test(toks[i])) { if (C !== 'Z') continue; }
      if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; start(); cmd = rel ? 'l' : 'L'; continue; }
      if (C === 'L' || C === 'T') { to(ox + num(), oy + num(), C === 'T'); continue; }
      if (C === 'H') { to(ox + num(), y); continue; }
      if (C === 'V') { to(x, oy + num()); continue; }
      if (C === 'C') { num(); num(); num(); num(); to(ox + num(), oy + num(), true); continue; }
      if (C === 'S' || C === 'Q') { num(); num(); to(ox + num(), oy + num(), true); continue; }
      if (C === 'A') { num(); num(); num(); num(); num(); to(ox + num(), oy + num(), true); continue; }
      i++; // unknown
    }
    return subs;
  }

  /**
   * Reads an SVG: boxes (rect, closed rectangular paths / polygons, ellipses, the groups
   * our own export marks as boxes), text (text / tspan / foreignObject), lines (line,
   * polyline, open paths: their horizontal and vertical pieces) and arrowheads (small
   * filled triangles, or markers on a line's ends).
   */
  function fromSVG(src) {
    const doc = parseXml(src);
    const scene = { boxes: [], texts: [], segs: [], heads: [], legends: [] };
    const style = (n, inherited) => {
      const s = { ...inherited };
      for (const k of ['fill', 'stroke', 'stroke-dasharray', 'font-size', 'text-anchor', 'marker-end', 'marker-start', 'display', 'visibility']) {
        if (n.attrs[k] !== undefined) s[k] = n.attrs[k];
      }
      for (const part of (n.attrs.style || '').split(';')) {
        const [k, v] = part.split(':').map((t) => t && t.trim());
        if (k && v !== undefined) s[k.toLowerCase()] = v;
      }
      return s;
    };
    const markers = new Set();
    (function findMarkers(n) { if (n.name === 'marker' && n.attrs.id) markers.add(n.attrs.id); (n.children || []).forEach(findMarkers); })(doc);
    const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

    // Closed outlines and open polylines, in page coordinates
    function addShape(pts, closed, curved, st, m, groupBox) {
      const P = pts.map(([px, py]) => apply(m, px, py));
      const uniq = P.filter((p, k) => k === 0 || Math.hypot(p[0] - P[k - 1][0], p[1] - P[k - 1][1]) > 0.5);
      if (closed && uniq.length > 1 && Math.hypot(uniq[0][0] - uniq[uniq.length - 1][0], uniq[0][1] - uniq[uniq.length - 1][1]) < 0.5) uniq.pop();
      if (uniq.length < 2) return;
      const xs = uniq.map((p) => p[0]), ys = uniq.map((p) => p[1]);
      const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
      const w = x2 - x1, h = y2 - y1;
      const filled = parseColor(st.fill || '#000') !== null;
      const dashed = !!st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none';
      if (closed && filled && w <= 24 && h <= 24 && uniq.length >= 3 && uniq.length <= 5 && !groupBox) {
        // an arrowhead: its tip is the corner farthest from the middle of the rest
        const cx = xs.reduce((s, v) => s + v, 0) / xs.length, cy = ys.reduce((s, v) => s + v, 0) / ys.length;
        let tip = uniq[0], far = -1;
        for (const p of uniq) { const dd = Math.hypot(p[0] - cx, p[1] - cy); if (dd > far) { far = dd; tip = p; } }
        const dx = tip[0] - cx, dy = tip[1] - cy;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        scene.heads.push({ x: tip[0], y: tip[1], dir });
        return;
      }
      if (closed && w > 12 && h > 8) {
        const onEdge = uniq.every(([px, py]) => Math.min(Math.abs(px - x1), Math.abs(px - x2)) < 2 || Math.min(Math.abs(py - y1), Math.abs(py - y2)) < 2);
        const diamond = uniq.length === 4 && uniq.every(([px, py]) =>
          (Math.abs(px - (x1 + x2) / 2) < 2 && (Math.abs(py - y1) < 2 || Math.abs(py - y2) < 2)) ||
          (Math.abs(py - (y1 + y2) / 2) < 2 && (Math.abs(px - x1) < 2 || Math.abs(px - x2) < 2)));
        if (onEdge || diamond || curved || uniq.length >= 4) {
          if (groupBox) return groupBox.parts.push({ x1, y1, x2, y2, shape: diamond ? 'choice' : curved ? 'curved' : 'rect', fill: parseColor(st.fill), dashed });
          scene.boxes.push({ x1, y1, x2, y2, rounded: curved && !diamond, dashed, shape: diamond ? 'choice' : 'rect', fill: parseColor(st.fill), label: [] });
          return;
        }
      }
      // an open line: keep its horizontal and vertical pieces
      for (let k = 0; k + 1 < uniq.length + (closed ? 1 : 0); k++) {
        const [ax, ay] = uniq[k], [bx, by] = uniq[(k + 1) % uniq.length];
        if (Math.abs(ay - by) < 1.5 && Math.abs(ax - bx) >= 2) scene.segs.push({ x1: Math.min(ax, bx), y1: (ay + by) / 2, x2: Math.max(ax, bx), y2: (ay + by) / 2, dashed });
        else if (Math.abs(ax - bx) < 1.5 && Math.abs(ay - by) >= 2) scene.segs.push({ x1: (ax + bx) / 2, y1: Math.min(ay, by), x2: (ax + bx) / 2, y2: Math.max(ay, by), dashed });
      }
      // markers: an arrowhead on the end the marker is on
      const mk = (v) => { const id = (v || '').match(/url\(\s*#([^)]+)\)/); return id && (markers.has(id[1]) || /arrow|head|end|triangle/i.test(id[1])); };
      const end = (a, b) => {
        const dx = a[0] - b[0], dy = a[1] - b[1];
        scene.heads.push({ x: a[0], y: a[1], dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up') });
      };
      if (mk(st['marker-end'])) end(uniq[uniq.length - 1], uniq[uniq.length - 2]);
      if (mk(st['marker-start'])) end(uniq[0], uniq[1]);
    }

    function walk(n, m, st, groupBox) {
      if (n.name === '#text') return;
      if (['defs', 'marker', 'style', 'script', 'title', 'desc', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'symbol'].includes(n.name)) return;
      st = style(n, st);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      m = mul(m, parseTransform(n.attrs.transform));
      const A = (k, dflt = 0) => { const v = parseFloat(n.attrs[k]); return Number.isFinite(v) ? v : dflt; };
      switch (n.name) {
        case 'switch': {
          // only one branch of a switch is shown (e.g. an HTML label, with a plain text fallback)
          const first = n.children.find((c) => c.name !== '#text');
          if (first) walk(first, m, st, groupBox);
          return;
        }
        case 'svg': {
          if (n.attrs.x || n.attrs.y) m = mul(m, [1, 0, 0, 1, A('x'), A('y')]);
          break;
        }
        case 'g': {
          const cls = n.attrs.class || '';
          if (/\bditaa-legend\b/.test(cls)) { // our export's legend card: its definitions, not its shapes
            (function items(k) {
              if (/\bditaa-legend-item\b/.test((k.attrs && k.attrs.class) || '')) scene.legends.push({ key: k.attrs['data-key'], value: k.attrs['data-value'] });
              else (k.children || []).forEach(items);
            })(n);
            return;
          }
          if (/\bditaa-badge\b/.test(cls)) { // a legend macro's key on its box
            if (groupBox) groupBox.macro = textOf(n).trim();
            return;
          }
          // our own export marks each box's shapes as one group
          if (/\bditaa-box\b/.test(cls)) {
            const gb = { parts: [], label: [] };
            n.children.forEach((c) => walk(c, m, st, gb));
            if (gb.parts.length) {
              const x1 = Math.min(...gb.parts.map((p) => p.x1)), y1 = Math.min(...gb.parts.map((p) => p.y1));
              const x2 = Math.max(...gb.parts.map((p) => p.x2)), y2 = Math.max(...gb.parts.map((p) => p.y2));
              const main = gb.parts[0];
              const storage = gb.parts.some((p) => p.shape === 'ellipse') && gb.parts.some((p) => p.shape === 'curved');
              // our export says which shape it drew; else it's worked out from the parts
              const SHAPES = { storage: 'storage', choice: 'choice', document: 'document', io: 'io', manual: 'manual', ellipse: 'pill' };
              const shape = SHAPES[n.attrs['data-shape']] ||
                (storage ? 'storage' : main.shape === 'choice' ? 'choice' : main.shape === 'ellipse' ? 'pill' : 'rect');
              scene.boxes.push({
                x1, y1, x2, y2, rounded: (main.rounded || false) && shape === 'rect', dashed: main.dashed, fill: main.fill, label: [],
                shape, macro: gb.macro || null
              });
            }
            return;
          }
          break;
        }
        case 'rect': {
          const x = A('x'), y = A('y'), w = A('width'), h = A('height');
          if (!(w > 0 && h > 0)) return;
          const [ax, ay] = apply(m, x, y), [bx, by] = apply(m, x + w, y + h);
          const box = { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
          // a background (covers everything, or set to 100%) isn't a box
          if (/%/.test(n.attrs.width || '') || /%/.test(n.attrs.height || '')) return;
          const rx = A('rx', A('ry')) * scaleOf(m);
          const fill = parseColor(st.fill || '#000');
          const stroke = parseColor(st.stroke);
          if (!stroke && (!fill || isPale(fill)) && !groupBox) return; // invisible
          const dashed = !!st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none';
          if (box.x2 - box.x1 < 4 || box.y2 - box.y1 < 4) { // a thin rect is a line
            const xm = (box.x1 + box.x2) / 2, ym = (box.y1 + box.y2) / 2;
            if (box.x2 - box.x1 >= box.y2 - box.y1) scene.segs.push({ x1: box.x1, y1: ym, x2: box.x2, y2: ym, dashed });
            else scene.segs.push({ x1: xm, y1: box.y1, x2: xm, y2: box.y2, dashed });
            return;
          }
          if (groupBox) { groupBox.parts.push({ ...box, shape: 'rect', rounded: rx > 6, fill, dashed }); return; }
          scene.boxes.push({ ...box, rounded: rx > 6, dashed, shape: 'rect', fill, label: [] });
          return;
        }
        case 'circle':
        case 'ellipse': {
          const cx = A('cx'), cy = A('cy');
          const rx = n.name === 'circle' ? A('r') : A('rx'), ry = n.name === 'circle' ? A('r') : A('ry');
          const [ax, ay] = apply(m, cx - rx, cy - ry), [bx, by] = apply(m, cx + rx, cy + ry);
          const b = { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
          if (groupBox) { groupBox.parts.push({ ...b, shape: 'ellipse', fill: parseColor(st.fill) }); return; }
          if (b.x2 - b.x1 < 12 || b.y2 - b.y1 < 8) return; // a dot
          scene.boxes.push({ ...b, rounded: true, dashed: false, shape: 'pill', fill: parseColor(st.fill), label: [] });
          return;
        }
        case 'line': {
          addShape([[A('x1'), A('y1')], [A('x2'), A('y2')]], false, false, st, m, null);
          return;
        }
        case 'polyline':
        case 'polygon': {
          const v = (n.attrs.points || '').split(/[\s,]+/).filter(Boolean).map(Number);
          const pts = [];
          for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
          addShape(pts, n.name === 'polygon', false, st, m, groupBox);
          return;
        }
        case 'path': {
          for (const sp of parsePath(n.attrs.d)) addShape(sp.pts, sp.closed, sp.curved, st, m, groupBox);
          return;
        }
        case 'text': {
          const size = (parseFloat(st['font-size']) || 12) * scaleOf(m);
          const anchor = st['text-anchor'] || 'start';
          // each tspan with its own position is a line of its own
          const lines = [];
          let bx = A('x'), by = A('y');
          const own = n.children.filter((c) => c.name === 'tspan' && (c.attrs.y !== undefined || c.attrs.dy !== undefined));
          if (own.length) {
            let y = by;
            for (const c of own) {
              const dy = parseFloat(c.attrs.dy) || 0;
              y = c.attrs.y !== undefined ? parseFloat(c.attrs.y) : y + (/em$/.test(c.attrs.dy || '') ? dy * size : dy);
              const x = c.attrs.x !== undefined ? parseFloat(c.attrs.x) : bx;
              lines.push([x, y, textOf(c)]);
            }
          } else {
            lines.push([bx, by, textOf(n)]);
          }
          for (const [x, y, t] of lines) {
            const text = t.replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const [px, py] = apply(m, x, y);
            scene.texts.push({ x: px, y: py - size * 0.35, text, size, anchor });
          }
          return;
        }
        case 'foreignobject': {
          const x = A('x'), y = A('y'), w = A('width'), h = A('height');
          const raw = textOf(n).split('\n').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
          const [cx, cy] = apply(m, x + w / 2, y + h / 2);
          const inner = JSON.stringify(n).match(/font-size\s*:\s*([\d.]+)px/);
          const size = (parseFloat(st['font-size']) || (inner ? parseFloat(inner[1]) : 12)) * scaleOf(m);
          raw.forEach((t, k) => scene.texts.push({ x: cx, y: cy + (k - (raw.length - 1) / 2) * size * 1.2, text: t, size, anchor: 'middle' }));
          return;
        }
        default:
          break;
      }
      for (const c of n.children || []) walk(c, m, st, groupBox);
    }
    walk(doc, [1, 0, 0, 1, 0, 0], {}, null);
    return scene;
  }

  /* ======================================================================
   * Pictures: boxes, lines and arrowheads from pixels
   * ====================================================================== */

  /**
   * Reads a picture (RGBA pixels): dark strokes are found as horizontal and vertical runs;
   * four of them closing a rectangle make a box (its fill is sampled inside), the rest are
   * lines, and a line that widens at an end has an arrowhead there. Text can't be read from
   * a picture: boxes with something written in them get placeholder labels (Box 1, Box 2...).
   */
  function fromPixels(width, height, data) {
    const W = width, H = height;
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
    const lum = (p) => (p[3] < 40 ? 255 : 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]);
    // the background: the most common edge color
    const edge = [];
    for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 200))) { edge.push(lum(px(x, 0)), lum(px(x, H - 1))); }
    for (let y = 0; y < H; y += Math.max(1, Math.floor(H / 200))) { edge.push(lum(px(0, y)), lum(px(W - 1, y))); }
    const bg = median(edge);
    const darkOnLight = bg > 128;
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const l = lum(px(x, y));
      ink[y * W + x] = darkOnLight ? (l < Math.min(140, bg - 70) ? 1 : 0) : (l > Math.max(115, bg + 70) ? 1 : 0);
    }
    const MIN = 12;
    // Text: small, compact clusters of ink without a long straight run (letters). They are set
    // aside, so their strokes are never read as lines; they tell that a box has writing in it.
    const textInk = new Uint8Array(W * H);
    const rawInk = ink.slice(); // (for sampling fills: every kind of ink is left out)
    {
      const seen = new Int32Array(W * H).fill(-1);
      const stack = [];
      let id = 0;
      for (let i0 = 0; i0 < W * H; i0++) {
        if (!ink[i0] || seen[i0] !== -1) continue;
        const members = [];
        let x1 = W, y1 = H, x2 = 0, y2 = 0;
        stack.push(i0);
        seen[i0] = id;
        while (stack.length) {
          const i = stack.pop();
          members.push(i);
          const x = i % W, y = (i - x) / W;
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (ink[j] && seen[j] === -1) { seen[j] = id; stack.push(j); }
            }
          }
        }
        const w = x2 - x1 + 1, h = y2 - y1 + 1;
        // (a piece 3 pixels thin or less is a dash or a line, not a letter: a vertical
        // dashed line's dashes would otherwise look like letters such as 'l')
        if (h >= 4 && h <= 22 && w <= 48 && w > 3) {
          let longest = 0;
          for (let y = y1; y <= y2; y++) {
            let run = 0;
            for (let x = x1; x <= x2; x++) { run = seen[y * W + x] === id ? run + 1 : 0; longest = Math.max(longest, run); }
          }
          for (let x = x1; x <= x2; x++) {
            let run = 0;
            for (let y = y1; y <= y2; y++) { run = seen[y * W + x] === id ? run + 1 : 0; longest = Math.max(longest, run); }
          }
          if (longest < MIN) for (const i of members) { textInk[i] = 1; ink[i] = 0; }
        }
        // a small solid blob (a badge, perhaps with light letters in it) is neither a line nor
        // writing; big solid areas are found below (a box filled with a dark color)
        if (w >= 10 && h >= 10 && w <= 60 && h <= 24 && members.length >= 0.5 * w * h) for (const i of members) ink[i] = 0;
        id++;
      }
    }
    // Solid regions: where a whole 7x7 square is ink (thin lines, letters and arrowheads never
    // are). A big one is a box filled with a dark color; a small one (a badge) is dropped.
    // Either way it's taken out of the ink, so only the lines touching it are left.
    const solidBoxes = [];
    {
      const S = new Int32Array((W + 1) * (H + 1));
      for (let y = 0; y < H; y++) {
        let row = 0;
        for (let x = 0; x < W; x++) { row += rawInk[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
      }
      const sum = (x1, y1, x2, y2) => S[(y2 + 1) * (W + 1) + x2 + 1] - S[y1 * (W + 1) + x2 + 1] - S[(y2 + 1) * (W + 1) + x1] + S[y1 * (W + 1) + x1];
      const core = new Uint8Array(W * H);
      for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) if (sum(x - 3, y - 3, x + 3, y + 3) === 49) core[y * W + x] = 1;
      const solid = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!core[y * W + x]) continue;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) solid[(y + dy) * W + x + dx] = 1;
      }
      const seen = new Uint8Array(W * H);
      for (let i0 = 0; i0 < W * H; i0++) {
        if (!solid[i0] || seen[i0]) continue;
        const stack = [i0];
        seen[i0] = 1;
        let x1 = W, y1 = H, x2 = 0, y2 = 0;
        const cols = [];
        while (stack.length) {
          const i = stack.pop();
          const x = i % W, y = (i - x) / W;
          ink[i] = 0;
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
          if (cols.length < 400) cols.push(px(x, y));
          for (const j of [i - 1, i + 1, i - W, i + W]) if (j >= 0 && j < W * H && solid[j] && !seen[j] && Math.abs((j % W) - x) <= 1) { seen[j] = 1; stack.push(j); }
        }
        if (x2 - x1 >= 24 && y2 - y1 >= 16) {
          const fill = '#' + [0, 1, 2].map((k) => Math.round(median(cols.map((p) => p[k]))).toString(16).padStart(2, '0')).join('');
          solidBoxes.push({ x1, y1, x2, y2, fill });
        }
      }
    }
    const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? ink[y * W + x] : 0);
    // horizontal and vertical runs of ink (short ones too: they may be a dashed line's dashes)
    const runsOf = (horiz) => {
      const out = [];
      const [A, B] = horiz ? [H, W] : [W, H];
      for (let i = 0; i < A; i++) {
        let j = 0;
        while (j < B) {
          if (!(horiz ? at(j, i) : at(i, j))) { j++; continue; }
          const s = j;
          while (j < B && (horiz ? at(j, i) : at(i, j))) j++;
          if (j - s >= 3) out.push(horiz ? { y: i, x1: s, x2: j - 1 } : { x: i, y1: s, y2: j - 1 });
        }
      }
      return out;
    };
    // runs on neighbouring rows (columns) with the same extent are one stroke
    const group = (runs, pos, a, b) => {
      const out = [];
      const open = [];
      for (const r of runs.sort((p, q) => p[pos] - q[pos] || p[a] - q[a])) {
        const g = open.find((o) => r[pos] - o.last === 1 && Math.abs(r[a] - o[a]) <= 3 && Math.abs(r[b] - o[b]) <= 3);
        if (g) { g.last = r[pos]; g[a] = Math.min(g[a], r[a]); g[b] = Math.max(g[b], r[b]); } else { const n = { first: r[pos], last: r[pos], [a]: r[a], [b]: r[b] }; out.push(n); open.push(n); }
        while (open.length && r[pos] - open[0].last > 1) open.shift();
      }
      return out.map((g) => ({ ...g, mid: (g.first + g.last) / 2, thick: g.last - g.first + 1 }));
    };
    /**
     * Strokes: long ones as they are, and dashed lines: three or more thin, evenly spaced
     * pieces in a row (pieces of a long dash pattern are long strokes with small gaps).
     */
    const strokes = (horiz) => {
      const [a, b] = horiz ? ['x1', 'x2'] : ['y1', 'y2'];
      const all = group(runsOf(horiz), horiz ? 'y' : 'x', a, b).filter((g) => g.thick <= 6);
      const len = (g) => g[b] - g[a] + 1;
      const out = [];
      const pieces = all.filter((g) => g.thick <= 4).sort((p, q) => p.mid - q.mid || p[a] - q[a]);
      const taken = new Set();
      for (const g of pieces) {
        if (taken.has(g)) continue;
        const chain = [g];
        for (;;) {
          const last = chain[chain.length - 1];
          const next = pieces.find((o) => !taken.has(o) && !chain.includes(o) && Math.abs(o.mid - last.mid) <= 1.5 &&
            o[a] - last[b] >= 2 && o[a] - last[b] <= 9);
          if (!next) break;
          chain.push(next);
        }
        const gaps = chain.slice(1).map((o, k) => o[a] - chain[k][b]);
        const even = gaps.length && Math.max(...gaps) - Math.min(...gaps) <= 3;
        const total = chain[chain.length - 1][b] - chain[0][a] + 1;
        if (chain.length >= 3 && even && total >= 2 * MIN) {
          chain.forEach((o) => taken.add(o));
          out.push({ ...chain[0], [b]: chain[chain.length - 1][b], gaps: gaps.length, thick: Math.max(...chain.map((o) => o.thick)) });
        }
      }
      for (const g of all) if (!taken.has(g) && len(g) >= MIN) out.push(g);
      // strokes on the same line that overlap or touch are one (e.g. an arrowhead's middle
      // row and the end of its dashed line); the longer one says if it is dashed
      const merged = [];
      for (const g of out.sort((p, q) => len(q) - len(p))) {
        const o = merged.find((m) => Math.abs(m.mid - g.mid) <= 2 && g[a] <= m[b] + 1 && g[b] >= m[a] - 1);
        if (o) { o[a] = Math.min(o[a], g[a]); o[b] = Math.max(o[b], g[b]); } else merged.push({ ...g });
      }
      return merged;
    };
    const hs = strokes(true);
    const vs = strokes(false);
    // Border candidates: strokes on one line with small breaks (e.g. an arrowhead drawn on a
    // box's border) joined up
    const joinBreaks = (list, a, b) => {
      const out = [];
      for (const g of list.slice().sort((p, q) => p.mid - q.mid || p[a] - q[a])) {
        const o = out.find((m) => Math.abs(m.mid - g.mid) <= 2 && g[a] - m[b] <= 16 && g[b] >= m[a]);
        if (o) { o[b] = Math.max(o[b], g[b]); o.parts.push(g); o.gaps = (o.gaps || 0) + (g.gaps || 0); } else out.push({ ...g, parts: [g] });
      }
      return out;
    };
    const HB = joinBreaks(hs, 'x1', 'x2'), VB = joinBreaks(vs, 'y1', 'y2');
    // Boxes: a top and a bottom of the same width, and a side at each end joining them (the
    // sides may stop short of the corners when those are rounded)
    const boxes = [];
    const used = new Set();
    const T = 4, RAD = 18;
    for (const top of HB) {
      for (const bot of HB) {
        if (bot === top || bot.mid - top.mid < 10) continue;
        if (Math.abs(top.x1 - bot.x1) > T || Math.abs(top.x2 - bot.x2) > T) continue;
        const ok = (v) => v.y1 <= top.mid + RAD && v.y2 >= bot.mid - RAD && v.y1 >= top.mid - T - 2 && v.y2 <= bot.mid + T + 2;
        const L = VB.find((v) => v.mid <= Math.min(top.x1, bot.x1) + T && v.mid >= Math.min(top.x1, bot.x1) - RAD && ok(v));
        const R = VB.find((v) => v.mid >= Math.max(top.x2, bot.x2) - T && v.mid <= Math.max(top.x2, bot.x2) + RAD && ok(v));
        if (!L || !R) continue;
        const x1 = Math.min(L.mid, top.x1), x2 = Math.max(R.mid, top.x2);
        // the smallest bottom for this top (boxes stacked over each other share columns)
        if (boxes.some((b) => b.top === top && b.y2 < bot.mid)) continue;
        const rounded = top.x1 - L.mid > 5 || L.y1 - top.mid > 5;
        boxes.push({ x1, y1: top.mid, x2, y2: bot.mid, top, bot, L, R, rounded });
      }
    }
    const keep = boxes.filter((b) => !boxes.some((o) => o !== b && o.top === b.top && o.y2 < b.y2));
    for (const b of keep) for (const s of [b.top, b.bot, b.L, b.R]) s.parts.forEach((g) => used.add(g));
    // Cylinders (storage): two matching sides, with curved ink across the top and the bottom
    for (const L of vs) {
      for (const R of vs) {
        if (used.has(L) || used.has(R) || R.mid - L.mid < 24) continue;
        if (Math.abs(L.y1 - R.y1) > 6 || Math.abs(L.y2 - R.y2) > 6 || L.y2 - L.y1 < 12) continue;
        const cx = Math.round((L.mid + R.mid) / 2);
        let topY = null, botY = null;
        for (let y = Math.round(L.y1) - 20; y <= L.y1 + 2; y++) if (at(cx, y)) { topY = y; break; }
        for (let y = Math.round(L.y2) + 20; y >= L.y2 - 2; y--) if (at(cx, y)) { botY = y; break; }
        if (topY === null || botY === null) continue;
        used.add(L); used.add(R);
        keep.push({ x1: L.mid, y1: topY, x2: R.mid, y2: botY, top: { gaps: 0 }, bot: { gaps: 0 }, storage: true });
      }
    }
    for (const b of solidBoxes) keep.push({ ...b, top: { gaps: 0 }, bot: { gaps: 0 }, solid: true });
    const scene = { boxes: [], texts: [], segs: [], heads: [] };
    let n = 0;
    for (const b of keep.sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1)) {
      // fill: the typical color inside, leaving out all ink (lines, writing, badges)
      const samples = [];
      const sx = Math.max(1, Math.floor((b.x2 - b.x1) / 24)), sy = Math.max(1, Math.floor((b.y2 - b.y1) / 12));
      for (let y = Math.round(b.y1) + 4; y < b.y2 - 3; y += sy) {
        for (let x = Math.round(b.x1) + 4; x < b.x2 - 3; x += sx) {
          if (!rawInk[y * W + x]) samples.push(px(x, y));
        }
      }
      const fill = b.fill || (samples.length ? '#' + [0, 1, 2].map((k) => Math.round(median(samples.map((p) => p[k]))).toString(16).padStart(2, '0')).join('') : null);
      const dashed = (b.top.gaps || 0) + (b.bot.gaps || 0) > 1;
      scene.boxes.push({
        x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, rounded: !!b.rounded, dashed,
        shape: b.storage ? 'storage' : 'rect', fill: fill && !isPale(fill) ? fill : null, label: []
      });
    }
    // the rest are lines; an end that widens is an arrowhead
    const onBox = (s, horiz) => scene.boxes.some((b) => (horiz
      ? (b.shape === 'storage'
        ? (s.mid <= b.y1 + RAD || s.mid >= b.y2 - RAD) && s.mid >= b.y1 - T && s.mid <= b.y2 + T && s.x1 >= b.x1 - T && s.x2 <= b.x2 + T
        : (Math.abs(s.mid - b.y1) <= T || Math.abs(s.mid - b.y2) <= T) && s.x1 >= b.x1 - T && s.x2 <= b.x2 + T)
      : (Math.abs(s.mid - b.x1) <= T || Math.abs(s.mid - b.x2) <= T) && s.y1 >= b.y1 - T && s.y2 <= b.y2 + T));
    // the widest the ink gets across the line, 3 to 10 pixels in from an end (an arrowhead
    // is much wider than its line; the end itself may run into a box's wall)
    const widest = (end, step, mid, horiz) => {
      let w = 0;
      for (let d = 3; d <= 10; d++) w = Math.max(w, horiz ? across(end + step * d, mid, true) : across(mid, end + step * d, false));
      return w;
    };
    const across = (x, y, horiz) => { // ink across the line at a point
      let k = 0;
      if (horiz) { for (let d = -8; d <= 8; d++) k += at(x, Math.round(y + d)); } else { for (let d = -8; d <= 8; d++) k += at(Math.round(x + d), y); }
      return k;
    };
    for (const s of hs) {
      if (used.has(s) || onBox(s, true)) continue;
      scene.segs.push({ x1: s.x1, y1: s.mid, x2: s.x2, y2: s.mid, dashed: (s.gaps || 0) > 1 });
      const base = s.thick;
      for (const [x, step, dir] of [[s.x2, -1, 'right'], [s.x1, 1, 'left']]) {
        if (widest(x, step, s.mid, true) >= base + 4) scene.heads.push({ x, y: s.mid, dir });
      }
    }
    for (const s of vs) {
      if (used.has(s) || onBox(s, false)) continue;
      scene.segs.push({ x1: s.mid, y1: s.y1, x2: s.mid, y2: s.y2, dashed: (s.gaps || 0) > 1 });
      const base = s.thick;
      for (const [y, step, dir] of [[s.y2, -1, 'down'], [s.y1, 1, 'up']]) {
        if (widest(y, step, s.mid, false) >= base + 4) scene.heads.push({ x: s.mid, y, dir });
      }
    }
    // Is something written in a box? Letters inside it, not inside one of its child boxes
    for (const b of scene.boxes) {
      const kids = scene.boxes.filter((k) => k !== b && k.x1 >= b.x1 && k.x2 <= b.x2 && k.y1 >= b.y1 && k.y2 <= b.y2);
      let own = 0;
      for (let y = Math.max(0, Math.round(b.y1)); y <= Math.min(H - 1, b.y2); y++) {
        for (let x = Math.max(0, Math.round(b.x1)); x <= Math.min(W - 1, b.x2); x++) {
          if (textInk[y * W + x] && !kids.some((k) => x >= k.x1 && x <= k.x2 && y >= k.y1 && y <= k.y2)) own++;
        }
      }
      if (own > 15) b.label = [`Box ${++n}`];
    }
    return scene;
  }

  /* ======================================================================
   * Scene -> ditaa text
   * ====================================================================== */

  /**
   * Lays the scene out on a character grid: the drawing's x and y positions (box edges,
   * lines, text) are mapped to columns and lines in order, keeping their proportions,
   * but always leaving room for each box's label and tags and for each line.
   */
  function toAscii(scene) {
    const boxes = scene.boxes.map((b) => ({ ...b, label: (b.label || []).slice() }));
    const texts = scene.texts.slice();
    const segs = scene.segs.filter((s) => Math.max(s.x2 - s.x1, s.y2 - s.y1) >= 2).map((s) => ({ ...s }));
    const heads = scene.heads.slice();
    // drop boxes that are the same as another (a shape drawn twice), and background-sized ones
    const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
    const uniq = [];
    for (const b of boxes.sort((p, q) => area(p) - area(q))) {
      if (uniq.some((u) => Math.abs(u.x1 - b.x1) < 3 && Math.abs(u.y1 - b.y1) < 3 && Math.abs(u.x2 - b.x2) < 3 && Math.abs(u.y2 - b.y2) < 3)) continue;
      uniq.push(b);
    }
    // text goes into the innermost box it is in
    const free = [];
    for (const t of texts) {
      const len = t.text.length * t.size * 0.6;
      const cx = t.anchor === 'middle' ? t.x : t.anchor === 'end' ? t.x - len / 2 : t.x + len / 2;
      const inside = uniq.filter((b) => cx > b.x1 && cx < b.x2 && t.y > b.y1 && t.y < b.y2).sort((p, q) => area(p) - area(q))[0];
      if (inside) (inside.texts = inside.texts || []).push(t);
      else free.push(t);
    }
    const legends = [];
    const legendKeys = new Set();
    for (const l of scene.legends || []) {
      if (!l.key || legendKeys.has(l.key)) continue;
      legendKeys.add(l.key);
      legends.push(`# [${l.key}] = ${l.value}`);
    }
    for (const b of uniq) {
      const ts = (b.texts || []).sort((p, q) => p.y - q.y || p.x - q.x);
      // texts on the same line join up
      const lines = [];
      for (const t of ts) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - t.y) < t.size * 0.5) last.text += ' ' + t.text;
        else lines.push({ y: t.y, text: t.text, x: t.x, size: t.size });
      }
      // a container's own title sits at its top; children's text was taken by them
      if (lines.length) b.label = lines.map((l) => l.text);
      // a legend macro: the box shows its key, and a legend line says what it stands for
      if (b.macro) {
        if (!legendKeys.has(b.macro)) { legendKeys.add(b.macro); legends.push(`# [${b.macro}] = ${b.label.join(' ')}`.trim()); }
        b.label = [`[${b.macro}]`];
      }
      b.titleTop = lines.length && uniq.some((k) => k !== b && k.x1 >= b.x1 && k.x2 <= b.x2 && k.y1 >= b.y1 && k.y2 <= b.y2);
      const tags = [];
      if (b.shape === 'storage') tags.push('{s}');
      if (b.shape === 'choice') tags.push('{c}');
      if (b.shape === 'pill') tags.push('{o}');
      if (b.shape === 'document') tags.push('{d}');
      if (b.shape === 'io') tags.push('{io}');
      if (b.shape === 'manual') tags.push('{mo}');
      const ct = colorTag(b.fill);
      if (ct) tags.push(ct);
      b.tags = tags.join(' ');
    }
    // scale: from text sizes, else from the boxes
    const sizes = texts.map((t) => t.size).filter((v) => v > 4);
    let cw, ch;
    if (sizes.length) { cw = median(sizes) * 0.72; ch = median(sizes) * 1.4; } else if (uniq.length) {
      ch = Math.max(8, median(uniq.map((b) => b.y2 - b.y1)) / 3);
      cw = ch / 1.8;
    } else { cw = 8; ch = 16; }

    // ---- snapping: line ends that reach a box edge end on it
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const tolX = cw * 0.8, tolY = ch * 0.6;
    for (const s of segs) {
      const horiz = s.y1 === s.y2;
      for (const b of uniq) {
        if (horiz && s.y1 > b.y1 && s.y1 < b.y2) {
          if (near(s.x1, b.x2, tolX)) s.x1 = b.x2;
          if (near(s.x2, b.x1, tolX)) s.x2 = b.x1;
          if (near(s.x1, b.x1, tolX) && s.x2 < b.x1 + tolX) s.x1 = b.x1; // (inside-to-out lines are rare)
          if (near(s.x2, b.x2, tolX) && s.x1 > b.x2 - tolX) s.x2 = b.x2;
        }
        if (!horiz && s.x1 > b.x1 && s.x1 < b.x2) {
          if (near(s.y1, b.y2, tolY)) s.y1 = b.y2;
          if (near(s.y2, b.y1, tolY)) s.y2 = b.y1;
        }
      }
    }
    // join line ends that meet (corners), so they map to the same cell
    for (const s of segs) for (const o of segs) {
      if (s === o) continue;
      const sh = s.y1 === s.y2, oh = o.y1 === o.y2;
      if (sh === oh) continue;
      const [h, v] = sh ? [s, o] : [o, s];
      for (const k of ['x1', 'x2']) if (near(h[k], v.x1, tolX) && h.y1 >= v.y1 - tolY && h.y1 <= v.y2 + tolY) h[k] = v.x1;
      for (const k of ['y1', 'y2']) if (near(v[k], h.y1, tolY) && v.x1 >= h.x1 - tolX && v.x1 <= h.x2 + tolX) v[k] = h.y1;
    }

    // ---- positions -> columns / lines (in order, keeping proportions, with room where needed)
    function axis(values, cell, needs) {
      const vs = [...new Set(values.map((v) => Math.round(v * 10) / 10))].sort((a, b) => a - b);
      const clusters = [];
      for (const v of vs) {
        const c = clusters[clusters.length - 1];
        if (c && v - c.hi <= cell * 0.45) { c.hi = v; c.vals.push(v); } else clusters.push({ lo: v, hi: v, vals: [v] });
      }
      const idx = (v) => {
        let best = 0, bd = Infinity;
        clusters.forEach((c, k) => { const d = v < c.lo ? c.lo - v : v > c.hi ? v - c.hi : 0; if (d < bd) { bd = d; best = k; } });
        return best;
      };
      const pos = new Array(clusters.length).fill(0);
      const cons = needs.map(([a, b, need]) => [idx(a), idx(b), need]).filter(([a, b]) => a < b);
      for (let k = 0; k < clusters.length; k++) {
        if (k === 0) { pos[k] = 0; continue; }
        const gap = Math.round((clusters[k].lo - clusters[k - 1].hi) / cell);
        let p = pos[k - 1] + Math.max(1, gap);
        for (const [a, b, need] of cons) if (b === k) p = Math.max(p, pos[a] + need);
        pos[k] = p;
      }
      return (v) => pos[idx(v)];
    }
    const xs = [], ys = [], xNeeds = [], yNeeds = [];
    for (const b of uniq) {
      xs.push(b.x1, b.x2); ys.push(b.y1, b.y2);
      const w = Math.max(...b.label.map((l) => l.length), b.tags.length, 1);
      xNeeds.push([b.x1, b.x2, w + 4]);
      yNeeds.push([b.y1, b.y2, b.label.length + (b.tags ? 1 : 0) + 1 + (b.titleTop ? 0 : 0)]);
      // children keep a space from their parent's walls, and a container's title its own line
      for (const k of uniq) {
        if (k === b || !(k.x1 >= b.x1 && k.x2 <= b.x2 && k.y1 >= b.y1 && k.y2 <= b.y2)) continue;
        xNeeds.push([b.x1, k.x1, 2], [k.x2, b.x2, 2]);
        yNeeds.push([b.y1, k.y1, b.titleTop ? b.label.length + (b.tags ? 1 : 0) + 1 : 1], [k.y2, b.y2, 1]);
      }
    }
    for (const s of segs) {
      xs.push(s.x1, s.x2); ys.push(s.y1, s.y2);
      // (room for at least a shaft and an arrowhead between two walls)
      if (s.y1 === s.y2) xNeeds.push([s.x1, s.x2, 3]); else yNeeds.push([s.y1, s.y2, 3]);
    }
    for (const t of free) {
      const len = t.text.length * t.size * 0.6;
      const x0 = t.anchor === 'middle' ? t.x - len / 2 : t.anchor === 'end' ? t.x - len : t.x;
      t.x0 = x0;
      xs.push(x0); ys.push(t.y);
    }
    // boxes side by side keep a gap
    for (const a of uniq) for (const b of uniq) {
      if (a === b) continue;
      const overlapY = a.y1 < b.y2 && b.y1 < a.y2, overlapX = a.x1 < b.x2 && b.x1 < a.x2;
      if (overlapY && a.x2 <= b.x1) xNeeds.push([a.x2, b.x1, 2]);
      if (overlapX && a.y2 <= b.y1) yNeeds.push([a.y2, b.y1, 2]);
    }
    const X = axis(xs.length ? xs : [0], cw, xNeeds);
    const Y = axis(ys.length ? ys : [0], ch, yNeeds);

    // ---- draw
    const grid = [];
    const put = (r, c, chr) => {
      if (r < 0 || c < 0) return;
      while (grid.length <= r) grid.push([]);
      const row = grid[r];
      while (row.length <= c) row.push(' ');
      row[c] = chr;
    };
    const get = (r, c) => (grid[r] && grid[r][c]) || ' ';
    const placed = uniq.map((b) => ({ b, r1: Y(b.y1), r2: Y(b.y2), c1: X(b.x1), c2: X(b.x2) }));
    // outer boxes first, so inner ones draw over them
    for (const p of placed.slice().sort((p, q) => area(q.b) - area(p.b))) {
      const { b, r1, r2, c1, c2 } = p;
      // (a dashed wall alternates '-=' / '|:': plain ditaa needs both in a dashed line)
      const hz = (c) => (b.dashed && c % 2 ? '=' : '-'), vt = (r) => (b.dashed && r % 2 ? ':' : '|');
      for (let c = c1 + 1; c < c2; c++) { put(r1, c, hz(c)); put(r2, c, hz(c)); }
      for (let r = r1 + 1; r < r2; r++) { put(r, c1, vt(r)); put(r, c2, vt(r)); for (let c = c1 + 1; c < c2; c++) put(r, c, ' '); }
      const corner = b.rounded ? ['/', '\\', '\\', '/'] : ['+', '+', '+', '+'];
      put(r1, c1, corner[0]); put(r1, c2, corner[1]); put(r2, c1, corner[2]); put(r2, c2, corner[3]);
    }
    for (const p of placed) {
      const { b, r1, r2, c1, c2 } = p;
      const lines = b.label.concat(b.tags ? [b.tags] : []);
      if (!lines.length) continue;
      // a container's title at its top-left; a leaf's label in its middle
      const kids = placed.filter((k) => k !== p && k.r1 >= r1 && k.r2 <= r2 && k.c1 >= c1 && k.c2 <= c2);
      const top = kids.length ? r1 + 1 : r1 + 1 + Math.max(0, Math.floor((r2 - r1 - 1 - lines.length) / 2));
      lines.forEach((l, k) => {
        const r = top + k;
        if (r >= r2) return;
        const width = c2 - c1 - 1;
        const start = kids.length ? c1 + 2 : c1 + 1 + Math.max(1, Math.floor((width - l.length) / 2));
        [...l].forEach((chr, j) => { if (start + j < c2) put(r, start + j, chr); });
      });
    }
    // lines: mark each cell's directions, then pick characters
    const dirs = new Map();
    const mark = (r, c, bit, dashed) => {
      const k = r * 100000 + c;
      const v = dirs.get(k) || { r, c, bits: 0, dashed: false };
      v.bits |= bit; v.dashed = v.dashed || dashed;
      dirs.set(k, v);
    };
    const boxAt = (r, c) => placed.find((p) => (r === p.r1 || r === p.r2 ? c >= p.c1 && c <= p.c2 : (c === p.c1 || c === p.c2) && r > p.r1 && r < p.r2));
    const ends = [];
    for (const s of segs) {
      if (s.y1 === s.y2) {
        const r = Y(s.y1);
        let a = X(s.x1), z = X(s.x2);
        if (boxAt(r, a)) a++; // a line leaving a wall starts just outside it
        if (boxAt(r, z)) z--;
        for (let c = a; c <= z; c++) mark(r, c, (c > a ? 8 : 0) | (c < z ? 2 : 0) | (a === z ? 10 : 0), s.dashed);
        ends.push({ r, c: a, dir: 'left', x: s.x1, y: s.y1 }, { r, c: z, dir: 'right', x: s.x2, y: s.y1 });
      } else {
        const c = X(s.x1);
        let a = Y(s.y1), z = Y(s.y2);
        if (boxAt(a, c)) a++;
        if (boxAt(z, c)) z--;
        for (let r = a; r <= z; r++) mark(r, c, (r > a ? 1 : 0) | (r < z ? 4 : 0) | (a === z ? 5 : 0), s.dashed);
        ends.push({ r: a, c, dir: 'up', x: s.x1, y: s.y1 }, { r: z, c, dir: 'down', x: s.x1, y: s.y2 });
      }
    }
    for (const v of dirs.values()) {
      if (get(v.r, v.c) !== ' ') continue; // never over a box or its label
      const h = v.bits & 10, vv = v.bits & 5;
      put(v.r, v.c, h && vv ? '+' : h ? (v.dashed && v.c % 2 ? '=' : '-') : (v.dashed && v.r % 2 ? ':' : '|'));
    }
    // arrowheads: on the line end nearest each head, pointing its way
    const HEAD = { up: '^', down: 'v', left: '<', right: '>' };
    let arrows = 0;
    for (const hd of heads) {
      let best = null;
      for (const e of ends) {
        if (e.dir !== hd.dir) continue;
        const d = Math.hypot(e.x - hd.x, e.y - hd.y);
        if (d < Math.max(cw, ch) * 2.5 && (!best || d < best.d)) best = { ...e, d };
      }
      if (best && '-=|:+'.includes(get(best.r, best.c)) && get(best.r, best.c) !== ' ') { put(best.r, best.c, HEAD[hd.dir]); arrows++; }
    }
    // free text where it was, on empty cells only
    for (const t of free) {
      const r = Y(t.y), c = X(t.x0);
      [...t.text].forEach((chr, j) => { if (get(r, c + j) === ' ') put(r, c + j, chr); });
    }
    let text = grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
    if (legends.length) text += '\n\n' + legends.join('\n');
    const notes = [];
    return {
      text,
      boxes: uniq.length,
      lines: segs.length,
      arrows,
      labels: uniq.filter((b) => b.label.length).length,
      notes
    };
  }

  /** One call for the app: an SVG text, or { width, height, data } pixels. */
  function importDiagram(input) {
    const scene = typeof input === 'string' ? fromSVG(input) : fromPixels(input.width, input.height, input.data);
    const res = toAscii(scene);
    if (!scene.boxes.length && !scene.segs.length) res.error = 'No boxes or lines were found in that picture';
    return res;
  }

  const api = { fromSVG, fromPixels, toAscii, importDiagram, parsePath, parseTransform, colorTag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DiagramImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
