/*
 * text-diagram engine: a zero-dependency ditaa-style ASCII → SVG parser/renderer
 * plus a 2D grid editor for stamping, shifting and resizing boxes.
 *
 * Works in the browser (exposes globalThis.DitaaEngine) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  /*************************************************************************
   * COLOR & TAG DEFINITIONS
   *************************************************************************/
  const COLOR_MAP = {
    cBLU: { fill: '#dbeafe', stroke: '#1e40af', text: '#1e3a8a', badge: '#bfdbfe' },
    cGRE: { fill: '#dcfce7', stroke: '#166534', text: '#14532d', badge: '#bbf7d0' },
    cYEL: { fill: '#fef9c3', stroke: '#854d0e', text: '#713f12', badge: '#fef08a' },
    cRED: { fill: '#fee2e2', stroke: '#991b1b', text: '#7f1d1d', badge: '#fecaca' },
    cPNK: { fill: '#fce7f3', stroke: '#9d174d', text: '#831843', badge: '#fbcfe8' },
    cBLK: { fill: '#334155', stroke: '#0f172a', text: '#f8fafc', badge: '#475569' }
  };

  // {c} = choice / conditional diamond (as in ditaa 0.9+, PlantUML and Asciidoctor Diagram)
  const SHAPE_TAGS = { '{s}': 'storage', '{d}': 'document', '{io}': 'io', '{mo}': 'manual', '{o}': 'ellipse', '{c}': 'choice' };
  const NAMED_COLOR_RE = /\bc(?:BLU|GRE|YEL|RED|PNK|BLK)\b/;
  // Shape tags, named colors, c#RRGGBB and ditaa-style cRGB (uppercase hex only, so words like "cafe" stay text).
  const TAG_RE = /\{(?:s|d|io|mo|o|c|\*)\}|\bc(?:BLU|GRE|YEL|RED|PNK|BLK)\b|\bc#[0-9a-fA-F]{6}\b|\bc[0-9A-F]{3}\b/g;

  // "# [D] = Diagram Engine", "# D: Diagram Engine", "[D] = Diagram Engine"
  const LEGEND_RE = /^\s*#?\s*(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]{1,3}))\s*(?:=|:)\s*(.+)$/;

  const isAlnum = (ch) => /[A-Za-z0-9]/.test(ch);
  // Characters that form horizontal lines / box corners; a column between two of them is continued.
  const lineCh = (ch) => '-=+*<>/\\.\''.includes(ch);
  // Two adjacent non-blank characters that are not a line and not next to a vertical line: text.
  const isWordPair = (L, R) =>
    L !== ' ' && R !== ' ' && !(lineCh(L) && lineCh(R)) && L !== '|' && L !== ':' && R !== '|' && R !== ':';
  const isVertish = (ch) => ch === '|' || ch === ':' || ch === '+' || ch === '^' || ch === 'v' || ch === '*';
  // Vertical lines plus rounded corners: a row inserted between two of these continues the line.
  const vLineCh = (ch) => isVertish(ch) || ch === '/' || ch === '\\' || ch === '.' || ch === "'";

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#0f172a' : '#f8fafc';
  }

  /*************************************************************************
   * CORE 2D ASCII-TO-SVG PARSER ENGINE
   *************************************************************************/
  class DitaaParser {
    constructor(options = {}) {
      this.cellW = options.cellW || 10;
      this.cellH = options.cellH || 18;
      this.healInlineArrows = options.healInlineArrows !== false;
      this.legendMode = options.legendMode || 'both';
      this.showShadows = options.showShadows !== false;
      this.showGrid = options.showGrid || false;
      this.lightCanvas = options.lightCanvas !== false;
    }

    /** Returns the legend {key, val} on a legend line, or null. */
    static matchLegendLine(line) {
      const t = line.trim();
      if (!(t.startsWith('#') || t.startsWith('['))) return null;
      const m = line.match(LEGEND_RE);
      if (!m) return null;
      return { key: (m[1] || m[2]).trim(), val: m[3].trim() };
    }

    /** True for '#' comment lines and legend definition lines (not drawn on the grid). */
    static isLegendOrCommentLine(line) {
      return line.trim().startsWith('#') || DitaaParser.matchLegendLine(line) !== null;
    }

    /**
     * Main entry point: parses ASCII text into boxes, wires, arrowheads,
     * junctions, free text and legends.
     *
     * Legend/comment lines are blanked IN PLACE so that grid row N always equals
     * editor line N (the editor relies on this to map the caret to boxes).
     */
    parse(rawText) {
      const allLines = rawText.replace(/\r\n?/g, '\n').split('\n');
      const legends = Object.create(null); // no prototype: a box labelled "toString" is not a legend key

      const diagramLines = allLines.map((line) => {
        const lg = DitaaParser.matchLegendLine(line);
        if (lg) {
          legends[lg.key] = lg.val;
          return '';
        }
        return line.trim().startsWith('#') ? '' : line;
      });

      while (diagramLines.length > 0 && diagramLines[diagramLines.length - 1].trim() === '') {
        diagramLines.pop();
      }

      const numRows = diagramLines.length;
      const numCols = diagramLines.reduce((max, l) => Math.max(max, l.length), 0);

      const grid = [];
      for (let r = 0; r < numRows; r++) {
        const line = diagramLines[r];
        const rowChars = [];
        for (let c = 0; c < numCols; c++) rowChars.push(c < line.length ? line[c] : ' ');
        grid.push(rowChars);
      }

      const cellRole = Array.from({ length: numRows }, () => Array(numCols).fill('empty'));
      const inlineBorderArrows = [];

      const boxes = this.detectBoxes(grid, numRows, numCols, cellRole, inlineBorderArrows, legends);

      // Border cells of diamond ({c}) boxes, so wires and arrowheads can end on the slanted edges.
      const diamondAt = Array.from({ length: numRows }, () => Array(numCols).fill(null));
      for (const b of boxes) {
        if (b.shape !== 'choice') continue;
        for (let r = b.r1; r <= b.r2; r++) {
          for (let c = b.c1; c <= b.c2; c++) {
            if (r === b.r1 || r === b.r2 || c === b.c1 || c === b.c2) diamondAt[r][c] = b;
          }
        }
      }

      const { wires, arrows, junctions, freeTexts } = this.detectWiresAndText(
        grid, numRows, numCols, cellRole, inlineBorderArrows, diamondAt
      );

      return { grid, numRows, numCols, boxes, wires, arrows, junctions, freeTexts, legends };
    }

    isHorizWallChar(ch, allowInlineArrow) {
      if (ch === '-' || ch === '=' || ch === '+' || ch === '*') return true;
      if (allowInlineArrow && (ch === '^' || ch === 'v')) return true;
      return false;
    }

    isVertWallChar(ch, allowInlineArrow) {
      if (ch === '|' || ch === ':' || ch === '+' || ch === '*') return true;
      if (allowInlineArrow && (ch === '<' || ch === '>')) return true;
      return false;
    }

    /** Scans the grid for minimal closed rectangles bounded by corners and continuous walls. */
    findRects(grid, numRows, numCols) {
      const rects = [];
      const inl = this.healInlineArrows;

      for (let r1 = 0; r1 < numRows - 2; r1++) {
        for (let c1 = 0; c1 < numCols - 2; c1++) {
          const tl = grid[r1][c1];
          if (!(tl === '+' || tl === '/' || tl === '.')) continue;

          for (let c2 = c1 + 2; c2 < numCols; c2++) {
            const tr = grid[r1][c2];
            const trIsCorner = tr === '+' || tr === '\\' || tr === '.' || (inl && (tr === '^' || tr === 'v'));
            if (!this.isHorizWallChar(tr, inl) && !trIsCorner) break; // top wall broken
            if (!trIsCorner) continue;

            let found = false;
            for (let r2 = r1 + 2; r2 < numRows; r2++) {
              // Vertical walls between r1+1 .. r2-1 must be continuous
              let vertValid = true;
              for (let r = r1 + 1; r < r2; r++) {
                if (!this.isVertWallChar(grid[r][c1], inl) || !this.isVertWallChar(grid[r][c2], inl)) {
                  vertValid = false;
                  break;
                }
              }
              if (!vertValid) break;

              const leftCh = grid[r2][c1];
              const rightCh = grid[r2][c2];
              const blOk = leftCh === '+' || leftCh === '\\' || leftCh === "'" || (inl && (leftCh === '^' || leftCh === 'v'));
              const brOk = rightCh === '+' || rightCh === '/' || rightCh === "'" || (inl && (rightCh === '^' || rightCh === 'v'));
              if (!(blOk && brOk)) continue;

              let botValid = true;
              for (let c = c1 + 1; c < c2; c++) {
                if (!this.isHorizWallChar(grid[r2][c], inl)) {
                  botValid = false;
                  break;
                }
              }
              if (botValid) {
                rects.push({ r1, c1, r2, c2 });
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
      }
      return rects;
    }

    detectBoxes(grid, numRows, numCols, cellRole, inlineBorderArrows, legends) {
      const rects = this.findRects(grid, numRows, numCols);

      // Containment: a box that encloses other boxes is a "container". Its interior is NOT
      // consumed as label text so wires/text drawn inside it render normally.
      const contains = (p, q) =>
        p !== q && q.r1 >= p.r1 && q.r2 <= p.r2 && q.c1 >= p.c1 && q.c2 <= p.c2;
      rects.forEach((p) => {
        p.isContainer = rects.some((q) => contains(p, q));
      });

      // Mark perimeters & interiors, largest first so nested boxes override their parent.
      const area = (b) => (b.r2 - b.r1) * (b.c2 - b.c1);
      const byArea = rects.slice().sort((a, b) => area(b) - area(a));
      for (const b of byArea) {
        for (let r = b.r1; r <= b.r2; r++) {
          for (let c = b.c1; c <= b.c2; c++) {
            const onBorder = r === b.r1 || r === b.r2 || c === b.c1 || c === b.c2;
            if (onBorder) cellRole[r][c] = 'box-border';
            else if (!b.isContainer) cellRole[r][c] = 'box-interior';
          }
        }
      }

      const seenInline = new Set();
      return rects.map((rect) =>
        this.extractBoxMetadata(grid, rect, cellRole, inlineBorderArrows, seenInline, legends)
      );
    }

    /**
     * Extracts interior text, strips ditaa tags ({s}, {d}, {io}, {mo}, {o}, {*}, cBLU, c#RRGGBB, cRGB),
     * and records inline border arrows.
     */
    extractBoxMetadata(grid, rect, cellRole, inlineBorderArrows, seenInline, legends) {
      const { r1, c1, r2, c2, isContainer } = rect;
      const rounded =
        grid[r1][c1] === '/' || grid[r1][c2] === '\\' || grid[r2][c1] === '\\' || grid[r2][c2] === '/' ||
        grid[r1][c1] === '.' || grid[r1][c2] === '.' || grid[r2][c1] === "'" || grid[r2][c2] === "'";

      let dashedBorder = false;
      const pushInline = (r, c, dir, wall) => {
        const k = `${r},${c}`;
        if (seenInline.has(k)) return; // walls shared by two boxes
        seenInline.add(k);
        inlineBorderArrows.push({ r, c, dir, wall });
      };

      for (let c = c1; c <= c2; c++) {
        const topCh = grid[r1][c];
        const botCh = grid[r2][c];
        if (topCh === '=' || botCh === '=') dashedBorder = true;
        if (this.healInlineArrows && (topCh === '^' || topCh === 'v')) pushInline(r1, c, topCh, 'top');
        if (this.healInlineArrows && (botCh === '^' || botCh === 'v')) pushInline(r2, c, botCh, 'bottom');
      }
      for (let r = r1; r <= r2; r++) {
        const leftCh = grid[r][c1];
        const rightCh = grid[r][c2];
        if (leftCh === ':' || rightCh === ':') dashedBorder = true;
        if (this.healInlineArrows && (leftCh === '<' || leftCh === '>')) pushInline(r, c1, leftCh, 'left');
        if (this.healInlineArrows && (rightCh === '<' || rightCh === '>')) pushInline(r, c2, rightCh, 'right');
      }

      let shape = 'rect';
      let colorKey = null;
      let customHex = null;

      const applyTag = (tok) => {
        if (SHAPE_TAGS[tok]) shape = SHAPE_TAGS[tok];
        else if (tok === '{*}') dashedBorder = true;
        else if (NAMED_COLOR_RE.test(tok)) colorKey = tok;
        else if (tok.startsWith('c#')) customHex = '#' + tok.slice(2).toLowerCase();
        else if (/^c[0-9A-F]{3}$/.test(tok)) customHex = '#' + tok.slice(1).split('').map((h) => h + h).join('').toLowerCase();
      };

      const lines = [];
      for (let r = r1 + 1; r < r2; r++) {
        if (isContainer) {
          // Only consume tag tokens lying in cells this container owns; everything else stays free text/wires.
          let s = '';
          for (let c = c1 + 1; c < c2; c++) s += cellRole[r][c] === 'empty' ? grid[r][c] : '\u0000';
          for (const m of s.matchAll(TAG_RE)) {
            applyTag(m[0]);
            for (let i = 0; i < m[0].length; i++) cellRole[r][c1 + 1 + m.index + i] = 'box-interior';
          }
        } else {
          let s = '';
          for (let c = c1 + 1; c < c2; c++) s += grid[r][c];
          for (const m of s.matchAll(TAG_RE)) applyTag(m[0]);
          const cleaned = s.replace(TAG_RE, '').trim();
          if (cleaned.length > 0) lines.push(cleaned);
        }
      }

      // 4x4 legend macro: a box whose only label is "[D]" (or a bare legend key "D")
      let macroKey = null;
      let macroExpanded = null;
      if (lines.length === 1) {
        const token = lines[0];
        const bracketMatch = token.match(/^\[([A-Za-z0-9_]+)\]$/);
        const bareKey = bracketMatch ? bracketMatch[1] : token;
        if (Object.prototype.hasOwnProperty.call(legends, bareKey)) {
          macroKey = bareKey;
          macroExpanded = legends[bareKey];
        }
      }

      return { r1, c1, r2, c2, rounded, dashedBorder, shape, colorKey, customHex, isContainer, lines, macroKey, macroExpanded };
    }

    /** Traces exterior wires, arrowheads, junction dots (*) and free text labels. */
    /** Pixel geometry of a box as drawn (border lines run through the centres of the border cells). */
    boxGeom(box) {
      const x = (box.c1 + 0.5) * this.cellW;
      const y = (box.r1 + 0.5) * this.cellH;
      const w = (box.c2 - box.c1) * this.cellW;
      const h = (box.r2 - box.r1) * this.cellH;
      return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    }

    /**
     * Where a wire meets a diamond's edge. `side` is the side of the bounding box the wire
     * arrives at; `along` is the wire's y (left/right) or x (top/bottom) in px. Returns the
     * x (left/right) or y (top/bottom) of the edge. A wire along the very edge of the bounding
     * box only touches the diamond at a vertex, so it runs on to that vertex.
     */
    diamondEdge(box, side, along) {
      const { w, h, cx, cy } = this.boxGeom(box);
      const horiz = side === 'left' || side === 'right';
      const t = Math.max(0, horiz ? 1 - Math.abs(along - cy) / (h / 2) : 1 - Math.abs(along - cx) / (w / 2));
      return {
        left: cx - (w / 2) * t,
        right: cx + (w / 2) * t,
        top: cy - (h / 2) * t,
        bottom: cy + (h / 2) * t
      }[side];
    }

    detectWiresAndText(grid, numRows, numCols, cellRole, inlineBorderArrows, diamondAt) {
      const wires = [];
      const arrows = [];
      const junctions = [];
      const freeTexts = [];
      const diamond = (r, c) => (r >= 0 && r < numRows && c >= 0 && c < numCols ? diamondAt[r][c] : null);

      for (const ia of inlineBorderArrows) {
        const a = { r: ia.r, c: ia.c, dir: ia.dir, inline: true, wall: ia.wall };
        const d = diamond(ia.r, ia.c);
        if (d) {
          // Inline arrow on a diamond wall: draw the tip on the slanted edge
          const ax = (ia.c + 0.5) * this.cellW, ay = (ia.r + 0.5) * this.cellH;
          if (ia.wall === 'top' || ia.wall === 'bottom') a.tipY = this.diamondEdge(d, ia.wall, ax);
          else a.tipX = this.diamondEdge(d, ia.wall, ay);
        }
        arrows.push(a);
      }

      const at = (r, c) => (r >= 0 && r < numRows && c >= 0 && c < numCols ? grid[r][c] : ' ');
      // A glyph flanked by a letter/digit is part of a word ("v1.2", "it's"), not a wire.
      const inWord = (r, c) => isAlnum(at(r, c - 1)) || isAlnum(at(r, c + 1));

      const isHorizWireConnectable = (r, c) => {
        if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
        if (cellRole[r][c] === 'box-interior') return false;
        return '-=+*><.\''.includes(grid[r][c]) || cellRole[r][c] === 'box-border';
      };
      const isVertWireConnectable = (r, c) => {
        if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
        if (cellRole[r][c] === 'box-interior') return false;
        return '|:+*^v.\''.includes(grid[r][c]) || cellRole[r][c] === 'box-border';
      };

      // Spaced dashed wires such as "= = = = >" or "< = = =".
      for (let r = 0; r < numRows; r++) {
        let s = '';
        for (let c = 0; c < numCols; c++) s += cellRole[r][c] === 'empty' ? grid[r][c] : '\u0000';
        for (const m of s.matchAll(/(?:< ?)?=(?: =)+(?: ?>)?/g)) {
          for (let i = 0; i < m[0].length; i++) {
            const c = m.index + i;
            const ch = grid[r][c];
            if (ch === '<' || ch === '>') {
              cellRole[r][c] = 'wire-arrow';
              arrows.push({ r, c, dir: ch, inline: false });
            } else {
              cellRole[r][c] = 'wire-h';
            }
          }
        }
      }

      // Classify exterior wire characters vs free text characters
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          if (cellRole[r][c] !== 'empty') continue;
          const ch = grid[r][c];
          if (ch === ' ') continue;

          if (ch === '-' || ch === '=') {
            // Not a hyphen inside a word like "client-side"
            if (!(isAlnum(at(r, c - 1)) && isAlnum(at(r, c + 1)))) cellRole[r][c] = 'wire-h';
          } else if (ch === '|' || ch === ':') {
            if (ch === '|' || isVertWireConnectable(r - 1, c) || isVertWireConnectable(r + 1, c)) {
              cellRole[r][c] = 'wire-v';
            }
          } else if (ch === '+' || ch === '.' || ch === "'" || ch === '*') {
            if (ch !== '+' && inWord(r, c)) continue;
            const hasWireNeighbor =
              isHorizWireConnectable(r, c - 1) || isHorizWireConnectable(r, c + 1) ||
              isVertWireConnectable(r - 1, c) || isVertWireConnectable(r + 1, c);
            if (hasWireNeighbor) {
              if (ch === '*') {
                cellRole[r][c] = 'wire-junction';
                junctions.push({ r, c });
              } else {
                cellRole[r][c] = 'wire-corner';
              }
            }
          } else if (ch === '>' || ch === '<' || ch === '^' || ch === 'v') {
            if ((ch === '^' || ch === 'v') && inWord(r, c)) continue;
            const connected =
              ((ch === '>' || ch === '<') && (isHorizWireConnectable(r, c - 1) || isHorizWireConnectable(r, c + 1))) ||
              ((ch === '^' || ch === 'v') && (isVertWireConnectable(r - 1, c) || isVertWireConnectable(r + 1, c)));
            if (connected) {
              cellRole[r][c] = 'wire-arrow';
              arrows.push({ r, c, dir: ch, inline: false });
            }
          }
        }
      }

      // Horizontal wire segments
      const isHorizNode = (r, c) => {
        if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
        const role = cellRole[r][c];
        if (role === 'wire-h' || role === 'wire-corner' || role === 'wire-junction') return true;
        return role === 'wire-arrow' && (grid[r][c] === '<' || grid[r][c] === '>');
      };
      for (let r = 0; r < numRows; r++) {
        let c = 0;
        while (c < numCols) {
          if (isHorizNode(r, c)) {
            const startC = c;
            let dashed = grid[r][c] === '=';
            while (c + 1 < numCols && isHorizNode(r, c + 1)) {
              c++;
              if (grid[r][c] === '=') dashed = true;
            }
            const endC = c;
            let x1 = (startC + 0.5) * this.cellW;
            let x2 = (endC + 0.5) * this.cellW;
            const y = (r + 0.5) * this.cellH;
            if (startC > 0 && cellRole[r][startC - 1] === 'box-border') {
              const d = diamond(r, startC - 1);
              x1 = d ? this.diamondEdge(d, 'right', y) : (startC - 0.5) * this.cellW;
            }
            if (endC + 1 < numCols && cellRole[r][endC + 1] === 'box-border') {
              const d = diamond(r, endC + 1);
              x2 = d ? this.diamondEdge(d, 'left', y) : (endC + 1.5) * this.cellW;
            }
            if (x2 > x1) wires.push({ x1, y1: y, x2, y2: y, dashed });
          }
          c++;
        }
      }

      // Vertical wire segments
      const isVertNode = (r, c) => {
        if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
        const role = cellRole[r][c];
        if (role === 'wire-v' || role === 'wire-corner' || role === 'wire-junction') return true;
        return role === 'wire-arrow' && (grid[r][c] === '^' || grid[r][c] === 'v');
      };
      for (let c = 0; c < numCols; c++) {
        let r = 0;
        while (r < numRows) {
          if (isVertNode(r, c)) {
            const startR = r;
            let dashed = grid[r][c] === ':';
            while (r + 1 < numRows && isVertNode(r + 1, c)) {
              r++;
              if (grid[r][c] === ':') dashed = true;
            }
            const endR = r;
            const x = (c + 0.5) * this.cellW;
            let y1 = (startR + 0.5) * this.cellH;
            let y2 = (endR + 0.5) * this.cellH;
            if (startR > 0 && cellRole[startR - 1][c] === 'box-border') {
              const d = diamond(startR - 1, c);
              y1 = d ? this.diamondEdge(d, 'bottom', x) : (startR - 0.5) * this.cellH;
            }
            if (endR + 1 < numRows && cellRole[endR + 1][c] === 'box-border') {
              const d = diamond(endR + 1, c);
              y2 = d ? this.diamondEdge(d, 'top', x) : (endR + 1.5) * this.cellH;
            }
            if (y2 > y1) wires.push({ x1: x, y1, x2: x, y2, dashed });
          }
          r++;
        }
      }

      // Arrowheads that touch a box border put their tip ON the border.
      for (const a of arrows) {
        if (a.inline) continue;
        const d = { '>': [0, 1], '<': [0, -1], '^': [-1, 0], v: [1, 0] }[a.dir];
        const nr = a.r + d[0], nc = a.c + d[1];
        a.touchesBox = nr >= 0 && nr < numRows && nc >= 0 && nc < numCols && cellRole[nr][nc] === 'box-border';
        const dia = a.touchesBox && diamond(nr, nc);
        if (dia) {
          const ax = (a.c + 0.5) * this.cellW, ay = (a.r + 0.5) * this.cellH;
          const side = { '>': 'left', '<': 'right', '^': 'bottom', v: 'top' }[a.dir];
          if (a.dir === '>' || a.dir === '<') a.tipX = this.diamondEdge(dia, side, ay);
          else a.tipY = this.diamondEdge(dia, side, ax);
        }
      }

      // Remaining unclaimed characters become free text labels (single spaces join words)
      for (let r = 0; r < numRows; r++) {
        let c = 0;
        while (c < numCols) {
          if (cellRole[r][c] === 'empty' && grid[r][c] !== ' ') {
            const startC = c;
            let text = '';
            while (
              c < numCols &&
              cellRole[r][c] === 'empty' &&
              (grid[r][c] !== ' ' || (c + 1 < numCols && cellRole[r][c + 1] === 'empty' && grid[r][c + 1] !== ' '))
            ) {
              text += grid[r][c];
              c++;
            }
            freeTexts.push({ r, c: startC, text: text.trim() });
          } else {
            c++;
          }
        }
      }

      return { wires, arrows, junctions, freeTexts };
    }

    /** Renders the parsed AST into a standalone SVG string. Pass selectedBoxIndex = -1 for exports. */
    renderSVG(ast, selectedBoxIndex = -1) {
      const { numRows, numCols, boxes, wires, arrows, junctions, freeTexts, legends } = ast;
      const padX = 28;
      const padY = 28;

      const legendKeys = Object.keys(legends);
      const showLegendCard = legendKeys.length > 0 && (this.legendMode === 'both' || this.legendMode === 'card');
      const legendRowsCount = showLegendCard ? Math.ceil(legendKeys.length / 2) : 0;
      const legendHeight = showLegendCard ? 54 + legendRowsCount * 28 : 0;

      const contentW = Math.max(numCols * this.cellW, 320);
      const contentH = Math.max(numRows * this.cellH, 160);
      const svgW = contentW + padX * 2;
      const svgH = contentH + padY * 2 + legendHeight;

      const bgFill = this.lightCanvas ? '#ffffff' : '#0f172a';
      const wireStroke = this.lightCanvas ? '#1e293b' : '#e2e8f0';
      const defaultBoxFill = this.lightCanvas ? '#f8fafc' : '#1e293b';
      const defaultBoxStroke = this.lightCanvas ? '#334155' : '#94a3b8';
      const defaultTextFill = this.lightCanvas ? '#0f172a' : '#f8fafc';
      const freeTextFill = this.lightCanvas ? '#475569' : '#cbd5e1';
      const esc = (s) => this.escapeXml(String(s));

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" style="font-family: 'Inter', system-ui, sans-serif;">`;
      svg += `<defs>
          <filter id="ditaa-shadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow dx="2" dy="3" stdDeviation="2.5" flood-color="#0f172a" flood-opacity="${this.lightCanvas ? '0.14' : '0.45'}" />
          </filter>
        </defs>`;
      svg += `<rect width="100%" height="100%" fill="${bgFill}" />`;
      svg += `<g transform="translate(${padX}, ${padY})">`;

      if (this.showGrid) {
        svg += `<g stroke="${this.lightCanvas ? '#e2e8f0' : '#1e293b'}" stroke-width="0.75">`;
        for (let r = 0; r <= numRows; r++) svg += `<line x1="0" y1="${r * this.cellH}" x2="${contentW}" y2="${r * this.cellH}" />`;
        for (let c = 0; c <= numCols; c++) svg += `<line x1="${c * this.cellW}" y1="0" x2="${c * this.cellW}" y2="${contentH}" />`;
        svg += `</g>`;
      }

      // 1. Boxes — containers (largest) first so nested boxes paint on top of them.
      const area = (b) => (b.r2 - b.r1) * (b.c2 - b.c1);
      const order = boxes.map((_, i) => i).sort((a, b) => area(boxes[b]) - area(boxes[a]));

      for (const bIdx of order) {
        const box = boxes[bIdx];
        const isSelected = bIdx === selectedBoxIndex;
        const x = (box.c1 + 0.5) * this.cellW;
        const y = (box.r1 + 0.5) * this.cellH;
        const w = (box.c2 - box.c1) * this.cellW;
        const h = (box.r2 - box.r1) * this.cellH;

        const palette = box.colorKey && COLOR_MAP[box.colorKey]
          ? COLOR_MAP[box.colorKey]
          : box.customHex
            ? { fill: box.customHex, stroke: defaultBoxStroke, text: textColorFor(box.customHex), badge: '#e2e8f0' }
            : { fill: defaultBoxFill, stroke: defaultBoxStroke, text: defaultTextFill, badge: '#e2e8f0' };

        const filterAttr = this.showShadows ? ` filter="url(#ditaa-shadow)"` : '';
        const dashAttr = box.dashedBorder ? ` stroke-dasharray="5,4"` : '';
        const common = `fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="2"${dashAttr}`;

        svg += `<g class="ditaa-box" style="cursor:pointer" data-box-index="${bIdx}">`;
        if (isSelected) {
          svg += `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="${box.rounded ? 12 : 5}" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-dasharray="4,2" />`;
        }

        if (box.shape === 'storage') {
          const ry = Math.min(10, Math.max(6, h * 0.15));
          const bodyPath = `M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry} Z`;
          svg += `<path d="${bodyPath}" ${common}${filterAttr} />`;
          svg += `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" ${common} />`;
        } else if (box.shape === 'document') {
          const waveAmp = Math.min(8, h * 0.14);
          const docPath = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h - waveAmp} Q ${x + w * 0.75} ${y + h - waveAmp * 2.4} ${x + w / 2} ${y + h - waveAmp} T ${x} ${y + h - waveAmp} Z`;
          svg += `<path d="${docPath}" ${common}${filterAttr} />`;
        } else if (box.shape === 'io') {
          const slant = Math.min(14, w * 0.12);
          svg += `<path d="M ${x + slant} ${y} L ${x + w} ${y} L ${x + w - slant} ${y + h} L ${x} ${y + h} Z" ${common}${filterAttr} />`;
        } else if (box.shape === 'manual') {
          const inset = Math.min(14, w * 0.12);
          svg += `<path d="M ${x} ${y} L ${x + w} ${y} L ${x + w - inset} ${y + h} L ${x + inset} ${y + h} Z" ${common}${filterAttr} />`;
        } else if (box.shape === 'choice') {
          // Conditional diamond: vertices at the centres of the four walls (the ASCII '+' ports)
          svg += `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${common} stroke-linejoin="round"${filterAttr} />`;
        } else if (box.shape === 'ellipse') {
          svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" ${common}${filterAttr} />`;
        } else {
          const rx = box.rounded ? 9 : 2;
          svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" ${common}${filterAttr} />`;
        }

        const cx = x + w / 2;
        const cy = y + h / 2;

        if (box.macroKey && this.legendMode !== 'off') {
          if (this.legendMode === 'inline' || this.legendMode === 'both') {
            const badgeW = Math.max(18, box.macroKey.length * 8 + 8);
            svg += `<rect x="${x + 4}" y="${y + 4}" width="${badgeW}" height="14" rx="4" fill="${palette.stroke}" />`;
            svg += `<text x="${x + 4 + badgeW / 2}" y="${y + 13.5}" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${esc(box.macroKey)}</text>`;

            const words = box.macroExpanded.split(/\s+/);
            let displayLines = [box.macroExpanded];
            if (box.macroExpanded.length > 10 && words.length >= 2) {
              const mid = Math.ceil(words.length / 2);
              displayLines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
            }
            const maxLen = Math.max(...displayLines.map((l) => l.length));
            const fontSize = Math.min(12, Math.max(8.5, Math.floor((w - 10) / (maxLen * 0.58))));
            const lineSpacing = fontSize + 3;
            const startY = cy - ((displayLines.length - 1) * lineSpacing) / 2 + 4;
            displayLines.forEach((dl, idx) => {
              svg += `<text x="${cx}" y="${startY + idx * lineSpacing}" text-anchor="middle" fill="${palette.text}" font-size="${fontSize}" font-weight="600">${esc(dl)}</text>`;
            });
          } else {
            svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${palette.text}" font-family="JetBrains Mono, monospace" font-size="13" font-weight="700">[${esc(box.macroKey)}]</text>`;
          }
        } else if (box.lines.length > 0) {
          // A diamond's usable width is about half its bounding box: shrink text to fit.
          let fontSize = 13;
          if (box.shape === 'choice') {
            const maxLen = Math.max(...box.lines.map((l) => l.length));
            fontSize = Math.max(9, Math.min(13, (w * 0.55) / (maxLen * 0.6)));
          }
          const lineSpacing = Math.round(fontSize * 1.25);
          const startY = cy - ((box.lines.length - 1) * lineSpacing) / 2 + fontSize * 0.35;
          box.lines.forEach((line, idx) => {
            svg += `<text x="${cx}" y="${startY + idx * lineSpacing}" text-anchor="middle" fill="${palette.text}" font-size="${+fontSize.toFixed(1)}" font-weight="600">${esc(line)}</text>`;
          });
        }
        svg += `</g>`;
      }

      // 2. Wires (after boxes so wires inside container boxes stay visible)
      svg += `<g stroke="${wireStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">`;
      for (const w of wires) {
        const dashAttr = w.dashed ? ` stroke-dasharray="5,4"` : '';
        svg += `<line x1="${w.x1}" y1="${w.y1}" x2="${w.x2}" y2="${w.y2}"${dashAttr} />`;
      }
      svg += `</g>`;

      // 3. Junction bullets (*)
      for (const j of junctions) {
        svg += `<circle cx="${(j.c + 0.5) * this.cellW}" cy="${(j.r + 0.5) * this.cellH}" r="4" fill="${wireStroke}" />`;
      }

      // 4. Arrowheads (<, >, ^, v), standard and inline-on-border
      for (const a of arrows) {
        const ax = (a.c + 0.5) * this.cellW;
        const ay = (a.r + 0.5) * this.cellH;
        let pts = '';
        if (a.dir === '>') {
          const tipX = a.tipX ?? (a.inline ? ax : a.touchesBox ? ax + this.cellW - 1 : ax + 4);
          pts = `${tipX},${ay} ${tipX - 9},${ay - 4.5} ${tipX - 9},${ay + 4.5}`;
        } else if (a.dir === '<') {
          const tipX = a.tipX ?? (a.inline ? ax : a.touchesBox ? ax - this.cellW + 1 : ax - 4);
          pts = `${tipX},${ay} ${tipX + 9},${ay - 4.5} ${tipX + 9},${ay + 4.5}`;
        } else if (a.dir === '^') {
          const tipY = a.tipY ?? (a.inline ? ay : a.touchesBox ? ay - this.cellH + 1 : ay - 5);
          pts = `${ax},${tipY} ${ax - 4.5},${tipY + 9.5} ${ax + 4.5},${tipY + 9.5}`;
        } else if (a.dir === 'v') {
          const tipY = a.tipY ?? (a.inline ? ay : a.touchesBox ? ay + this.cellH - 1 : ay + 5);
          pts = `${ax},${tipY} ${ax - 4.5},${tipY - 9.5} ${ax + 4.5},${tipY - 9.5}`;
        }
        svg += `<polygon points="${pts}" fill="${a.inline ? '#10b981' : wireStroke}" />`;
      }

      // 5. Free text labels
      for (const ft of freeTexts) {
        svg += `<text x="${ft.c * this.cellW}" y="${(ft.r + 0.72) * this.cellH}" fill="${freeTextFill}" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="500">${esc(ft.text)}</text>`;
      }

      // 6. Legend card
      if (showLegendCard) {
        const cardY = contentH + 16;
        const cardH = legendHeight - 16;
        const cardFill = this.lightCanvas ? '#f1f5f9' : '#1e293b';
        const cardBorder = this.lightCanvas ? '#cbd5e1' : '#334155';
        const keyW = Math.max(26, Math.max(...legendKeys.map((k) => k.length)) * 7 + 10);

        svg += `<g transform="translate(0, ${cardY})">`;
        svg += `<rect x="0" y="0" width="${contentW}" height="${cardH}" rx="8" fill="${cardFill}" stroke="${cardBorder}" stroke-width="1.5" />`;
        svg += `<text x="14" y="20" fill="${defaultTextFill}" font-size="11" font-weight="700" letter-spacing="0.04em">DIAGRAM LEGEND MACROS</text>`;
        const colWidth = Math.floor((contentW - 28) / 2);
        legendKeys.forEach((k, idx) => {
          const lx = 14 + (idx % 2) * colWidth;
          const ly = 32 + Math.floor(idx / 2) * 26;
          svg += `<rect x="${lx}" y="${ly}" width="${keyW}" height="18" rx="4" fill="#4f46e5" />`;
          svg += `<text x="${lx + keyW / 2}" y="${ly + 12.5}" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700">${esc(k)}</text>`;
          svg += `<text x="${lx + keyW + 8}" y="${ly + 13}" fill="${defaultTextFill}" font-size="12" font-weight="500">${esc(legends[k])}</text>`;
        });
        svg += `</g>`;
      }

      svg += `</g></svg>`;
      return svg;
    }

    /**
     * Converts enhanced ditaa (inline arrows sitting on box borders, e.g. +---^---+)
     * into strict legacy ditaa that the Java renderer accepts:
     *  - the border cell is healed back to '+' / '|';
     *  - the arrowhead moves onto the adjacent straight wire cell; only when that cell
     *    is a corner is a spacer row inserted (copying vertical lines so nothing tears).
     */
    static exportStrictLegacyDitaa(rawText) {
      const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
      const rows = lines.map((l) => l.split(''));
      const skip = lines.map((l) => DitaaParser.isLegendOrCommentLine(l));
      const at = (r, c) => (r >= 0 && r < rows.length && !skip[r] && c >= 0 && c < rows[r].length ? rows[r][c] : ' ');
      const H = (ch) => ch === '-' || ch === '=' || ch === '+';
      const V = (ch) => ch === '|' || ch === ':' || ch === '+';

      let healedArrowsCount = 0;
      let droppedArrowsCount = 0;
      const spacers = new Map(); // insert-after row index -> [{c, ch}]
      const addSpacer = (afterRow, c, ch) => {
        if (!spacers.has(afterRow)) spacers.set(afterRow, []);
        spacers.get(afterRow).push({ c, ch });
      };

      for (let r = 0; r < rows.length; r++) {
        if (skip[r]) continue;
        for (let c = 0; c < rows[r].length; c++) {
          const ch = rows[r][c];

          // ^ / v on a horizontal border (incl. corners), wire above or below
          if ((ch === '^' || ch === 'v') && (H(at(r, c - 1)) || H(at(r, c + 1))) && (V(at(r - 1, c)) || V(at(r + 1, c)))) {
            const below = at(r + 1, c), above = at(r - 1, c);
            const side = ch === '^'
              ? (V(below) ? 1 : -1)
              : (V(above) ? -1 : 1);
            rows[r][c] = '+';
            const nr = r + side;
            const nch = at(nr, c);
            if (nch === '|' || nch === ':') {
              rows[nr][c] = ch;
            } else {
              addSpacer(side === 1 ? r : r - 1, c, ch);
            }
            healedArrowsCount++;
            continue;
          }

          // < / > on a vertical border, wire to the left or right
          if ((ch === '<' || ch === '>') && V(at(r - 1, c)) && V(at(r + 1, c)) && (H(at(r, c - 1)) || H(at(r, c + 1)))) {
            const left = at(r, c - 1), right = at(r, c + 1);
            const straight = (x) => x === '-' || x === '=';
            const side = ch === '>'
              ? (straight(left) ? -1 : straight(right) ? 1 : 0)
              : (straight(right) ? 1 : straight(left) ? -1 : 0);
            if (side === 0) {
              rows[r][c] = '+';
              droppedArrowsCount++;
            } else {
              rows[r][c] = '|';
              rows[r][c + side] = ch;
              healedArrowsCount++;
            }
          }
        }
      }

      const out = rows.map((r) => r.join(''));
      // Insert spacer rows bottom-up so earlier indices stay valid.
      const afterRows = [...spacers.keys()].sort((a, b) => b - a);
      for (const k of afterRows) {
        const width = Math.max(out[k] ? out[k].length : 0, out[k + 1] ? out[k + 1].length : 0);
        const sp = Array(width).fill(' ');
        for (let c = 0; c < width; c++) {
          const a = at(k, c), b = at(k + 1, c);
          if (vLineCh(a) && vLineCh(b)) sp[c] = a === ':' || b === ':' ? ':' : '|';
        }
        for (const { c, ch } of spacers.get(k)) sp[c] = ch;
        out.splice(k + 1, 0, sp.join('').replace(/\s+$/, ''));
      }

      return {
        sanitizedText: out.join('\n'),
        healedArrowsCount,
        insertedRowsCount: afterRows.length,
        droppedArrowsCount
      };
    }

    escapeXml(unsafe) {
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }
  }

  /*************************************************************************
   * 2D SPATIAL GRID MANIPULATION ENGINE (STAMP, SHIFT, RESIZE & STRETCH)
   *
   * Every operation returns { text, cursorR, cursorC } on success,
   * { error } when the operation is refused, or null when there is nothing to do.
   *************************************************************************/
  class Grid2DEditor {
    /**
     * Splits text into the diagram grid and the trailing legend block. Only the
     * trailing run of '#'/legend lines is split off, so row N of the grid is line N
     * of the text, matching DitaaParser's row numbering.
     */
    static toGridState(rawText, minRows = 1, minCols = 1) {
      const allLines = rawText.replace(/\r\n?/g, '\n').split('\n');
      let k = allLines.length;
      while (k > 0 && (allLines[k - 1].trim() === '' || DitaaParser.isLegendOrCommentLine(allLines[k - 1]))) k--;
      const diagramLines = allLines.slice(0, k);
      const legendLines = allLines.slice(k);
      while (legendLines.length > 0 && legendLines[0].trim() === '') legendLines.shift();
      while (legendLines.length > 0 && legendLines[legendLines.length - 1].trim() === '') legendLines.pop();

      const rows = Math.max(diagramLines.length, minRows, 1);
      const cols = Math.max(diagramLines.reduce((m, l) => Math.max(m, l.length), 0), minCols, 1);

      const grid = [];
      for (let r = 0; r < rows; r++) {
        const line = diagramLines[r] || '';
        const rowArr = [];
        for (let c = 0; c < cols; c++) rowArr.push(c < line.length ? line[c] : ' ');
        grid.push(rowArr);
      }
      return { grid, rows, cols, legendLines };
    }

    static ensureSize(state, reqRows, reqCols) {
      if (reqCols > state.cols) state.cols = reqCols;
      while (state.rows < reqRows) {
        state.grid.push([]);
        state.rows++;
      }
      for (const row of state.grid) while (row.length < state.cols) row.push(' ');
    }

    static fromGridState(state) {
      const outDiagram = state.grid.map((r) => r.join('').replace(/\s+$/, ''));
      while (outDiagram.length > 0 && outDiagram[outDiagram.length - 1] === '') outDiagram.pop();
      if (state.legendLines.length > 0) {
        return outDiagram.length > 0
          ? outDiagram.join('\n') + '\n\n' + state.legendLines.join('\n')
          : state.legendLines.join('\n');
      }
      return outDiagram.join('\n');
    }

    static getRowColFromIndex(text, index) {
      const lines = text.substring(0, Math.max(0, index)).split('\n');
      return { r: lines.length - 1, c: lines[lines.length - 1].length };
    }

    static getIndexFromRowCol(text, targetR, targetC) {
      const lines = text.split('\n');
      let idx = 0;
      for (let r = 0; r < lines.length; r++) {
        if (r === targetR) return idx + Math.min(targetC, lines[r].length);
        idx += lines[r].length + 1;
      }
      return text.length;
    }

    /** Next free legend macro key M<n> (scans the whole text, so reloads never collide). */
    static nextMacroKey(rawText) {
      let max = 0;
      for (const m of rawText.matchAll(/\[M(\d+)\]/g)) max = Math.max(max, parseInt(m[1], 10));
      return `M${max + 1}`;
    }

    /** A compact legend-macro box whose walls stay aligned for any key length. */
    static macroBoxTemplate(key, colorTag = 'cYEL') {
      const label = `[${key}]`;
      const inner = Math.max(5, label.length + 2, colorTag.length + 1);
      const left = Math.floor((inner - label.length) / 2);
      const wall = '+' + '-'.repeat(inner) + '+';
      return [
        wall,
        '|' + (' '.repeat(left) + label).padEnd(inner) + '|',
        '|' + colorTag.padEnd(inner) + '|',
        wall
      ];
    }

    /**
     * Smart cursor-aware box stamp:
     * - cursor on / just after a '>' arrow tip → box placed so the arrow hits its left wall;
     * - cursor on / just below a 'v' arrow tip → box centred under the arrow.
     */
    static smartStampBox(rawText, cursorR, cursorC, boxTemplateLines, legendEntry = null) {
      const boxH = boxTemplateLines.length;
      const boxW = Math.max(...boxTemplateLines.map((l) => l.length));
      const state = this.toGridState(rawText, cursorR + 1, cursorC + 1);
      const chAt = (r, c) => (r >= 0 && r < state.rows && c >= 0 && c < state.grid[r].length ? state.grid[r][c] : ' ');

      let stampR = cursorR;
      let stampC = cursorC;
      let attached = false;

      for (let offset = 0; offset <= 2; offset++) {
        const checkC = cursorC - offset;
        if (chAt(cursorR, checkC) === '>') {
          stampC = checkC + 1;
          stampR = cursorR - Math.floor(boxH / 2);
          if (stampR < 0) {
            // Not enough room above the arrow to centre the box on it: add blank rows on top
            for (let i = 0; i < -stampR; i++) state.grid.unshift(Array(state.cols).fill(' '));
            state.rows += -stampR;
            stampR = 0;
          }
          attached = true;
          break;
        }
      }
      if (!attached) {
        for (let rOff = 0; rOff <= 1; rOff++) {
          const checkR = cursorR - rOff;
          if (chAt(checkR, cursorC) === 'v') {
            stampR = checkR + 1;
            stampC = Math.max(0, cursorC - Math.floor(boxW / 2));
            break;
          }
        }
      }

      this.ensureSize(state, stampR + boxH, stampC + boxW);
      for (let br = 0; br < boxH; br++) {
        const line = boxTemplateLines[br];
        for (let bc = 0; bc < line.length; bc++) state.grid[stampR + br][stampC + bc] = line[bc];
      }

      if (legendEntry) {
        const exists = state.legendLines.some((l) => {
          const lg = DitaaParser.matchLegendLine(l);
          return lg && lg.key === legendEntry.key;
        });
        if (!exists) state.legendLines.push(`# [${legendEntry.key}] = ${legendEntry.val}`);
      }

      // Cursor on the right border middle of the new box for instant chaining
      return {
        text: this.fromGridState(state),
        cursorR: stampR + Math.floor(boxH / 2),
        cursorC: stampC + boxW - 1
      };
    }

    /** Attaches an arrow to the active box (right wall / bottom wall) or draws it at the cursor. */
    static smartStampArrow(rawText, cursorR, cursorC, activeBox, type = 'solid-right') {
      const arrowLen = 7;
      const state = this.toGridState(rawText);

      if (type === 'solid-right' || type === 'dashed-right') {
        const wireChar = type === 'dashed-right' ? '=' : '-';
        if (activeBox) {
          const startR = Math.floor((activeBox.r1 + activeBox.r2) / 2);
          const startC = activeBox.c2;
          this.ensureSize(state, startR + 1, startC + arrowLen + 1);
          state.grid[startR][startC] = '+';
          for (let i = 1; i < arrowLen; i++) state.grid[startR][startC + i] = wireChar;
          state.grid[startR][startC + arrowLen] = '>';
          return { text: this.fromGridState(state), cursorR: startR, cursorC: startC + arrowLen + 1 };
        }
        this.ensureSize(state, cursorR + 1, cursorC + arrowLen);
        for (let i = 0; i < arrowLen - 1; i++) state.grid[cursorR][cursorC + i] = wireChar;
        state.grid[cursorR][cursorC + arrowLen - 1] = '>';
        return { text: this.fromGridState(state), cursorR, cursorC: cursorC + arrowLen };
      }

      if (type === 'solid-down') {
        if (activeBox) {
          const startR = activeBox.r2;
          const startC = Math.floor((activeBox.c1 + activeBox.c2) / 2);
          this.ensureSize(state, startR + 4, startC + 1);
          state.grid[startR][startC] = '+';
          state.grid[startR + 1][startC] = '|';
          state.grid[startR + 2][startC] = '|';
          state.grid[startR + 3][startC] = 'v';
          return { text: this.fromGridState(state), cursorR: startR + 4, cursorC: startC };
        }
        this.ensureSize(state, cursorR + 3, cursorC + 1);
        state.grid[cursorR][cursorC] = '|';
        state.grid[cursorR + 1][cursorC] = '|';
        state.grid[cursorR + 2][cursorC] = 'v';
        return { text: this.fromGridState(state), cursorR: cursorR + 3, cursorC };
      }
      return null;
    }

    /** Puts an inline '^' in the middle of the box's bottom wall. */
    static addInlineUpArrow(rawText, box) {
      const state = this.toGridState(rawText);
      let midC = Math.floor((box.c1 + box.c2) / 2);
      // Prefer the column where a wire already leaves the bottom wall
      for (let c = box.c1 + 1; c < box.c2; c++) {
        const below = state.grid[box.r2 + 1] ? state.grid[box.r2 + 1][c] : ' ';
        if (below === '|' || below === ':') { midC = c; break; }
      }
      state.grid[box.r2][midC] = '^';
      return { text: this.fromGridState(state), cursorR: box.r2, cursorC: midC };
    }

    /**
     * Toggles a shape/color tag on a box. Adding a color replaces any other color;
     * adding a shape replaces any other shape. Only cells the box itself owns are read or
     * written: boxes nested inside a container keep their own tags. Tags are written into
     * the first owned run of cells (bottom-up) with room; nothing is ever overflowed.
     */
    static toggleTag(rawText, box, tag) {
      const state = this.toGridState(rawText);
      const same = (a, b) => a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
      const children = new DitaaParser().parse(rawText).boxes.filter(
        (b) => !same(b, box) && b.r1 >= box.r1 && b.r2 <= box.r2 && b.c1 >= box.c1 && b.c2 <= box.c2
      );
      const owned = (r, c) => !children.some((b) => r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2);

      // Maximal runs of owned interior cells, row by row
      const runs = [];
      for (let r = box.r1 + 1; r < box.r2; r++) {
        let c = box.c1 + 1;
        while (c < box.c2) {
          if (!owned(r, c)) { c++; continue; }
          const c0 = c;
          while (c < box.c2 && owned(r, c)) c++;
          runs.push({ r, c0, len: c - c0 });
        }
      }
      const read = (run) => state.grid[run.r].slice(run.c0, run.c0 + run.len).join('');
      const write = (run, str) => {
        for (let i = 0; i < run.len; i++) state.grid[run.r][run.c0 + i] = str[i] || ' ';
      };
      const blank = (str, re) => str.replace(re, (m) => ' '.repeat(m.length));
      const esc = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const tagSrc = esc(tag) + (/^c/.test(tag) ? '\\b' : '');
      if (runs.some((run) => new RegExp(tagSrc).test(read(run)))) {
        runs.forEach((run) => write(run, blank(read(run), new RegExp(tagSrc, 'g'))));
        return { text: this.fromGridState(state), cursorR: box.r1 + 1, cursorC: box.c1 + 1, msg: `Removed ${tag}` };
      }

      const isColor = /^c/.test(tag);
      const conflictRe = isColor
        ? /\bc(?:BLU|GRE|YEL|RED|PNK|BLK)\b|\bc#[0-9a-fA-F]{6}\b|\bc[0-9A-F]{3}\b/g
        : tag === '{*}' ? null : /\{(?:s|d|io|mo|o|c)\}/g;
      // Replacing a tag keeps its position: try the run that held the old tag first.
      let preferred = -1;
      let preferredAt = 0;
      if (conflictRe) {
        runs.forEach((run, i) => {
          const before = read(run);
          const m = before.match(new RegExp(conflictRe.source));
          if (m && preferred === -1) { preferred = i; preferredAt = m.index; }
          write(run, blank(before, conflictRe));
        });
      }
      if (preferred !== -1) {
        const run = runs[preferred];
        const str = read(run);
        if (preferredAt + tag.length <= run.len && str.slice(preferredAt, preferredAt + tag.length).trim() === '') {
          write(run, str.slice(0, preferredAt) + tag + str.slice(preferredAt + tag.length));
          return { text: this.fromGridState(state), cursorR: run.r, cursorC: run.c0 + preferredAt, msg: `Applied ${tag}` };
        }
      }

      const order = runs.map((_, i) => runs.length - 1 - i);
      if (preferred !== -1) order.unshift(preferred);
      for (const i of order) {
        const run = runs[i];
        const body = read(run).replace(/\s+$/, '');
        const candidates = body.trim() === '' ? ['  ' + tag, ' ' + tag, tag] : [body + ' ' + tag];
        const fit = candidates.find((str) => str.length <= run.len);
        if (fit) {
          write(run, fit.padEnd(run.len));
          return { text: this.fromGridState(state), cursorR: run.r, cursorC: run.c0, msg: `Applied ${tag}` };
        }
      }
      return { error: `Box too narrow for ${tag} — widen it first (Alt+Shift+→)` };
    }

    /**
     * Shifts a box by (dr, dc) and stretches/compresses wires attached to its walls.
     */
    static shiftBoxWithElasticWires(rawText, box, dr, dc) {
      if (!box) return null;
      if (box.r1 + dr < 0 || box.c1 + dc < 0) return { error: 'Box is already at the edge' };

      const state = this.toGridState(rawText, box.r2 + Math.max(0, dr) + 3, box.c2 + Math.max(0, dc) + 3);
      const { grid } = state;
      const chAt = (r, c) => (r >= 0 && r < state.rows && c >= 0 && c < state.cols ? grid[r][c] : ' ');

      const isHorizWire = (ch) => ch === '-' || ch === '=' || ch === '>' || ch === '<' || ch === '*';
      const isVertWire = (ch) => ch === '|' || ch === ':' || ch === '^' || ch === 'v' || ch === '*';

      const leftAttachments = [];
      const rightAttachments = [];
      for (let r = box.r1; r <= box.r2; r++) {
        const lCh = chAt(r, box.c1 - 1);
        if (isHorizWire(lCh)) leftAttachments.push({ r, arrowOrWire: lCh, filler: lCh === '=' || chAt(r, box.c1 - 2) === '=' ? '=' : '-' });
        const rCh = chAt(r, box.c2 + 1);
        if (isHorizWire(rCh)) rightAttachments.push({ r, arrowOrWire: rCh, filler: rCh === '=' || chAt(r, box.c2 + 2) === '=' ? '=' : '-' });
      }
      const topAttachments = [];
      const botAttachments = [];
      for (let c = box.c1; c <= box.c2; c++) {
        const tCh = chAt(box.r1 - 1, c);
        if (isVertWire(tCh)) topAttachments.push({ c, arrowOrWire: tCh, filler: tCh === ':' || chAt(box.r1 - 2, c) === ':' ? ':' : '|' });
        const bCh = chAt(box.r2 + 1, c);
        if (isVertWire(bCh)) botAttachments.push({ c, arrowOrWire: bCh, filler: bCh === ':' || chAt(box.r2 + 2, c) === ':' ? ':' : '|' });
      }

      const boxH = box.r2 - box.r1 + 1;
      const boxW = box.c2 - box.c1 + 1;
      const snapshot = [];
      for (let r = 0; r < boxH; r++) {
        const rowSnap = [];
        for (let c = 0; c < boxW; c++) {
          rowSnap.push(grid[box.r1 + r][box.c1 + c]);
          grid[box.r1 + r][box.c1 + c] = ' ';
        }
        snapshot.push(rowSnap);
      }

      const nr1 = box.r1 + dr, nc1 = box.c1 + dc, nr2 = box.r2 + dr, nc2 = box.c2 + dc;
      for (let r = 0; r < boxH; r++) {
        for (let c = 0; c < boxW; c++) grid[nr1 + r][nc1 + c] = snapshot[r][c];
      }

      if (dc === 1) {
        for (const att of leftAttachments) {
          if (att.arrowOrWire === '>') {
            grid[att.r][box.c1 - 1] = att.filler;
            grid[att.r][box.c1] = '>';
          } else {
            grid[att.r][box.c1] = att.filler;
          }
        }
        for (const att of rightAttachments) {
          if (att.arrowOrWire === '<' && chAt(att.r, nc2 + 2) !== ' ') grid[att.r][nc2 + 1] = '<';
        }
      } else if (dc === -1) {
        for (const att of rightAttachments) {
          if (att.arrowOrWire === '<') {
            grid[att.r][box.c2 + 1] = att.filler;
            grid[att.r][box.c2] = '<';
          } else {
            grid[att.r][box.c2] = att.filler;
          }
        }
        for (const att of leftAttachments) {
          if (att.arrowOrWire === '>' && nc1 - 1 >= 0) grid[att.r][nc1 - 1] = '>';
        }
      } else if (dr === 1) {
        for (const att of topAttachments) {
          if (att.arrowOrWire === 'v') {
            grid[box.r1 - 1][att.c] = att.filler;
            grid[box.r1][att.c] = 'v';
          } else {
            grid[box.r1][att.c] = att.filler;
          }
        }
        for (const att of botAttachments) {
          if (att.arrowOrWire === '^' && chAt(nr2 + 2, att.c) !== ' ') grid[nr2 + 1][att.c] = '^';
        }
      } else if (dr === -1) {
        for (const att of botAttachments) {
          if (att.arrowOrWire === '^') {
            grid[box.r2 + 1][att.c] = att.filler;
            grid[box.r2][att.c] = '^';
          } else {
            grid[box.r2][att.c] = att.filler;
          }
        }
        for (const att of topAttachments) {
          if (att.arrowOrWire === 'v' && nr1 - 1 >= 0) grid[nr1 - 1][att.c] = 'v';
        }
      }

      return {
        text: this.fromGridState(state),
        cursorR: Math.floor((nr1 + nr2) / 2),
        cursorC: Math.floor((nc1 + nc2) / 2)
      };
    }

    /**
     * Resizes a box horizontally (dw = ±2) or vertically (dh = ±1). Shrinking is refused
     * when it would delete label text or a wire port on the wall.
     */
    /**
     * A conditional-diamond box: odd width and odd height so the '+' ports at the centre of
     * each wall sit exactly on the diamond's vertices. The {c} tag shares the middle row with
     * the label, so the blank rows above and below can be removed to shrink it to 3 rows.
     *
     *   +-------+-------+
     *   |               |
     *   +  Valid? {c}   +
     *   |               |
     *   +-------+-------+
     */
    static diamondTemplate(label = 'Decision?') {
      const text = `${label} {c}`;
      let inner = Math.max(15, text.length + 4);
      if (inner % 2 === 0) inner++;
      const half = (inner - 1) / 2;
      const wall = '+' + '-'.repeat(half) + '+' + '-'.repeat(half) + '+';
      const left = Math.floor((inner - text.length) / 2);
      const blank = '|' + ' '.repeat(inner) + '|';
      return [wall, blank, '+' + (' '.repeat(left) + text).padEnd(inner) + '+', blank, wall];
    }

    /**
     * Inserts a column before index `at` in EVERY row (like growing a box taller inserts a
     * full-width row), so boxes beside the resized one move as a whole instead of tearing.
     * Horizontal lines and box walls crossing the column are continued, and an arrowhead
     * touching something keeps touching it. Returns an error, changing nothing, if the
     * column would split a word or tag in any row. Rows r1..r2 of `box` are its own.
     */
    static insertColumnEverywhere(state, at, box) {
      const splitAt = this.findTextBoundary(state, at, box);
      if (splitAt) return { error: `Cannot widen: it would split "${splitAt.word}" on line ${splitAt.r + 1}` };
      for (let r = 0; r < state.rows; r++) {
        const row = state.grid[r];
        while (row.length < at) row.push(' ');
        const L = row[at - 1] || ' ', R = row[at] || ' ';
        const fill = L === '=' || R === '=' ? '=' : '-';
        let ch = ' ';
        if (r >= box.r1 && r <= box.r2) {
          if (r === box.r1 || r === box.r2) ch = fill;
        } else if (L === '>' && R !== ' ' && R !== '-' && R !== '=') {
          ch = '>'; // keep "-->|" / "-->+" touching: move the arrowhead, extend the wire behind it
          row[at - 1] = row[at - 2] === '=' ? '=' : '-';
        } else if (R === '<' && L !== ' ' && L !== '-' && L !== '=') {
          ch = '<';
          row[at] = (row[at + 1] || ' ') === '=' ? '=' : '-';
        } else if (lineCh(L) && lineCh(R)) {
          ch = fill;
        }
        row.splice(at, 0, ch);
      }
      state.cols++;
      for (const row of state.grid) while (row.length < state.cols) row.push(' ');
      return null;
    }

    /**
     * Removes column `at` from EVERY row. Returns an error, changing nothing, if that would
     * delete text, a corner or a vertical line, or join two words together.
     */
    static removeColumnEverywhere(state, at, box) {
      for (let r = 0; r < state.rows; r++) {
        const row = state.grid[r];
        const ch = row[at] || ' ';
        const L = row[at - 1] || ' ', R = row[at + 1] || ' ';
        let ok;
        if (r >= box.r1 && r <= box.r2) {
          ok = r === box.r1 || r === box.r2 ? ch === '-' || ch === '=' : ch === ' ';
        } else if (ch === '-' || ch === '=') {
          ok = !isAlnum(L) && !isAlnum(R);
        } else {
          ok = ch === ' ' && !(isWordPair(L, R));
        }
        if (!ok) {
          return { error: `Cannot narrow: ${ch === ' ' ? 'it would join text' : `"${ch}" is in the way`} on line ${r + 1}` };
        }
      }
      for (const row of state.grid) row.splice(at, 1);
      state.cols--;
      return null;
    }

    /** First row where a column inserted before `at` would land inside a word or tag. */
    static findTextBoundary(state, at, box) {
      for (let r = 0; r < state.rows; r++) {
        if (r >= box.r1 && r <= box.r2) continue;
        const row = state.grid[r];
        if (isWordPair(row[at - 1] || ' ', row[at] || ' ')) {
          let a = at - 1, b = at;
          while (a > 0 && row[a - 1] !== ' ') a--;
          while (b < row.length && row[b] !== ' ') b++;
          return { r, word: row.slice(a, b).join('') };
        }
      }
      return null;
    }

    /** Inserts a full-width row before index `at`, continuing vertical lines that cross it. */
    static insertRowEverywhere(state, at, box) {
      const row = Array(state.cols).fill(' ');
      for (let c = 0; c < state.cols; c++) {
        const A = state.grid[at - 1][c], B = state.grid[at][c];
        if (c >= box.c1 && c <= box.c2) {
          if (c === box.c1 || c === box.c2) row[c] = A === ':' || B === ':' ? ':' : '|';
        } else if (vLineCh(A) && vLineCh(B)) {
          row[c] = A === ':' || B === ':' ? ':' : '|';
        }
      }
      state.grid.splice(at, 0, row);
      state.rows++;
    }

    /** True if row `at` can be deleted without losing text, corners or box walls. */
    static canRemoveRow(state, at, box) {
      for (let c = 0; c < state.cols; c++) {
        const ch = state.grid[at][c];
        if (c >= box.c1 && c <= box.c2) {
          const wallCol = c === box.c1 || c === box.c2;
          if (wallCol ? !(ch === '|' || ch === ':') : ch !== ' ') return false;
        } else if (!(ch === ' ' || ch === '|' || ch === ':')) {
          return false;
        }
      }
      return true;
    }

    /**
     * Resizes a diamond ({c}) box by 2 columns / 2 rows at a time, adding or removing one on
     * each side of the centre, across the whole diagram. The centre ports stay on the
     * diamond's vertices and every wire attached to them keeps its connection.
     */
    static resizeDiamond(rawText, box, dw, dh) {
      const curW = box.c2 - box.c1;
      const curH = box.r2 - box.r1;
      if (curW + dw < 4 || curH + dh < 2) return { error: 'Diamond is already at its minimum size' };
      const state = this.toGridState(rawText, box.r2 + 2, box.c2 + 2);

      if (dw > 0) {
        const err = this.insertColumnEverywhere(state, box.c1 + 1, box) ||
          this.insertColumnEverywhere(state, box.c2 + 1, box);
        if (err) return err;
      } else if (dw < 0) {
        const err = this.removeColumnEverywhere(state, box.c2 - 1, box) ||
          this.removeColumnEverywhere(state, box.c1 + 1, box);
        if (err) return err;
      }

      if (dh > 0) {
        this.insertRowEverywhere(state, box.r1 + 1, box);
        this.insertRowEverywhere(state, box.r2 + 1, box);
      } else if (dh < 0) {
        if (!this.canRemoveRow(state, box.r1 + 1, box) || !this.canRemoveRow(state, box.r2 - 1, box)) {
          return { error: 'Cannot shorten: text or wires are in the way' };
        }
        state.grid.splice(box.r2 - 1, 1);
        state.grid.splice(box.r1 + 1, 1);
        state.rows -= 2;
      }

      return {
        text: this.fromGridState(state),
        cursorR: Math.floor((box.r1 + box.r2 + dh) / 2),
        cursorC: Math.floor((box.c1 + box.c2 + dw) / 2)
      };
    }

    static resizeBox(rawText, box, dw, dh) {
      if (!box) return null;
      if (box.shape === 'choice') return this.resizeDiamond(rawText, box, Math.sign(dw) * 2, Math.sign(dh) * 2);
      const curW = box.c2 - box.c1;
      const curH = box.r2 - box.r1;
      if (curW + dw < 3 || curH + dh < 2) return { error: 'Box is already at its minimum size' };

      const state = this.toGridState(rawText, box.r2 + Math.max(0, dh) + 2, box.c2 + Math.max(0, dw) + 2);
      const { grid } = state;

      // Widen/narrow by inserting/removing whole columns just inside the right wall, so
      // neighbouring boxes of any height move as a unit and nothing is torn.
      for (let i = 0; i < Math.abs(dw); i++) {
        const err = dw > 0
          ? this.insertColumnEverywhere(state, box.c2, box)
          : this.removeColumnEverywhere(state, box.c2 - 1 - i, box);
        if (err) return err;
      }
      if (dh < 0) {
        const targetR = box.r2 - 1;
        for (let c = box.c1 + 1; c < box.c2; c++) {
          if (grid[targetR][c] !== ' ') return { error: 'Cannot shorten: the bottom row has text' };
        }
      }

      if (dh > 0) {
        // Insert a new interior row just above the bottom wall. Outside the box, continue any
        // vertical line that crosses the boundary between rows r2-1 and r2, so neighbouring
        // boxes and wires are stretched instead of torn.
        const newRow = Array(state.cols).fill(' ');
        newRow[box.c1] = grid[box.r1 + 1][box.c1] === ':' ? ':' : '|';
        newRow[box.c2] = grid[box.r1 + 1][box.c2] === ':' ? ':' : '|';
        for (let c = 0; c < state.cols; c++) {
          if (c >= box.c1 && c <= box.c2) continue;
          const a = grid[box.r2 - 1][c], b = grid[box.r2][c];
          if (vLineCh(a) && vLineCh(b)) newRow[c] = a === ':' || b === ':' ? ':' : '|';
        }
        grid.splice(box.r2, 0, newRow);
        state.rows++;
      } else if (dh < 0) {
        const targetR = box.r2 - 1;
        for (let c = box.c1; c <= box.c2; c++) {
          grid[targetR][c] = grid[box.r2][c];
          grid[box.r2][c] = ' ';
        }
        // Stretch vertical wires attached below the old bottom wall up into it
        for (let c = box.c1; c <= box.c2; c++) {
          if (box.r2 + 1 < state.rows) {
            const below = grid[box.r2 + 1][c];
            if (below === '|' || below === ':' || below === '^' || below === 'v') {
              grid[box.r2][c] = below === '^' ? '^' : below === ':' ? ':' : '|';
              if (below === '^') grid[box.r2 + 1][c] = '|';
            }
          }
        }
      }

      const finalR2 = box.r2 + dh;
      const finalC2 = box.c2 + dw;
      return {
        text: this.fromGridState(state),
        cursorR: Math.floor((box.r1 + finalR2) / 2),
        cursorC: Math.floor((box.c1 + finalC2) / 2)
      };
    }
  }

  const api = { COLOR_MAP, DitaaParser, Grid2DEditor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DitaaEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
