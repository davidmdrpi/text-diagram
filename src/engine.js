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
  // Two adjacent non-blank characters that are not a line and not next to a wall/corner: text.
  const isWallCh = (ch) => ch === '|' || ch === ':' || ch === '+';
  const isWordPair = (L, R) =>
    L !== ' ' && R !== ' ' && !(lineCh(L) && lineCh(R)) && !isWallCh(L) && !isWallCh(R);
  // A vertical wire/wall cell at grid[c] (not a letter v or ^ inside a word)
  const wireV = (row, c) => {
    const ch = row[c] || ' ';
    if ('|:+*'.includes(ch) && ch !== ' ') return true;
    return (ch === '^' || ch === 'v') && !isAlnum(row[c - 1] || ' ') && !isAlnum(row[c + 1] || ' ');
  };
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

      return { grid, numRows, numCols, boxes, wires, arrows, junctions, freeTexts, legends, cellRole };
    }

    /**
     * What each wire connects: one entry per connected run of wire cells that touches at
     * least one box, listing the indices of the boxes it touches. Horizontal wire cells
     * join left/right, vertical ones up/down, corners and junctions both ways.
     */
    connections(ast) {
      const { grid, numRows, numCols, boxes, cellRole } = ast;
      const H = (r, c) => {
        const role = cellRole[r][c];
        return role === 'wire-h' || role === 'wire-corner' || role === 'wire-junction' ||
          (role === 'wire-arrow' && (grid[r][c] === '<' || grid[r][c] === '>'));
      };
      const V = (r, c) => {
        const role = cellRole[r][c];
        return role === 'wire-v' || role === 'wire-corner' || role === 'wire-junction' ||
          (role === 'wire-arrow' && (grid[r][c] === '^' || grid[r][c] === 'v'));
      };
      const owners = new Map(); // border cell -> box indices
      boxes.forEach((b, i) => {
        for (let r = b.r1; r <= b.r2; r++) {
          for (let c = b.c1; c <= b.c2; c++) {
            if (r !== b.r1 && r !== b.r2 && c !== b.c1 && c !== b.c2) continue;
            const k = r * numCols + c;
            if (!owners.has(k)) owners.set(k, []);
            owners.get(k).push(i);
          }
        }
      });
      const inGrid = (r, c) => r >= 0 && r < numRows && c >= 0 && c < numCols;
      const seen = new Set();
      const out = [];
      for (let r0 = 0; r0 < numRows; r0++) {
        for (let c0 = 0; c0 < numCols; c0++) {
          if (seen.has(r0 * numCols + c0) || !(H(r0, c0) || V(r0, c0))) continue;
          const touched = new Set();
          const cellsOf = [];
          const stack = [[r0, c0]];
          seen.add(r0 * numCols + c0);
          while (stack.length) {
            const [r, c] = stack.pop();
            cellsOf.push([r, c]);
            const steps = [];
            if (H(r, c)) steps.push([0, -1], [0, 1]);
            if (V(r, c)) steps.push([-1, 0], [1, 0]);
            for (const [dr, dc] of steps) {
              const nr = r + dr, nc = c + dc;
              if (!inGrid(nr, nc)) continue;
              const k = nr * numCols + nc;
              if (cellRole[nr][nc] === 'box-border') {
                (owners.get(k) || []).forEach((i) => touched.add(i));
              } else if (!seen.has(k) && (dr === 0 ? H(nr, nc) : V(nr, nc))) {
                seen.add(k);
                stack.push([nr, nc]);
              }
            }
          }
          if (touched.size) out.push([...touched]);
          if (this._collectWires) this._collectWires.push({ boxes: [...touched], cells: [...cellsOf] });
        }
      }
      return out;
    }

    /** Every connected wire run: the boxes it touches and its cells ([r, c] pairs). */
    wireRuns(ast) {
      this._collectWires = [];
      this.connections(ast);
      const runs = this._collectWires;
      this._collectWires = null;
      return runs;
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
      // A move is a plain text operation: the user is always right (Undo is there)
      return this.shiftBoxUnchecked(rawText, box, dr, dc);
    }

    static shiftBoxUnchecked(rawText, box, dr, dc) {
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
     * Inserts a column before index `at` in rows band.lo..band.hi (every row when no band),
     * like inserting a character on each of those lines: what is to the right moves over,
     * other lines are untouched. Horizontal lines and box walls crossing the column are
     * continued, and an arrowhead touching something keeps touching it. A row where the
     * column would land inside a word or tag gets its blank cell after that word instead.
     * Always returns null (kept for `a || b` error chaining by callers).
     */
    static insertColumnEverywhere(state, at, band = null) {
      const lo = band ? band.lo : 0, hi = band ? band.hi : state.rows - 1;
      for (let r = lo; r <= hi; r++) {
        const row = state.grid[r];
        while (row.length < at) row.push(' ');
        let pos = at;
        while (pos < row.length && isWordPair(row[pos - 1] || ' ', row[pos])) pos++;
        const L = row[pos - 1] || ' ', R = row[pos] || ' ';
        const fill = L === '=' || R === '=' ? '=' : '-';
        let ch = ' ';
        if (pos === at && L === '>' && R !== ' ' && R !== '-' && R !== '=') {
          ch = '>'; // keep "-->|" / "-->+" touching: move the arrowhead, extend the wire behind it
          row[pos - 1] = row[pos - 2] === '=' ? '=' : '-';
        } else if (pos === at && R === '<' && L !== ' ' && L !== '-' && L !== '=') {
          ch = '<';
          row[pos] = (row[pos + 1] || ' ') === '=' ? '=' : '-';
        } else if (lineCh(L) && lineCh(R)) {
          ch = fill;
        }
        row.splice(pos, 0, ch);
      }
      this.normalizeWidth(state);
      return null;
    }

    static normalizeWidth(state) {
      state.cols = Math.max(1, ...state.grid.map((row) => row.length));
      for (const row of state.grid) while (row.length < state.cols) row.push(' ');
    }

    /**
     * Removes column `at` from rows band.lo..band.hi (every row when no band). Returns an
     * error, changing nothing, if that would delete text, a corner or a vertical line, or
     * join two words together.
     */
    static removeColumnEverywhere(state, at, box, band = null) {
      const lo = band ? band.lo : 0, hi = band ? band.hi : state.rows - 1;
      for (let r = lo; r <= hi; r++) {
        const row = state.grid[r];
        const ch = row[at] || ' ';
        const L = row[at - 1] || ' ', R = row[at + 1] || ' ';
        let ok;
        if (box && r >= box.r1 && r <= box.r2 && at > box.c1 && at < box.c2) {
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
      for (let r = lo; r <= hi; r++) state.grid[r].splice(at, 1);
      this.normalizeWidth(state);
      return null;
    }

    /**
     * Inserts a full-width row before index `at`, continuing vertical lines (box walls,
     * wires, rounded corners) that cross it, including the walls of boxes nested in a
     * container. Letters that merely look like lines (v . ') inside words are not continued.
     */
    static insertRowEverywhere(state, at) {
      const row = Array(state.cols).fill(' ');
      const above = state.grid[at - 1] || [];
      const below = state.grid[at] || [];
      const cont = (line, c) => {
        const ch = line[c] || ' ';
        if ('|:+*/\\'.includes(ch)) return true;
        return (ch === '^' || ch === 'v' || ch === '.' || ch === "'") &&
          !isAlnum(line[c - 1] || ' ') && !isAlnum(line[c + 1] || ' ');
      };
      for (let c = 0; c < state.cols; c++) {
        if (cont(above, c) && cont(below, c)) row[c] = above[c] === ':' || below[c] === ':' ? ':' : '|';
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
     * Inserts full-height columns before each original index in `xs`. Any diamond ({c}) that
     * a column runs through gets a mirror column on the other side of its centre, so it grows
     * symmetrically and its centre ports stay on the vertices (in a centred flowchart the
     * whole stack grows evenly around its centre line). Returns all original indices inserted.
     */
    static insertColumns(state, xs, lo = null, hi = null) {
      if (lo === null) {
        const cols = this.balanceForDiamonds(state, xs, 'c');
        cols.slice().sort((a, b) => b - a).forEach((x) => this.insertColumnEverywhere(state, x));
        return cols;
      }
      let cols = [...xs];
      let band = { lo, hi };
      for (let i = 0; i < 20; i++) {
        band = this.columnBand(state, Math.min(...cols), lo, hi);
        const next = this.balanceForDiamonds(state, xs, 'c', band);
        if (next.length === cols.length) { cols = next; break; }
        cols = next;
      }
      cols.slice().sort((a, b) => b - a).forEach((x) => this.insertColumnEverywhere(state, x, band));
      return cols;
    }

    /**
     * Rows that must shift together when columns at/after `x` move on rows lo..hi: starts
     * with lo..hi and grows to cover every box touching those rows that has any cell at or
     * right of x (it moves or stretches as a whole, so it is never torn).
     */
    static columnBand(state, x, lo, hi) {
      const parser = new DitaaParser();
      const ast = parser.parse(this.fromGridState(state));
      const boxes = ast.boxes;
      const runs = parser.wireRuns(ast);
      const moves = (b) => b.r1 >= lo && b.r2 <= hi && b.c2 >= x; // inside the band, right of x
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of boxes) {
          if (b.r2 < lo || b.r1 > hi || b.c2 < x) continue;
          if (b.r1 < lo) { lo = b.r1; changed = true; }
          if (b.r2 > hi) { hi = b.r2; changed = true; }
        }
        // A wire that only connects boxes which move (and lies right of x) moves with them,
        // rather than being re-joined with jogs: take its rows into the band
        for (const run of runs) {
          if (!run.boxes.length || !run.boxes.every((i) => moves(boxes[i]))) continue;
          if (run.cells.some(([, c]) => c < x)) continue;
          const rMin = Math.min(...run.cells.map(([r]) => r)), rMax = Math.max(...run.cells.map(([r]) => r));
          if (rMin < lo) { lo = rMin; changed = true; }
          if (rMax > hi) { hi = rMax; changed = true; }
        }
      }
      return { lo, hi };
    }

    /**
     * Grows a diamond by one column on each side of its centre within its band of rows,
     * keeping the centre (and so the top/bottom ports and the wires on them) where it is:
     * a blank or plain-wire column left of it is taken out (a lead-in wire gets one
     * character shorter) to let the left wall move out. Without such a column it grows to
     * the right instead (its centre moves by one). Returns how far the caret inside it moves.
     */
    static growDiamondH(state, box) {
      let band = this.columnBand(state, box.c1, box.r1, box.r2);
      for (let p = box.c1 - 1; p >= 0; p--) {
        band = this.columnBand(state, p, box.r1, box.r2);
        let ok = true;
        for (let r = band.lo; r <= band.hi && ok; r++) {
          const row = state.grid[r];
          const ch = row[p] || ' ', L = row[p - 1] || ' ', R = row[p + 1] || ' ';
          if (ch === '-' || ch === '=') ok = !isAlnum(L) && !isAlnum(R); // shortens a wire
          else ok = ch === ' ' && !isWordPair(L, R);
        }
        if (!ok) continue;
        if (this.removeColumnEverywhere(state, p, box, band)) continue;
        this.insertColumnEverywhere(state, box.c1, band); // just inside the (moved) left wall
        this.insertColumnEverywhere(state, box.c2, band); // just inside the right wall
        return 0;
      }
      this.insertColumns(state, [box.c1 + 1, box.c2], box.r1, box.r2);
      return 1;
    }

    /**
     * Makes k blank rows below row y-1, like pressing Enter there, except that a box that
     * straddles that line (one beside the source box, spanning across it) is moved down
     * whole instead of being stretched: in its columns the rows go in just above it.
     * Vertical lines crossing an insertion point are continued, so wires into the top of a
     * moved box stretch to follow it. Boxes enclosing `src` (containers) still stretch.
     */
    static insertRowsMovingBoxes(state, y, k, src) {
      const boxes = new DitaaParser().parse(this.fromGridState(state)).boxes;
      this.normalizeWidth(state);
      const encloses = (b) => b.r1 <= src.r1 && b.r2 >= src.r2 && b.c1 <= src.c1 && b.c2 >= src.c2;
      const at = Array(state.cols).fill(y);
      for (const b of boxes) {
        if (b.r1 < y && b.r2 >= y && !encloses(b)) {
          for (let c = b.c1; c <= b.c2; c++) at[c] = Math.min(at[c], b.r1);
        }
      }
      this.insertRowsPerColumn(state, at.map((yc) => Array(k).fill(yc)));
    }

    /**
     * Grows `src` taller by inserting a row before each original index in `ys` (rows inside
     * src), the way pressing Enter in it would, without growing the boxes beside it:
     *  - in src's own columns (and in empty columns / columns of boxes that enclose src) the
     *    rows go in at `ys`;
     *  - in the columns of any other box that those rows would cut through, the rows go in
     *    just below that box instead, so it keeps its size and position.
     * Vertical lines crossing an insertion point are continued (wires and the whitespace
     * between boxes stretch); a horizontal arrow on a line above the insertion stays where
     * it is, so it keeps its connection to the box beside it.
     */
    static growRowsInPlace(state, ys, src) {
      const parser = new DitaaParser();
      const ast = parser.parse(this.fromGridState(state));
      const boxes = ast.boxes;
      this.normalizeWidth(state);
      const encloses = (b) => b.r1 <= src.r1 && b.r2 >= src.r2 && b.c1 <= src.c1 && b.c2 >= src.c2;
      const same = (b) => b.r1 === src.r1 && b.c1 === src.c1 && b.r2 === src.r2 && b.c2 === src.c2;
      const srcIdx = boxes.findIndex(same);
      const runs = parser.wireRuns(ast);
      const at = Array.from({ length: state.cols }, () => ys.slice());
      boxes.forEach((b, bi) => {
        if (bi === srcIdx || encloses(b)) return;
        if (!ys.some((y) => b.r1 < y && y <= b.r2)) return;
        // A box joined to src by a horizontal arrow moves down by the rows inserted above that
        // arrow (so the arrow stays level and attached); the rest go in below it.
        let link = Infinity;
        for (const run of runs) {
          if (!run.boxes.includes(bi) || !run.boxes.includes(srcIdx)) continue;
          for (const [r, c] of run.cells) {
            if (r >= b.r1 && r <= b.r2 && (c === b.c1 - 1 || c === b.c2 + 1)) link = Math.min(link, r);
          }
        }
        const above = link === Infinity ? 0 : ys.filter((y) => y <= link).length;
        const rows = [...Array(above).fill(b.r1), ...Array(ys.length - above).fill(b.r2 + 1)];
        for (let c = b.c1; c <= b.c2; c++) at[c] = rows.slice();
      });
      this.insertRowsPerColumn(state, at);
    }

    /**
     * Inserts, in each column c, one row before each original row index in at[c]. A new
     * cell continues a vertical line when the cells above and below are both vertical line
     * characters, or when a vertical wire meets a box's wall there (the wall may be a plain
     * '-' or '=': the parser attaches a wire to any wall cell, not just to '+' ports). An
     * arrowhead pointing at that wall moves into the new cell, so it keeps touching the box.
     */
    static insertRowsPerColumn(state, at) {
      const old = state.grid.map((row) => row.slice());
      const roles = new DitaaParser().parse(this.fromGridState(state)).cellRole;
      const role = (r, c) => (roles[r] && roles[r][c]) || 'empty';
      const k = at[0] ? at[0].length : 0;
      const ch = (r, c) => (old[r] || [])[c] || ' ';
      const glyphV = (r, c) => {
        const x = ch(r, c);
        if ('|:+*/\\'.includes(x) && x !== ' ') return true;
        return (x === '^' || x === 'v' || x === '.' || x === "'") && !isAlnum(ch(r, c - 1)) && !isAlnum(ch(r, c + 1));
      };
      const wireV = (r, c) => {
        const ro = role(r, c);
        return ro === 'wire-v' || ro === 'wire-corner' || ro === 'wire-junction' ||
          (ro === 'wire-arrow' && (ch(r, c) === '^' || ch(r, c) === 'v'));
      };
      const wall = (r, c) => role(r, c) === 'box-border';
      const rows = state.rows + k;
      const grid = Array.from({ length: rows }, () => Array(state.cols).fill(' '));
      for (let c = 0; c < state.cols; c++) {
        const ins = at[c].slice().sort((a, b) => a - b);
        let out = 0, i = 0;
        let nextOverride = null;
        for (let r = 0; r <= state.rows; r++) {
          let n = 0;
          while (i + n < ins.length && ins[i + n] === r) n++;
          if (n) {
            const above = r - 1, below = r;
            const joins = (glyphV(above, c) && glyphV(below, c)) ||
              (wall(above, c) && wireV(below, c)) || (wireV(above, c) && wall(below, c));
            const line = ch(above, c) === ':' || ch(below, c) === ':' ? ':' : '|';
            const start = out;
            for (let m = 0; m < n; m++) grid[out++][c] = joins ? line : ' ';
            if (joins && wall(above, c) && ch(below, c) === '^') {
              grid[start][c] = '^';           // arrowhead stays against the wall above
              nextOverride = line;
            } else if (joins && wall(below, c) && ch(above, c) === 'v' && start > 0) {
              grid[out - 1][c] = 'v';         // arrowhead stays against the wall below
              grid[start - 1][c] = line;
            }
            i += n;
          }
          if (r < state.rows) {
            grid[out++][c] = nextOverride || ch(r, c);
            nextOverride = null;
          }
        }
        while (i < ins.length) { grid[out++][c] = ' '; i++; } // past the end
      }
      state.grid = grid;
      state.rows = rows;
    }

    /** Row counterpart of insertColumns. */
    static insertRows(state, ys) {
      const rows = this.balanceForDiamonds(state, ys, 'r');
      rows.slice().sort((a, b) => b - a).forEach((y) => this.insertRowEverywhere(state, y));
      return rows;
    }

    static balanceForDiamonds(state, positions, axis, band = null) {
      const diamonds = new DitaaParser().parse(this.fromGridState(state)).boxes
        .filter((b) => b.shape === 'choice' && (!band || (b.r1 >= band.lo && b.r2 <= band.hi)));
      const out = [...positions];
      for (let iter = 0; iter < 20; iter++) {
        let added = false;
        for (const d of diamonds) {
          const lo = axis === 'c' ? d.c1 : d.r1, hi = axis === 'c' ? d.c2 : d.r2;
          const mid = (lo + hi) / 2;
          const inside = out.filter((x) => x > lo && x <= hi);
          const first = inside.filter((x) => x <= mid), second = inside.filter((x) => x > mid);
          while (first.length !== second.length) {
            const [few, many] = first.length < second.length ? [first, second] : [second, first];
            const m = lo + hi + 1 - many[few.length];
            few.push(m);
            out.push(m);
            added = true;
          }
        }
        if (!added) break;
      }
      return out;
    }

    /** Error if removing columns/rows `positions` would make a diamond other than `self` lopsided. */
    static diamondRemovalError(state, positions, axis, self, verb, band = null) {
      const diamonds = new DitaaParser().parse(this.fromGridState(state)).boxes
        .filter((b) => b.shape === 'choice' && (!band || (b.r2 >= band.lo && b.r1 <= band.hi)));
      for (const d of diamonds) {
        if (self && d.r1 === self.r1 && d.c1 === self.c1 && d.r2 === self.r2 && d.c2 === self.c2) continue;
        const lo = axis === 'c' ? d.c1 : d.r1, hi = axis === 'c' ? d.c2 : d.r2;
        if (positions.some((x) => x > lo && x < hi)) {
          return { error: `Cannot ${verb}: it would make the diamond "${d.lines[0] || '{c}'}" lopsided` };
        }
      }
      return null;
    }

    /**
     * Resizes a diamond ({c}) box by 2 columns / 2 rows at a time, adding or removing one on
     * each side of the centre, across the whole diagram. The centre ports stay on the
     * diamond's vertices and every wire attached to them keeps its connection.
     */
    static resizeDiamond(rawText, box, dw, dh, fullRows = false) {
      const curW = box.c2 - box.c1;
      const curH = box.r2 - box.r1;
      if (curW + dw < 4 || curH + dh < 2) return { error: 'Diamond is already at its minimum size' };
      const state = this.toGridState(rawText, box.r2 + 2, box.c2 + 2);

      if (dw > 0) {
        this.growDiamondH(state, box);
      } else if (dw < 0) {
        // Take a column out on each side of the centre, then put one back left of the left
        // wall so the centre (and the wires on the top/bottom ports) stays put.
        const band = this.columnBand(state, box.c1, box.r1, box.r2);
        const err = this.diamondRemovalError(state, [box.c1 + 1, box.c2 - 1], 'c', box, 'narrow', band) ||
          this.removeColumnEverywhere(state, box.c2 - 1, box, band) ||
          this.removeColumnEverywhere(state, box.c1 + 1, box, band);
        if (err) return err;
        this.insertColumnEverywhere(state, box.c1, band);
      }

      if (dh > 0) {
        if (fullRows) this.insertRows(state, [box.r1 + 1, box.r2]);
        else this.growRowsInPlace(state, [box.r1 + 1, box.r2], box);
      } else if (dh < 0) {
        if (!this.canRemoveRow(state, box.r1 + 1, box) || !this.canRemoveRow(state, box.r2 - 1, box)) {
          return { error: 'Cannot shorten: text or wires are in the way' };
        }
        const lop = this.diamondRemovalError(state, [box.r1 + 1, box.r2 - 1], 'r', box, 'shorten');
        if (lop) return lop;
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

    /**
     * Atomic safety net for grid operations on one box: parses the diagram before and after
     * and refuses the whole operation if any box disappears or any box's label, tags, shape
     * or legend key changes (the operated box keeps those too; only its size/position may
     * change). Glyph-level checks can't see that, e.g. removing the last interior column of
     * a small empty box elsewhere collapses it.
     */
    static guardOtherBoxes(rawText, res, verb, exceptBox = null, allowNew = 0, checkWires = false) {
      if (!res || res.error) return res;
      const sig = (b) => JSON.stringify([b.lines, b.colorKey, b.customHex, b.shape, b.macroKey, b.dashedBorder]);
      const same = (a, b) => a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
      const parser = new DitaaParser();
      const beforeAst = parser.parse(rawText);
      const afterAst = parser.parse(res.text);

      // exceptBox: the box being edited may change its own label/tags, but must still exist.
      // It is tracked by identity, not by its contents (another box may have the same label):
      // before the edit it is exceptBox; after it, it is the box the caret ended up in, since
      // every in-box edit leaves the caret inside the box it edited.
      let selfBefore = null, selfAfter = null;
      if (exceptBox) {
        selfBefore = beforeAst.boxes.find((b) => same(b, exceptBox)) || null;
        selfAfter = this.boxAtCaret(afterAst.boxes, res.cursorR, res.cursorC);
        if (!selfBefore || !selfAfter) return { error: `Cannot ${verb}: it would break this box` };
        if (afterAst.boxes.length !== beforeAst.boxes.length) {
          return { error: `Cannot ${verb}: it would ${afterAst.boxes.length > beforeAst.boxes.length ? 'create' : 'break'} a box` };
        }
      }
      const before = beforeAst.boxes.filter((b) => b !== selfBefore);
      const remaining = afterAst.boxes.filter((b) => b !== selfAfter).map(sig);
      for (const b of before) {
        const i = remaining.indexOf(sig(b));
        if (i === -1) {
          const name = b.macroKey ? `[${b.macroKey}]` : b.lines[0] ? `"${b.lines[0]}"` : `the box at line ${b.r1 + 1}`;
          return { error: `Cannot ${verb}: it would break ${name}` };
        }
        remaining.splice(i, 1);
      }
      if (remaining.length > allowNew) return { error: `Cannot ${verb}: it would merge lines into a new box` };

      // Same boxes is not enough: every wire must still connect the same boxes. Boxes are
      // keyed by contents (so identical boxes are interchangeable, which is fine for a
      // multiset comparison) except the edited one, which is keyed by identity. (Inserting
      // a new shape may legitimately split a connection in two, so allowNew skips this.)
      if (!allowNew && checkWires) {
        const keys = (ast, self) => ast.boxes.map((b) => (b === self ? 'SELF' : sig(b)));
        const comps = (ast, k) => parser.connections(ast).map((ids) => JSON.stringify(ids.map((i) => k[i]).sort()));
        const after = comps(afterAst, keys(afterAst, selfAfter));
        for (const comp of comps(beforeAst, keys(beforeAst, selfBefore))) {
          const i = after.indexOf(comp);
          if (i === -1) {
            const names = JSON.parse(comp).map((k) => (k === 'SELF' ? 'this box' : JSON.parse(k)[0][0] || 'a box'));
            return { error: `Cannot ${verb}: it would change what a wire connects (${names.join(' – ')})` };
          }
          after.splice(i, 1);
        }
      }
      return res;
    }

    static resizeBox(rawText, box, dw, dh) {
      const verb = dw > 0 ? 'widen' : dw < 0 ? 'narrow' : dh > 0 ? 'make taller' : 'make shorter';
      const res = this.guardOtherBoxes(rawText, this.resizeBoxUnchecked(rawText, box, dw, dh), verb);
      if (dh > 0 && res && res.error) {
        // Growing only this box didn't work out: full-width lines (neighbours grow too)
        const full = this.guardOtherBoxes(rawText, this.resizeBoxUnchecked(rawText, box, dw, dh, true), verb);
        if (full && !full.error) return full;
      }
      return res;
    }

    /** The smallest box that strictly encloses `box` (its container), or null. */
    static enclosingBox(boxes, box) {
      const inside = (p) => p.r1 < box.r1 && p.r2 > box.r2 && p.c1 < box.c1 && p.c2 > box.c2;
      return boxes.filter(inside).sort((p, q) => (p.r2 - p.r1) * (p.c2 - p.c1) - (q.r2 - q.r1) * (q.c2 - q.c1))[0] || null;
    }

    /**
     * Resizes a box that sits inside another box by moving its own walls into (or out of)
     * the empty space around it. The outer box never changes: if there isn't enough empty
     * space inside it, the user is asked to make the outer box bigger first.
     * Rectangles grow/shrink on the right and bottom; diamonds on both sides of their centre
     * (so their ports stay on the vertices). Returns { text, cursorR, cursorC } or { error }.
     */
    static resizeInside(rawText, box, outer, dw, dh) {
      const state = this.toGridState(rawText, box.r2 + 2, box.c2 + 2);
      const g = state.grid;
      const at = (r, c) => (g[r] && g[r][c]) || ' ';
      const outerName = this.boxName(new DitaaParser().parse(rawText), outer);
      const name = outerName && outerName !== 'box' ? `“${outerName}”` : 'the box around it';
      const noRoom = { error: `Not enough empty space inside ${name}: make it bigger first` };
      const blank = (r1, c1, r2, c2) => {
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (at(r, c) !== ' ') return false;
        return true;
      };
      const insideOuter = (r1, c1, r2, c2) => r1 > outer.r1 && r2 < outer.r2 && c1 > outer.c1 && c2 < outer.c2;
      const dashedH = at(box.r1, box.c1 + 1) === '=' ? '=' : '-';
      const dashedV = at(box.r1 + 1, box.c1) === ':' ? ':' : '|';
      // Move the vertical wall at column `from` to column `to` (rows r1..r2), filling the gap
      const moveWallCol = (b, from, to) => {
        for (let r = b.r1; r <= b.r2; r++) {
          const wall = at(r, from);
          const fill = r === b.r1 || r === b.r2 ? dashedH : ' ';
          for (let c = Math.min(from, to); c <= Math.max(from, to); c++) g[r][c] = fill;
          g[r][to] = wall;
        }
      };
      const moveWallRow = (b, from, to) => {
        for (let c = b.c1; c <= b.c2; c++) {
          const wall = at(from, c);
          const fill = c === b.c1 || c === b.c2 ? dashedV : ' ';
          for (let r = Math.min(from, to); r <= Math.max(from, to); r++) g[r][c] = fill;
          g[to][c] = wall;
        }
      };
      const shrinkable = (cells) => cells.every(([r, c, wallRow]) => (wallRow ? '-='.includes(at(r, c)) : at(r, c) === ' '));
      let b = { ...box };
      const diamond = box.shape === 'choice';
      if (dw > 0) {
        if (diamond) {
          if (!insideOuter(b.r1, b.c1 - 1, b.r2, b.c2 + 1) || !blank(b.r1, b.c1 - 1, b.r2, b.c1 - 1) || !blank(b.r1, b.c2 + 1, b.r2, b.c2 + 1)) return noRoom;
          moveWallCol(b, b.c2, b.c2 + 1);
          moveWallCol(b, b.c1, b.c1 - 1);
          b = { ...b, c1: b.c1 - 1, c2: b.c2 + 1 };
        } else {
          if (!insideOuter(b.r1, b.c2 + 1, b.r2, b.c2 + dw) || !blank(b.r1, b.c2 + 1, b.r2, b.c2 + dw)) return noRoom;
          moveWallCol(b, b.c2, b.c2 + dw);
          b = { ...b, c2: b.c2 + dw };
        }
      } else if (dw < 0) {
        const k = -dw;
        const cols = diamond ? [b.c1 + 1, b.c2 - 1] : Array.from({ length: k }, (_, i) => b.c2 - 1 - i);
        const cells = [];
        for (const c of cols) for (let r = b.r1; r <= b.r2; r++) cells.push([r, c, r === b.r1 || r === b.r2]);
        if (!shrinkable(cells)) return { error: 'Cannot narrow: text is in the way' };
        if (diamond) {
          moveWallCol(b, b.c1, b.c1 + 1);
          for (let r = b.r1; r <= b.r2; r++) g[r][b.c1] = ' ';
          moveWallCol(b, b.c2, b.c2 - 1);
          for (let r = b.r1; r <= b.r2; r++) g[r][b.c2] = ' ';
          b = { ...b, c1: b.c1 + 1, c2: b.c2 - 1 };
        } else {
          moveWallCol(b, b.c2, b.c2 - k);
          for (let r = b.r1; r <= b.r2; r++) for (let c = b.c2 - k + 1; c <= b.c2; c++) g[r][c] = ' ';
          b = { ...b, c2: b.c2 - k };
        }
      }
      if (dh > 0) {
        if (diamond) {
          if (!insideOuter(b.r1 - 1, b.c1, b.r2 + 1, b.c2) || !blank(b.r1 - 1, b.c1, b.r1 - 1, b.c2) || !blank(b.r2 + 1, b.c1, b.r2 + 1, b.c2)) return noRoom;
          moveWallRow(b, b.r2, b.r2 + 1);
          moveWallRow(b, b.r1, b.r1 - 1);
          b = { ...b, r1: b.r1 - 1, r2: b.r2 + 1 };
        } else {
          if (!insideOuter(b.r2 + 1, b.c1, b.r2 + dh, b.c2) || !blank(b.r2 + 1, b.c1, b.r2 + dh, b.c2)) return noRoom;
          moveWallRow(b, b.r2, b.r2 + dh);
          b = { ...b, r2: b.r2 + dh };
        }
      } else if (dh < 0 && diamond) {
        const cells = [];
        for (const r of [b.r1 + 1, b.r2 - 1]) for (let c = b.c1; c <= b.c2; c++) cells.push([r, c, false]);
        if (!cells.every(([r, c]) => (c === b.c1 || c === b.c2 ? '|:'.includes(at(r, c)) : at(r, c) === ' '))) {
          return { error: 'Cannot shorten: text is in the way' };
        }
        moveWallRow(b, b.r1, b.r1 + 1);
        for (let c = b.c1; c <= b.c2; c++) g[b.r1][c] = ' ';
        moveWallRow(b, b.r2, b.r2 - 1);
        for (let c = b.c1; c <= b.c2; c++) g[b.r2][c] = ' ';
        b = { ...b, r1: b.r1 + 1, r2: b.r2 - 1 };
      }
      return { text: this.fromGridState(state), cursorR: Math.floor((b.r1 + b.r2) / 2), cursorC: Math.floor((b.c1 + b.c2) / 2), box: b };
    }

    static resizeBoxUnchecked(rawText, box, dw, dh, fullRows = false) {
      if (!box) return null;
      // A box inside another box grows into the empty space inside it; the outer box never
      // changes (the user makes it bigger first if needed). Shortening a rectangle is already
      // local (its bottom wall moves up), so it keeps the generic path.
      const outer = this.enclosingBox(new DitaaParser().parse(rawText).boxes, box);
      if (outer && !(box.shape !== 'choice' && dh < 0 && dw === 0)) {
        const diamond = box.shape === 'choice';
        const min = diamond ? 4 : 3;
        if (box.c2 - box.c1 + (diamond ? Math.sign(dw) * 2 : dw) < min || box.r2 - box.r1 + (diamond ? Math.sign(dh) * 2 : dh) < 2) {
          return { error: 'Box is already at its minimum size' };
        }
        return this.resizeInside(rawText, box, outer, diamond ? Math.sign(dw) * 2 : dw, diamond ? Math.sign(dh) * 2 : dh);
      }
      if (box.shape === 'choice') return this.resizeDiamond(rawText, box, Math.sign(dw) * 2, Math.sign(dh) * 2, fullRows);
      const curW = box.c2 - box.c1;
      const curH = box.r2 - box.r1;
      if (curW + dw < 3 || curH + dh < 2) return { error: 'Box is already at its minimum size' };

      const state = this.toGridState(rawText, box.r2 + Math.max(0, dh) + 2, box.c2 + Math.max(0, dw) + 2);
      const { grid } = state;

      // Widen/narrow by inserting/removing columns just inside the right wall on the box's
      // own lines, like typing on them: what is beside it moves over (a box beside it moves
      // as a whole), lines above and below are untouched.
      if (dw > 0) {
        this.insertColumns(state, Array(dw).fill(box.c2), box.r1, box.r2);
      } else if (dw < 0) {
        const xs = Array.from({ length: -dw }, (_, i) => box.c2 - 1 - i);
        const band = this.columnBand(state, Math.min(...xs), box.r1, box.r2);
        const lop = this.diamondRemovalError(state, xs, 'c', null, 'narrow', band);
        if (lop) return lop;
        for (let i = 0; i < -dw; i++) {
          const err = this.removeColumnEverywhere(state, box.c2 - 1 - i, box, band);
          if (err) return err;
        }
      }
      if (dh < 0) {
        const targetR = box.r2 - 1;
        for (let c = box.c1 + 1; c < box.c2; c++) {
          if (grid[targetR][c] !== ' ') return { error: 'Cannot shorten: the bottom row has text' };
        }
      }

      if (dh > 0) {
        // A full-width row just above the bottom wall; vertical lines crossing it continue,
        // so neighbouring boxes and wires stretch instead of tearing.
        if (fullRows) this.insertRows(state, [box.r2]);
        else this.growRowsInPlace(state, [box.r2], box);
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

    /*************************************************************************
     * IN-BOX TYPING: text edits inside a box grow the box instead of tearing it
     *************************************************************************/

    /** Innermost box whose interior contains caret (r, c); c may sit just before the right wall. */
    static boxAtCaret(boxes, r, c) {
      let best = null;
      for (const b of boxes) {
        if (r > b.r1 && r < b.r2 && c > b.c1 && c <= b.c2) {
          if (!best || (b.r2 - b.r1) * (b.c2 - b.c1) < (best.r2 - best.r1) * (best.c2 - best.c1)) best = b;
        }
      }
      return best;
    }

    /**
     * The run of interior cells on row r, around caret column c, that belong to `box` itself
     * (stops at nested boxes). Returns [c0, end) or null if the caret is not on such a run.
     */
    static ownedRun(boxes, box, r, c) {
      const kids = boxes.filter((b) => b !== box && b.r1 >= box.r1 && b.r2 <= box.r2 && b.c1 >= box.c1 && b.c2 <= box.c2);
      const owned = (col) => col > box.c1 && col < box.c2 && !kids.some((k) => r >= k.r1 && r <= k.r2 && col >= k.c1 && col <= k.c2);
      if (!owned(c) && !owned(c - 1)) return null;
      let c0 = c;
      while (owned(c0 - 1)) c0--;
      let end = c;
      while (owned(end)) end++;
      return { c0, end };
    }

    /**
     * Applies a text edit typed at caret (r, c) inside a box:
     *   op = { type: 'insert', text } | { type: 'newline' } | { type: 'backspace' } | { type: 'delete' }
     * `sel` (optional) is the other end of a selection; selected cells inside the same box are
     * cleared first. Typing never pushes a wall: when text would reach the right wall, a full
     * column is added just inside it (diamonds grow by 2 to keep their ports on the vertices),
     * and Enter adds a full-width row, so the rest of the diagram shifts to stay aligned.
     * Returns null when the caret is not inside a box (let the editor handle the key normally),
     * { error } when the edit would break another box, else { text, cursorR, cursorC }.
     */
    static typeInBox(rawText, caret, sel, op) {
      const parser = new DitaaParser();
      const boxes = parser.parse(rawText).boxes;
      const box = this.boxAtCaret(boxes, caret.r, caret.c);
      if (!box) return null; // the only "use normal editing" answer
      const hasSel = sel && (sel.r !== caret.r || sel.c !== caret.c);
      if (hasSel) {
        const [, b] = sel.r < caret.r || (sel.r === caret.r && sel.c < caret.c) ? [sel, caret] : [caret, sel];
        if (this.boxAtCaret(boxes, b.r, b.c) !== box) return null; // selection leaves the box
      } else {
        // Editing a wall is editing the drawing, not the text: an edit that lands in a wall's
        // column (typing or Delete right before a wall, Backspace right after one) is left to
        // the editor as plain text. Text is typed between the walls, and auto-fit keeps a
        // space before the right wall, so the two never get confused.
        const run = this.ownedRun(boxes, box, caret.r, caret.c);
        if (run) {
          if ((op.type === 'insert' || op.type === 'delete') && caret.c === run.end) return null;
          if (op.type === 'backspace' && caret.c === run.c0) return null;
        }
      }
      // From here on we are editing inside a box: any failure is an error, never a silent
      // fallback to plain text editing (which would push the box's wall out of line).
      let res = this.typeInBoxInner(rawText, boxes, box, caret, sel, op, false);
      const addsLines = op.type === 'newline' || (op.type === 'insert' && /[\r\n]/.test(op.text));
      if (addsLines && (!res || res.error) && !this.enclosingBox(boxes, box)) {
        // (Not for a box inside another box: the outer box never grows on its own.)
        // Growing only this box didn't work out: grow it with full-width lines instead
        // (boxes beside it get taller too, but nothing is broken)
        const full = this.typeInBoxInner(rawText, boxes, box, caret, sel, op, true);
        if (full && !full.error) return full;
      }
      if (!res) return { error: 'Cannot make that edit inside this box' };
      return res;
    }

    static typeInBoxInner(rawText, boxes, box, caret, sel, op, fullRows = false) {
      let text = rawText;
      let cur = { r: caret.r, c: caret.c };

      if (sel && (sel.r !== caret.r || sel.c !== caret.c)) {
        const [a, b] = sel.r < caret.r || (sel.r === caret.r && sel.c < caret.c) ? [sel, caret] : [caret, sel];
        const cleared = this.clearRange(text, boxes, box, a, b);
        if (!cleared) return { error: 'The selection crosses into another box' };
        text = cleared.text;
        cur = { r: a.r, c: a.c };
        if (op.type === 'backspace' || op.type === 'delete') return this.finishTyping(rawText, text, cur, box);
      }

      if (op.type === 'insert') {
        for (const piece of op.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split(/(\n)/)) {
          if (piece === '') continue;
          const res = piece === '\n' ? this.boxNewline(text, cur, fullRows) : this.boxInsert(text, cur, piece);
          if (!res || res.error) return res;
          text = res.text;
          cur = { r: res.cursorR, c: res.cursorC };
        }
        return this.finishTyping(rawText, text, cur, box);
      }
      let res;
      if (op.type === 'newline') res = this.boxNewline(text, cur, fullRows);
      else if (op.type === 'backspace') res = this.boxBackspace(text, cur);
      else if (op.type === 'delete') res = this.boxDelete(text, cur);
      if (!res || res.error) return res;
      return this.finishTyping(rawText, res.text, { r: res.cursorR, c: res.cursorC }, box);
    }

    /**
     * typeInBox for a textarea selection given as character offsets (the editor's
     * selectionStart / selectionEnd). Both the keyboard and the context menu use this, so
     * a selection inside a box is always replaced the same way. `caret` overrides the
     * position of selectionStart (for a caret placed past the end of a line).
     */
    static editAtSelection(text, selStart, selEnd, op, caret = null) {
      const start = caret || this.getRowColFromIndex(text, selStart);
      const end = selEnd !== selStart ? this.getRowColFromIndex(text, selEnd) : null;
      return this.typeInBox(text, start, end, op);
    }

    static finishTyping(rawText, text, cur, box) {
      return this.guardOtherBoxes(rawText, { text, cursorR: cur.r, cursorC: cur.c }, 'type here', box);
    }

    /** Parses `text` and returns { state, boxes, box, run } for the caret, or null. */
    static caretContext(text, cur) {
      const boxes = new DitaaParser().parse(text).boxes;
      const box = this.boxAtCaret(boxes, cur.r, cur.c);
      if (!box) return null;
      const run = this.ownedRun(boxes, box, cur.r, cur.c);
      if (!run) return null;
      return { state: this.toGridState(text), boxes, box, run };
    }

    /**
     * Grows the caret's box until its run on row cur.r can hold `needed(ctx, cur)` characters
     * plus one cell of padding before its end. `needed` is re-measured after every step
     * because growing a diamond also shifts its text right. Returns { text, cur } with the
     * caret moved along if columns were inserted to its left.
     */
    static ensureRoom(text, cur, needed) {
      for (let guard = 0; guard < 400; guard++) {
        const ctx = this.caretContext(text, cur);
        if (!ctx) return null;
        const { state, box, run } = ctx;
        const missing = needed(ctx, cur) + 1 - (run.end - run.c0);
        if (missing > 2000) return { error: 'Cannot fit that much text: the box would grow too large' };
        if (missing <= 0) return { text, cur };
        // Inside another box: grow into the empty space there; the outer box never changes
        const outer = this.enclosingBox(ctx.boxes, box);
        if (outer) {
          const grown = this.resizeInside(text, box, outer, box.shape === 'choice' ? 2 : missing, 0);
          if (grown.error) return grown;
          if (box.shape === 'choice') cur = { r: cur.r, c: cur.c }; // grows on both sides around a fixed centre
          text = grown.text;
          continue;
        }
        // Grow only on the box's own lines, like typing on them: what is beside it moves
        // over, lines above and below stay put. A diamond grows around its centre.
        if (box.shape === 'choice') {
          const shift = this.growDiamondH(state, box);
          cur = { r: cur.r, c: cur.c + shift };
        } else {
          const cols = this.insertColumns(state, Array(missing).fill(run.end), box.r1, box.r2);
          cur = { r: cur.r, c: cur.c + cols.filter((x) => x < cur.c).length };
        }
        text = this.fromGridState(state);
      }
      return { error: 'Cannot fit that much text: the box would grow too large' };
    }

    static readRun(state, r, run) {
      return state.grid[r].slice(run.c0, run.end).join('');
    }

    static writeRun(state, r, run, str) {
      for (let i = 0; i < run.end - run.c0; i++) state.grid[r][run.c0 + i] = str[i] || ' ';
    }

    static boxInsert(text, cur, str) {
      const ctx0 = this.caretContext(text, cur);
      if (!ctx0) return null;
      // Work out the edited line once, from the text as it is now. Growing the box may push
      // blank columns into it (left of the caret, too), so it is re-laid out afterwards
      // from these values instead of being re-read.
      const line0 = this.readRun(ctx0.state, cur.r, ctx0.run);
      const k0 = cur.c - ctx0.run.c0;
      const full = line0.slice(0, k0) + str + line0.slice(k0);
      const lead = full.search(/\S/);
      const indent = lead === -1 ? 0 : lead;
      const body = full.trim();
      // May exceed body.length: spaces typed at the end of the text are kept as caret movement
      const caretInBody = Math.max(0, k0 + str.length - indent);
      const diamond = ctx0.box.shape === 'choice';
      // Diamonds draw their label centred, so their ASCII text is kept centred too and
      // measured without its padding; other boxes keep the text where it was typed.
      const needed = diamond ? Math.max(body.length, caretInBody) + 2 : indent + Math.max(body.length, caretInBody);

      const room = this.ensureRoom(text, cur, () => needed);
      if (!room || room.error) return room || null;
      ({ text, cur } = room);
      const ctx = this.caretContext(text, cur);
      if (diamond) {
        const c = this.placeCentred(ctx.state, cur.r, ctx.run, full, k0 + str.length);
        return { text: this.fromGridState(ctx.state), cursorR: cur.r, cursorC: c };
      }
      if (lead === -1) {
        // Only blanks typed: keep them, the caret simply moves on
        this.writeRun(ctx.state, cur.r, ctx.run, '');
        return { text: this.fromGridState(ctx.state), cursorR: cur.r, cursorC: ctx.run.c0 + k0 + str.length };
      }
      this.writeRun(ctx.state, cur.r, ctx.run, ' '.repeat(indent) + body);
      return { text: this.fromGridState(ctx.state), cursorR: cur.r, cursorC: ctx.run.c0 + indent + caretInBody };
    }

    /**
     * Writes `content` (trimmed) centred in the run; returns the grid column that offset
     * `caretAt` of the untrimmed content ends up at.
     */
    static placeCentred(state, r, run, content, caretAt) {
      const lead = content.search(/\S/);
      const body = content.trim();
      const len = run.end - run.c0;
      const left = Math.max(0, Math.floor((len - body.length) / 2));
      this.writeRun(state, r, run, ' '.repeat(left) + body);
      const off = lead === -1 ? 0 : Math.max(0, caretAt - lead);
      return Math.min(run.end - 1, run.c0 + left + off);
    }

    static boxNewline(text, cur, fullRows = false) {
      const ctx = this.caretContext(text, cur);
      if (!ctx) return null;
      const { state, box, run } = ctx;
      const line = this.readRun(state, cur.r, run);
      const k = cur.c - run.c0;
      const lead = line.slice(0, k).search(/\S/);
      const indent = lead === -1 ? k : lead; // keep the line's indentation
      const tail = line.slice(k).trim(); // the new line gets the indentation, not the gap after the caret

      // Inside another box: take the new line from the empty space inside it (the outer box
      // never changes); the lines of this box below the caret move down by one.
      const outer = !fullRows && this.enclosingBox(ctx.boxes, box);
      if (outer) {
        const diamond = box.shape === 'choice';
        const grown = this.resizeInside(text, box, outer, 0, diamond ? 2 : 1);
        if (grown.error) return grown;
        const st = this.toGridState(grown.text);
        const b = grown.box;
        const copyRow = (from, to) => { for (let c = b.c1; c <= b.c2; c++) st.grid[to][c] = st.grid[from][c]; };
        const blankRow = (r) => { for (let c = b.c1 + 1; c < b.c2; c++) st.grid[r][c] = ' '; };
        let oldR = cur.r, newR;
        const mid = (b.r1 + b.r2) / 2;
        if (diamond && cur.r < mid) {
          // a diamond grew a line on each side: lines above the caret move up into the top one
          for (let r = b.r1 + 1; r < cur.r; r++) copyRow(r + 1, r);
          oldR = cur.r - 1;
          copyRow(cur.r, oldR);
          newR = cur.r;
        } else {
          // lines below the caret move down into the new bottom line
          for (let r = b.r2 - 1; r > cur.r + 1; r--) copyRow(r - 1, r);
          newR = cur.r + 1;
        }
        blankRow(newR);
        const r0 = { c0: b.c1 + 1, end: b.c2 };
        if (diamond) {
          this.placeCentred(st, oldR, r0, line.slice(0, k), 0);
          const c = this.placeCentred(st, newR, r0, tail, tail.search(/\S/));
          return { text: this.fromGridState(st), cursorR: newR, cursorC: c };
        }
        const run2 = { c0: run.c0, end: run.end };
        this.writeRun(st, oldR, run2, line.slice(0, k));
        this.writeRun(st, newR, run2, ' '.repeat(indent) + tail);
        return { text: this.fromGridState(st), cursorR: newR, cursorC: run.c0 + indent };
      }

      // The box grows on its own; boxes beside it keep their size. A diamond gets a mirror
      // row on the other side of its centre so it stays symmetric.
      let ys = [cur.r + 1];
      if (box.shape === 'choice') ys.push(box.r1 + box.r2 + 1 - (cur.r + 1));
      if (fullRows) ys = this.insertRows(state, ys); // fallback: full-width rows (neighbours grow too)
      else this.growRowsInPlace(state, ys, box);
      const oldR = cur.r + ys.filter((y) => y <= cur.r).length;
      const newR = oldR + 1;
      if (box.shape === 'choice') {
        this.placeCentred(state, oldR, run, line.slice(0, k), 0);
        const c = this.placeCentred(state, newR, run, tail, tail.search(/\S/));
        return { text: this.fromGridState(state), cursorR: newR, cursorC: c };
      }
      this.writeRun(state, oldR, run, line.slice(0, k));
      this.writeRun(state, newR, run, ' '.repeat(indent) + tail);
      return { text: this.fromGridState(state), cursorR: newR, cursorC: run.c0 + indent };
    }

    static boxBackspace(text, cur) {
      const ctx = this.caretContext(text, cur);
      if (!ctx) return null;
      const { state, run } = ctx;
      const line = this.readRun(state, cur.r, run);
      const k = cur.c - run.c0;
      // At the start of the line's text (only padding before the caret): join with the line
      // above, as in a text editor. (Right after the wall it is a wall edit: see typeInBox.)
      if (line.slice(0, k).trim() === '' && cur.r - 1 > ctx.box.r1) {
        const prevRun = this.ownedRun(ctx.boxes, ctx.box, cur.r - 1, run.c0);
        if (prevRun && prevRun.c0 === run.c0 && prevRun.end === run.end) return this.joinWithPrevious(text, cur.r, run);
      }
      if (k === 0) return { text, cursorR: cur.r, cursorC: cur.c };
      this.writeRun(state, cur.r, run, line.slice(0, k - 1) + line.slice(k));
      return { text: this.fromGridState(state), cursorR: cur.r, cursorC: cur.c - 1 };
    }

    static boxDelete(text, cur) {
      const ctx = this.caretContext(text, cur);
      if (!ctx) return null;
      const { state, box, run } = ctx;
      const line = this.readRun(state, cur.r, run);
      const k = cur.c - run.c0;
      if (line.slice(k).trim() !== '') {
        this.writeRun(state, cur.r, run, line.slice(0, k) + line.slice(k + 1));
        return { text: this.fromGridState(state), cursorR: cur.r, cursorC: cur.c };
      }
      if (cur.r + 1 >= box.r2) return { text, cursorR: cur.r, cursorC: cur.c };
      const next = this.ownedRun(ctx.boxes, box, cur.r + 1, run.c0);
      if (!next || next.c0 !== run.c0 || next.end !== run.end) return { text, cursorR: cur.r, cursorC: cur.c };
      return this.joinWithPrevious(text, cur.r + 1, run);
    }

    /**
     * Joins interior row r onto row r-1 of the same box (Backspace at the start of a line /
     * Delete at the end of the previous one), widening if needed, then removes the emptied
     * row when nothing else crosses it.
     */
    static joinWithPrevious(text, r, run) {
      let ctx = this.caretContext(text, { r, c: run.c0 });
      if (!ctx) return null;
      const { box } = ctx;
      const prevRun = r - 1 > box.r1 ? this.ownedRun(ctx.boxes, box, r - 1, run.c0) : null;
      if (!prevRun || prevRun.c0 !== run.c0 || prevRun.end !== run.end) {
        return { text, cursorR: r, cursorC: run.c0 }; // first line, or a nested box in the way: nothing to join
      }
      const prev = this.readRun(ctx.state, r - 1, run).replace(/\s+$/, '');
      const curLine = this.readRun(ctx.state, r, run).replace(/\s+$/, '');
      const joined = prev.length ? prev + curLine.replace(/^\s+/, '') : curLine;
      const caretK = prev.length ? prev.length : Math.max(0, curLine.search(/\S/));
      const room = this.ensureRoom(text, { r: r - 1, c: run.c0 }, () => joined.length);
      if (!room || room.error) return room || null;
      text = room.text;
      ctx = this.caretContext(text, room.cur);
      const { state } = ctx;
      const newBox = ctx.box;
      if (newBox.shape === 'choice') {
        const c = this.placeCentred(state, r - 1, ctx.run, joined, caretK);
        this.writeRun(state, r, ctx.run, '');
        return { text: this.fromGridState(state), cursorR: r - 1, cursorC: c };
      }
      this.writeRun(state, r - 1, ctx.run, joined);
      const rowRun = { c0: ctx.run.c0, end: ctx.run.end };
      this.writeRun(state, r, rowRun, '');
      if (newBox.shape !== 'choice' && newBox.r2 - newBox.r1 > 2 && this.canRemoveRow(state, r, newBox) &&
          !this.diamondRemovalError(state, [r], 'r', null, 'join')) {
        state.grid.splice(r, 1);
        state.rows--;
      }
      return { text: this.fromGridState(state), cursorR: r - 1, cursorC: ctx.run.c0 + caretK };
    }

    /** Clears the selected cells between a and b (a before b) that belong to `box`. */
    static clearRange(text, boxes, box, a, b) {
      const state = this.toGridState(text);
      for (let r = a.r; r <= b.r; r++) {
        if (r <= box.r1 || r >= box.r2) continue;
        const from = r === a.r ? a.c : box.c1 + 1;
        const to = r === b.r ? b.c : box.c2;
        if (a.r === b.r) {
          // Same row: delete and close the gap within the run
          const run = this.ownedRun(boxes, box, r, from);
          if (!run || to > run.end) return null;
          const line = this.readRun(state, r, run);
          this.writeRun(state, r, run, line.slice(0, from - run.c0) + line.slice(to - run.c0));
        } else {
          for (let c = from; c < to; c++) {
            const run = this.ownedRun(boxes, box, r, c + 1);
            if (run && c >= run.c0 && c < run.end) state.grid[r][c] = ' ';
          }
        }
      }
      return { text: this.fromGridState(state) };
    }

    /*************************************************************************
     * CONTEXT-MENU INSERTS: a connected shape or arrow on any side of a box
     *************************************************************************/

    /** Templates for shapes inserted from the context menu (odd widths: ports can be centred). */
    static shapeTemplate(kind) {
      if (kind === 'box') return { lines: ['+-------------+', '|  Component  |', '+-------------+'], label: 'Component' };
      if (kind === 'rbox') return { lines: ['/-------------\\', '|   Service   |', '\\-------------/'], label: 'Service' };
      if (kind === 'diamond') return { lines: this.diamondTemplate('Decision?'), label: 'Decision?' };
      return null;
    }

    /** A readable name for a box: legend key, label, or a container's own free-text label. */
    static boxName(ast, b) {
      if (b.macroKey) return `[${b.macroKey}]`;
      if (b.lines[0]) return b.lines[0];
      const inner = ast.freeTexts
        .filter((t) => t.r > b.r1 && t.r < b.r2 && t.c > b.c1 && t.c < b.c2 && t.text)
        .sort((a, b2) => a.r - b2.r || a.c - b2.c)[0];
      return inner ? inner.text : 'box';
    }

    /**
     * Which box sides a right-click at (r, c) is about:
     *  - on a box's wall: that side (a corner gives two); the innermost box wins;
     *  - inside a box that holds no other boxes: all four sides;
     *  - up to three cells outside a wall: the nearest box's side (so a click in a
     *    container's empty space next to a nested box means that nested box);
     *  - anywhere else, including a container's empty space: null ("insert here").
     * Returns { box, sides, name } or null.
     */
    static hitBoxSides(rawText, r, c) {
      const ast = new DitaaParser().parse(rawText);
      const area = (b) => (b.r2 - b.r1) * (b.c2 - b.c1);
      const boxes = ast.boxes.slice().sort((a, b) => area(a) - area(b));
      const out = (b, sides) => ({ box: b, sides, name: this.boxName(ast, b) });
      for (const b of boxes) {
        const inRows = r >= b.r1 && r <= b.r2, inCols = c >= b.c1 && c <= b.c2;
        const sides = [];
        if (inRows && c === b.c2) sides.push('right');
        if (inCols && r === b.r2) sides.push('below');
        if (inRows && c === b.c1) sides.push('left');
        if (inCols && r === b.r1) sides.push('above');
        if (sides.length) return out(b, sides);
      }
      const leaf = boxes.find((b) => !b.isContainer && r > b.r1 && r < b.r2 && c > b.c1 && c < b.c2);
      if (leaf) return out(leaf, ['right', 'below', 'left', 'above']);
      let best = null;
      for (const b of boxes) {
        const inRows = r >= b.r1 && r <= b.r2, inCols = c >= b.c1 && c <= b.c2;
        const cands = [];
        if (inRows && c > b.c2 && c <= b.c2 + 3) cands.push(['right', c - b.c2]);
        if (inRows && c < b.c1 && c >= b.c1 - 3) cands.push(['left', b.c1 - c]);
        if (inCols && r > b.r2 && r <= b.r2 + 2) cands.push(['below', r - b.r2]);
        if (inCols && r < b.r1 && r >= b.r1 - 2) cands.push(['above', b.r1 - r]);
        for (const [side, d] of cands) {
          if (!best || d < best.d || (d === best.d && area(b) < area(best.b))) best = { b, side, d };
        }
      }
      return best ? out(best.b, [best.side]) : null;
    }

    /**
     * Inserts a shape (kind 'box' | 'rbox' | 'diamond') or just an arrow (kind 'arrow') on
     * `side` of `box`, joined by an arrow from a '+' port at the middle of that wall.
     * Right/below: drawn straight into empty space; otherwise room is made like typing does
     * (columns on those lines / full rows), and an existing wire there is continued through
     * the new shape. Left/above: drawn only into empty space (blank rows/columns are added at
     * the very top/left edge of the diagram); if something is in the way the user is told how
     * to make room. Returns { text, cursorR, cursorC, selC1, selC2 } or { error }.
     */
    static insertConnected(rawText, box, side, kind, opts = {}) {
      const overwrite = !!opts.overwrite; // draw over whatever is there: no room is made
      const tpl = this.shapeTemplate(kind);
      const h = tpl ? tpl.lines.length : 0;
      const w = tpl ? tpl.lines[0].length : 0;
      const horiz = side === 'left' || side === 'right';
      const GAP = horiz ? 4 : 2; // cells of arrow between the two walls
      const state = this.toGridState(rawText);
      let b = { ...box };

      // If a wire already leaves this side, attach on its line so the new shape is spliced
      // into that connection; otherwise use the middle of the wall.
      const existingPort = () => {
        const g = state.grid;
        const cell = (r, c) => (g[r] && g[r][c]) || ' ';
        if (horiz) {
          const out = side === 'right' ? b.c2 + 1 : b.c1 - 1;
          for (let r = b.r1 + 1; r < b.r2; r++) if ('-=<>'.includes(cell(r, out)) && cell(r, out) !== ' ') return r;
        } else {
          const out = side === 'below' ? b.r2 + 1 : b.r1 - 1;
          for (let c = b.c1 + 1; c < b.c2; c++) if (wireV(g[out] || [], c)) return c;
        }
        return null;
      };
      const port0 = existingPort();
      const layout = () => {
        const midR = horiz && port0 !== null ? port0 + (b.r1 - box.r1) : Math.floor((b.r1 + b.r2) / 2);
        const midC = !horiz && port0 !== null ? port0 + (b.c1 - box.c1) : Math.floor((b.c1 + b.c2) / 2);
        const arrow = [];
        let port, shape = null, tip;
        if (side === 'right') {
          port = [midR, b.c2];
          for (let i = 1; i < GAP; i++) arrow.push([midR, b.c2 + i, '-']);
          tip = [midR, b.c2 + GAP, '>'];
          if (tpl) shape = { r0: midR - Math.floor(h / 2), c0: b.c2 + GAP + 1 };
        } else if (side === 'left') {
          port = [midR, b.c1];
          for (let i = 1; i < GAP; i++) arrow.push([midR, b.c1 - i, '-']);
          tip = [midR, b.c1 - GAP, '<'];
          if (tpl) shape = { r0: midR - Math.floor(h / 2), c0: b.c1 - GAP - w };
        } else if (side === 'below') {
          port = [b.r2, midC];
          for (let i = 1; i < GAP; i++) arrow.push([b.r2 + i, midC, '|']);
          tip = [b.r2 + GAP, midC, 'v'];
          if (tpl) shape = { r0: b.r2 + GAP + 1, c0: midC - Math.floor(w / 2) };
        } else {
          port = [b.r1, midC];
          for (let i = 1; i < GAP; i++) arrow.push([b.r1 - i, midC, '|']);
          tip = [b.r1 - GAP, midC, '^'];
          if (tpl) shape = { r0: b.r1 - GAP - h, c0: midC - Math.floor(w / 2) };
        }
        arrow.push(tip);
        return { port, arrow, shape, midR, midC };
      };
      const cellsOf = (L) => {
        const cells = L.arrow.map(([r, c]) => [r, c, true]);
        if (L.shape) {
          for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells.push([L.shape.r0 + r, L.shape.c0 + c, false]);
        }
        return cells;
      };
      const at = (r, c) => (r >= 0 && r < state.grid.length && c >= 0 && c < (state.grid[r] || []).length ? state.grid[r][c] : ' ');
      // Free: blank everywhere, except that a wire may already run where the arrow goes /
      // straight through the shape along the arrow's line (it then continues through it).
      const blocked = (L, lenient) => cellsOf(L).find(([r, c, onArrow]) => {
        const ch = at(r, c);
        if (ch === ' ') return false;
        if (!lenient) return true;
        const onLine = horiz ? r === L.midR : c === L.midC;
        const wireCh = horiz ? ch === '-' || ch === '=' : ch === '|' || ch === ':';
        return !(onLine && wireCh) && !(onArrow && wireCh);
      });

      let L = layout();
      // Left/above of a box inside a container whose own wall is in the way: the container
      // grows to make room, the way typing spaces (or Enter) before the box would.
      if (!overwrite && (side === 'left' || side === 'above')) {
        const encl = new DitaaParser().parse(this.fromGridState(state)).boxes
          .filter((p) => p.r1 < b.r1 && p.r2 > b.r2 && p.c1 < b.c1 && p.c2 > b.c2)
          .sort((p, q) => (p.r2 - p.r1) * (p.c2 - p.c1) - (q.r2 - q.r1) * (q.c2 - q.c1))[0];
        if (encl) {
          if (side === 'left') {
            const need = encl.c1 + 2 - Math.min(...cellsOf(L).map(([, c]) => c));
            if (need > 0) {
              this.insertColumns(state, Array(need).fill(b.c1), encl.r1, encl.r2);
              b = { ...b, c1: b.c1 + need, c2: b.c2 + need };
            }
          } else {
            const need = encl.r1 + 2 - Math.min(...cellsOf(L).map(([r]) => r));
            if (need > 0) {
              this.insertRowsMovingBoxes(state, b.r1, need, b);
              b = { ...b, r1: b.r1 + need, r2: b.r2 + need };
            }
          }
          L = layout();
        }
      }
      // Past the very top/left edge of the diagram: add blank rows/columns there (the whole
      // diagram moves, as the stamp buttons do)
      const minR = Math.min(...cellsOf(L).map(([r]) => r));
      const minC = Math.min(...cellsOf(L).map(([, c]) => c));
      if (minR < 0) {
        for (let i = 0; i < -minR; i++) state.grid.unshift(Array(state.cols).fill(' '));
        state.rows += -minR;
        b = { ...b, r1: b.r1 - minR, r2: b.r2 - minR };
      }
      if (minC < 0) {
        for (const row of state.grid) for (let i = 0; i < -minC; i++) row.unshift(' ');
        b = { ...b, c1: b.c1 - minC, c2: b.c2 - minC };
        this.normalizeWidth(state);
      }
      L = layout();
      if (overwrite) {
        // nothing to check: the user chose to write over what is there
      } else if (side === 'above' || side === 'left') {
        if (blocked(L, false)) {
          return {
            error: side === 'above'
              ? 'No room above: put the cursor on the line above the box and press Enter to make space'
              : 'No room on the left: type spaces before the box to make space'
          };
        }
      } else if (blocked(L, false)) {
        // Make room the way typing does, then allow a wire to continue through
        if (side === 'right') {
          const lo = Math.min(b.r1, L.shape ? L.shape.r0 : b.r1), hi = Math.max(b.r2, L.shape ? L.shape.r0 + h - 1 : b.r2);
          this.insertColumns(state, Array(GAP + w + (tpl ? 1 : 0)).fill(b.c2 + 1), Math.max(0, lo), hi);
        } else {
          this.insertRowsMovingBoxes(state, b.r2 + 1, GAP + h, b);
        }
        L = layout();
        const hit = blocked(L, true);
        if (hit) return { error: `Not enough room ${side === 'right' ? 'to the right' : 'below'}: something crosses that space (line ${hit[0] + 1})` };
      }

      // Draw: port, arrow, shape, and '+' where an arrow enters / a wire continues
      const put = (r, c, ch) => {
        while (state.grid.length <= r) state.grid.push([]);
        const row = state.grid[r];
        while (row.length <= c) row.push(' ');
        row[c] = ch;
      };
      const [pr, pc] = L.port;
      if ('-=|:'.includes(state.grid[pr][pc])) put(pr, pc, '+');
      for (const [r, c, ch] of L.arrow) put(r, c, ch);
      let sel = null;
      if (L.shape) {
        const { r0, c0 } = L.shape;
        tpl.lines.forEach((line, i) => [...line].forEach((ch, j) => put(r0 + i, c0 + j, ch)));
        if (!horiz) {
          const entryR = side === 'below' ? r0 : r0 + h - 1;
          if (state.grid[entryR][L.midC] === '-') put(entryR, L.midC, '+');
          const farR = side === 'below' ? r0 + h - 1 : r0, beyond = side === 'below' ? r0 + h : r0 - 1;
          if (state.grid[farR][L.midC] === '-' && wireV(state.grid[beyond] || [], L.midC)) put(farR, L.midC, '+');
        } else {
          const farC = side === 'right' ? c0 + w - 1 : c0, beyond = side === 'right' ? c0 + w : c0 - 1;
          const nb = (state.grid[L.midR] || [])[beyond] || ' ';
          if ('|:'.includes(state.grid[L.midR][farC]) && '-=+'.includes(nb) && nb !== ' ') put(L.midR, farC, '+');
        }
        const li = tpl.lines.findIndex((l) => l.includes(tpl.label));
        const lc = c0 + tpl.lines[li].indexOf(tpl.label);
        sel = { r: r0 + li, c1: lc, c2: lc + tpl.label.length };
      }
      this.normalizeWidth(state);
      const tip = L.arrow[L.arrow.length - 1];
      const res = sel
        ? { text: this.fromGridState(state), cursorR: sel.r, cursorC: sel.c2, selC1: sel.c1, selC2: sel.c2 }
        : { text: this.fromGridState(state), cursorR: tip[0], cursorC: tip[1] + (side === 'right' ? 1 : 0) };
      if (overwrite) return res;
      const checked = this.guardOtherBoxes(rawText, res, 'insert here', null, tpl ? 1 : 0);
      if (!checked.error && tpl &&
          new DitaaParser().parse(checked.text).boxes.length !== new DitaaParser().parse(rawText).boxes.length + 1) {
        return { error: 'Cannot insert here: the new shape would overlap something' };
      }
      return checked;
    }

    /** A shape with its top-left corner at (r, c), only if that space is empty. */
    static insertShapeAt(rawText, r, c, kind) {
      const tpl = this.shapeTemplate(kind);
      const state = this.toGridState(rawText, r + tpl.lines.length, c + tpl.lines[0].length);
      for (let i = 0; i < tpl.lines.length; i++) {
        for (let j = 0; j < tpl.lines[0].length; j++) {
          if ((state.grid[r + i][c + j] || ' ') !== ' ') return { error: 'Not enough empty space here for that shape' };
        }
      }
      tpl.lines.forEach((line, i) => [...line].forEach((ch, j) => { state.grid[r + i][c + j] = ch; }));
      const li = tpl.lines.findIndex((l) => l.includes(tpl.label));
      const lc = c + tpl.lines[li].indexOf(tpl.label);
      const res = { text: this.fromGridState(state), cursorR: r + li, cursorC: lc + tpl.label.length, selC1: lc, selC2: lc + tpl.label.length };
      return this.guardOtherBoxes(rawText, res, 'insert here', null, 1);
    }

    /*************************************************************************
     * PLAIN TEXT BLOCKS: overwrite typing and rectangular (block) selections.
     * These are text operations on lines and columns, with no box logic at all.
     *************************************************************************/

    static textLines(rawText) {
      return rawText.replace(/\r\n?/g, '\n').split('\n');
    }

    /** A block's lines, all padded to the same width (a ragged paste is still a rectangle). */
    static blockLines(block) {
      const lines = this.textLines(block);
      const w = Math.max(...lines.map((l) => l.length));
      return lines.map((l) => l.padEnd(w));
    }

    /** The text of the rectangle rows r1..r2, columns c1..c2 (inclusive), padded with spaces. */
    static blockText(rawText, b) {
      const lines = this.textLines(rawText);
      const out = [];
      for (let r = b.r1; r <= b.r2; r++) out.push((lines[r] || '').padEnd(b.c2 + 1).slice(b.c1, b.c2 + 1));
      return out.join('\n');
    }

    /**
     * Writes `block` over the text with its top-left at (r, c), replacing what was there
     * (overwrite typing and paste). Lines and columns are added as needed. The caret ends
     * after the last character written.
     */
    static overwriteBlock(rawText, r, c, block) {
      r = Math.max(0, r); c = Math.max(0, c);
      const lines = this.textLines(rawText);
      const bl = this.blockLines(block);
      bl.forEach((s, i) => {
        while (lines.length <= r + i) lines.push('');
        const l = lines[r + i].padEnd(c + s.length);
        lines[r + i] = (l.slice(0, c) + s + l.slice(c + s.length)).replace(/\s+$/, '');
      });
      return { text: lines.join('\n'), cursorR: r + bl.length - 1, cursorC: c + bl[bl.length - 1].length };
    }

    /** Inserts `block` as columns at (r, c) on consecutive lines: text to its right moves over. */
    static insertBlock(rawText, r, c, block) {
      r = Math.max(0, r); c = Math.max(0, c);
      const lines = this.textLines(rawText);
      const bl = this.blockLines(block);
      bl.forEach((s, i) => {
        while (lines.length <= r + i) lines.push('');
        const l = lines[r + i].padEnd(c);
        lines[r + i] = (l.slice(0, c) + s + l.slice(c)).replace(/\s+$/, '');
      });
      return { text: lines.join('\n'), cursorR: r + bl.length - 1, cursorC: c + bl[bl.length - 1].length };
    }

    /** Number of diagram lines: the text without the trailing legend / comment block. */
    static diagramLineCount(rawText) {
      const lines = this.textLines(rawText);
      let k = lines.length;
      while (k > 0 && (lines[k - 1].trim() === '' || DitaaParser.isLegendOrCommentLine(lines[k - 1]))) k--;
      return k;
    }

    /**
     * What a block selection is: b.kind when it was chosen (Select row / column / box), else
     * 'rows' when it reaches past the end of the diagram's longest line from the left edge
     * (whole lines), 'cols' when it reaches past the diagram's last line from the top (whole
     * columns), else 'rect'. Just covering a box that happens to span the diagram is a rect.
     */
    static blockKind(rawText, b) {
      if (b.kind) return b.kind;
      const n = this.diagramLineCount(rawText);
      const width = Math.max(1, ...this.textLines(rawText).slice(0, n).map((l) => l.length));
      if (b.c1 === 0 && b.c2 >= width) return 'rows';
      if (b.r1 === 0 && b.r2 >= n && n > 0) return 'cols';
      return 'rect';
    }

    /** The rectangle to copy for a block: whole lines for rows, the diagram's lines for columns. */
    static blockCopy(rawText, b) {
      const kind = this.blockKind(rawText, b);
      let text;
      if (kind === 'rows') {
        text = this.textLines(rawText).slice(b.r1, b.r2 + 1).map((l) => l.replace(/\s+$/, '')).join('\n');
      } else if (kind === 'cols') {
        text = this.blockText(rawText, { ...b, r2: Math.min(b.r2, this.diagramLineCount(rawText) - 1) });
      } else {
        text = this.blockText(rawText, b);
      }
      return { text, kind };
    }

    /**
     * Inserts whole lines before line r: everything from line r down moves down, so vertical
     * lines in a copied row carry straight on. The caret goes to the first line inserted.
     */
    static insertTextRows(rawText, r, block, c = 0) {
      const lines = this.textLines(rawText);
      const add = this.textLines(block).map((l) => l.replace(/\s+$/, ''));
      while (lines.length < r) lines.push('');
      lines.splice(r, 0, ...add);
      return { text: lines.join('\n'), cursorR: r, cursorC: c };
    }

    /** Removes lines r1..r2: everything below moves up. */
    static deleteTextRows(rawText, r1, r2) {
      const lines = this.textLines(rawText);
      lines.splice(r1, r2 - r1 + 1);
      if (!lines.length) lines.push(''); // an empty text still has a line for the caret
      return { text: lines.join('\n'), cursorR: Math.max(0, Math.min(r1, lines.length - 1)), cursorC: 0 };
    }

    /**
     * Pastes a copied block in insert mode: rows go in as whole lines before line r, columns
     * as whole columns at column c on every diagram line (so horizontal lines through them
     * carry straight on), and a rectangle as columns at (r, c) on consecutive lines.
     */
    static pasteBlockInsert(rawText, r, c, block, kind) {
      if (kind === 'rows') return this.insertTextRows(rawText, r, block, c);
      if (kind === 'cols') {
        const fit = this.fitColumnsToDiagram(rawText, block, true);
        return { ...this.insertBlock(fit.text, 0, c, fit.block), cursorR: r, cursorC: c };
      }
      return this.insertBlock(rawText, r, c, block);
    }

    /** Pastes a copied block in overwrite mode: rows over whole lines from line r, columns from the top. */
    static pasteBlockOverwrite(rawText, r, c, block, kind) {
      if (kind === 'rows') return { ...this.overwriteBlock(rawText, r, 0, block), cursorR: r, cursorC: c };
      if (kind === 'cols') {
        const fit = this.fitColumnsToDiagram(rawText, block, false);
        return { ...this.overwriteBlock(fit.text, 0, c, fit.block), cursorR: r, cursorC: c };
      }
      return this.overwriteBlock(rawText, r, c, block);
    }

    /**
     * Whole columns go into the destination's diagram lines only, never its legend / comment
     * lines: a taller block uses the blank lines below the diagram, then gets more blank
     * lines added above that footer. With `pad`
     * (insert mode) a shorter block is padded with blanks so every diagram line shifts
     * together and stays aligned.
     */
    static fitColumnsToDiagram(rawText, block, pad) {
      const lines = this.textLines(rawText);
      const n = this.diagramLineCount(rawText);
      const bl = this.blockLines(block);
      if (bl.length > n) {
        // Blank lines right below the diagram (e.g. the rows a cut column left empty) are
        // reused first, so cutting columns and pasting them back gives back the same text
        let blank = 0;
        while (n + blank < lines.length && lines[n + blank].trim() === '') blank++;
        const add = bl.length - n - Math.min(blank, bl.length - n);
        if (add > 0) lines.splice(n + blank, 0, ...Array(add).fill(''));
      }
      if (pad) while (bl.length < n) bl.push(' '.repeat(bl[0].length));
      return { text: lines.join('\n'), block: bl.join('\n') };
    }

    /** Cut / Delete of a block: insert mode removes the room it took (lines, columns), overwrite mode blanks it. */
    static removeBlock(rawText, b, overwrite) {
      if (overwrite) return this.clearBlock(rawText, b);
      const kind = this.blockKind(rawText, b);
      if (kind === 'rows') return this.deleteTextRows(rawText, b.r1, Math.min(b.r2, this.textLines(rawText).length - 1));
      if (kind === 'cols') return this.deleteBlock(rawText, { ...b, r2: Math.min(b.r2, this.diagramLineCount(rawText) - 1) });
      return this.deleteBlock(rawText, b);
    }

    /**
     * Inserts a line before line `at` (diagram lines only) that carries vertical lines and box
     * walls straight through it, so nothing above and below comes apart. An arrowhead that
     * touched what is below keeps touching it (it moves down into the new line).
     */
    static insertContinuingRow(lines, at) {
      const A = lines[at - 1] || '', B = lines[at] || '';
      const w = Math.max(A.length, B.length);
      const row = [];
      const up = [...A], down = [...B];
      for (let c = 0; c < w; c++) {
        const a = A[c] || ' ', b = B[c] || ' ';
        const dashed = a === ':' || b === ':';
        if (a === 'v' && '-=+'.includes(b) && b !== ' ') { row.push('v'); up[c] = dashed ? ':' : '|'; continue; }
        if (b === '^' && '-=+'.includes(a) && a !== ' ') { row.push('^'); down[c] = dashed ? ':' : '|'; continue; }
        const vertA = '|:+*v^'.includes(a) && a !== ' ', vertB = '|:+*v^'.includes(b) && b !== ' ';
        const line = '|:'.includes(a) || '|:'.includes(b);
        // a vertical line that ends on a horizontal wall (or leaves one) stays on it
        const meets = (('|:'.includes(a) && '-='.includes(b)) || ('-='.includes(a) && '|:'.includes(b)) ||
          ('-=+'.includes(a) && b === 'v') || (a === '^' && '-=+'.includes(b))) && a !== ' ' && b !== ' ';
        row.push((vertA && vertB && line && a !== 'v' && b !== '^') || meets ? (dashed ? ':' : '|') : ' ');
      }
      if (at > 0) lines[at - 1] = up.join('');
      if (at < lines.length) lines[at] = down.join('');
      lines.splice(at, 0, row.join('').replace(/\s+$/, ''));
    }

    /**
     * Inserts a column before column `at` on lines 0..n-1 that carries horizontal lines and
     * box walls through. On lines outside `keep` ({ lo, hi }) the gap never changes a label:
     * inside a box whose line holds only text, it goes after that line's text (the label is
     * kept verbatim and the box's right wall still moves over with the rest of the box); in
     * free text, after the whole phrase (words, punctuation and single spaces).
     */
    static insertContinuingColumn(lines, at, n, keep = null) {
      let roleAt = () => 'empty', boxes = [];
      if (keep) {
        const ast = new DitaaParser().parse(lines.join('\n'));
        roleAt = (r, c) => (ast.cellRole[r] && ast.cellRole[r][c]) || 'empty';
        boxes = ast.boxes.slice().sort((p, q) => (p.r2 - p.r1) * (p.c2 - p.c1) - (q.r2 - q.r1) * (q.c2 - q.c1));
      }
      const plain = (r, c) => { const ro = roleAt(r, c); return ro !== 'box-border' && !ro.startsWith('wire'); };
      for (let r = 0; r < n; r++) {
        const l = (lines[r] || '').padEnd(at);
        if (keep && (r < keep.lo || r > keep.hi)) {
          const gap = (x) => { lines[r] = (l.slice(0, x) + ' ' + l.slice(x)).replace(/\s+$/, ''); };
          const box = boxes.find((b) => r > b.r1 && r < b.r2 && at > b.c1 && at < b.c2);
          if (box) {
            let textOnly = true, last = -1;
            for (let c = box.c1 + 1; c < box.c2; c++) {
              if (!plain(r, c)) textOnly = false;
              if ((l[c] || ' ') !== ' ') last = c;
            }
            if (textOnly) { gap(Math.max(at, last + 1)); continue; }
          } else {
            const text = (c) => (l[c] || ' ') !== ' ' && plain(r, c);
            if (text(at - 1) && (text(at) || (l[at] === ' ' && text(at + 1)))) {
              let x = at;
              while (text(x) || (l[x] === ' ' && text(x + 1))) x++;
              gap(x);
              continue;
            }
          }
        }
        const a = l[at - 1] || ' ', b = l[at] || ' ';
        const dashed = a === '=' || b === '=';
        let ch = ' ', left = l.slice(0, at), right = l.slice(at);
        if (a === '>' && '|:+'.includes(b) && b !== ' ') { ch = '>'; left = left.slice(0, -1) + (dashed ? '=' : '-'); }
        else if (b === '<' && '|:+'.includes(a) && a !== ' ') { ch = '<'; right = (dashed ? '=' : '-') + right.slice(1); }
        else {
          const hA = '-=+*<>'.includes(a) && a !== ' ', hB = '-=+*<>'.includes(b) && b !== ' ';
          // a horizontal line that ends on a vertical wall (or leaves one) stays on it
          const meets = (('-='.includes(a) && '|:'.includes(b)) || ('|:'.includes(a) && '-='.includes(b)) ||
            ('|:+'.includes(a) && b === '>') || (a === '<' && '|:+'.includes(b))) && a !== ' ' && b !== ' ';
          if ((hA && hB && ('-='.includes(a) || '-='.includes(b)) && a !== '>' && b !== '<') || meets) ch = dashed ? '=' : '-';
        }
        lines[r] = (left + ch + right).replace(/\s+$/, '');
      }
    }

    /**
     * Draws a box on the border of rectangle b. Where a line crosses the border the
     * crossing becomes '+', so the line stays joined. With `wrap` (insert mode) room is
     * made first: a line above and below and a column either side, continuing the lines
     * and walls that cross them, so the box goes around b without covering anything (one
     * more on a side where an arrow points in, so its arrowhead still touches what it did).
     * Otherwise (overwrite mode) the border is drawn over what is on b's edge.
     * opts: { wrap, rounded }. Returns { text, cursorR, cursorC, box }.
     */
    static drawBoxAround(rawText, b, opts = {}) {
      const lines = this.textLines(rawText);
      let { r1, c1, r2, c2 } = b;
      if (opts.wrap) {
        const n = Math.max(this.diagramLineCount(rawText), r2 + 1);
        while (lines.length < n) lines.push('');
        const ch = (r, c) => (c < 0 ? '#' : r < 0 ? ' ' : (lines[r] || '')[c] || ' ');
        const has = (s, x) => x !== ' ' && s.includes(x);
        // A side needs one more line / column where a line points in at something on the
        // block's edge (an arrowhead, or a plain line ending on a wall or '+'), so the border
        // can cross it with a '+' and a piece of the line still reaches what it reached.
        let top = 1, bottom = 1, left = 1, right = 1;
        for (let c = c1; c <= c2; c++) {
          if (ch(r1 - 1, c) === 'v' || (has('|:^', ch(r1 - 1, c)) && has('-=+', ch(r1, c)))) top = 2;
          if (ch(r2 + 1, c) === '^' || (has('|:v', ch(r2 + 1, c)) && has('-=+', ch(r2, c)))) bottom = 2;
        }
        for (let r = r1; r <= r2; r++) {
          if (ch(r, c1 - 1) === '>' || (has('-=<', ch(r, c1 - 1)) && has('|:+', ch(r, c1)))) left = 2;
          if (ch(r, c2 + 1) === '<' || (has('-=>', ch(r, c2 + 1)) && has('|:+', ch(r, c2)))) right = 2;
        }
        // Empty space already there is used as it is: a side only gets new lines / columns
        // when its border would land on something other than space or a line it can cross
        const free = (rs, cs, ok) => {
          for (let r = rs[0]; r <= rs[1]; r++) for (let c = cs[0]; c <= cs[1]; c++) if (!' '.concat(ok).includes(ch(r, c))) return false;
          return true;
        };
        const rows = [r1 - top, r2 + bottom], cols = [c1 - left, c2 + right];
        // ...and a line the border crosses must keep a piece outside it too, or whatever it
        // came from would end up touching the border instead of the line
        const outsideH = (c, o) => { for (let r = rows[0]; r <= rows[1]; r++) if (has('-=', ch(r, c)) && !' -='.includes(ch(r, o))) return false; return true; };
        const outsideV = (r, o) => { for (let c = cols[0]; c <= cols[1]; c++) if (has('|:', ch(r, c)) && !' |:'.includes(ch(o, c))) return false; return true; };
        const localL = free(rows, [c1 - left, c1 - 1], '-=>') && outsideH(c1 - left, c1 - left - 1);
        const localR = free(rows, [c2 + 1, c2 + right], '-=<') && outsideH(c2 + right, c2 + right + 1);
        const localT = r1 - top >= 0 && free([r1 - top, r1 - 1], cols, '|:v') && outsideV(r1 - top, r1 - top - 1);
        const localB = free([r2 + 1, r2 + bottom], cols, '|:^') && outsideV(r2 + bottom, r2 + bottom + 1);
        // Rows that become part of the new box as they are; every other row keeps its labels
        // (rows the border will get are made later, so the lines above / below are "other")
        const keep = { lo: localT ? r1 - top : r1, hi: localB ? r2 + bottom : r2 };
        if (!localR) for (let i = 0; i < right; i++) this.insertContinuingColumn(lines, c2 + 1 + i, n, keep);
        if (!localL) for (let i = 0; i < left; i++) this.insertContinuingColumn(lines, c1, n, keep);
        const L = localL ? 0 : left;
        if (!localB) for (let i = 0; i < bottom; i++) this.insertContinuingRow(lines, r2 + 1 + i);
        if (!localT) for (let i = 0; i < top; i++) this.insertContinuingRow(lines, r1);
        const T = localT ? 0 : top;
        r1 += T - top; r2 += T + bottom; c1 += L - left; c2 += L + right;
      }
      if (r2 - r1 < 1 || c2 - c1 < 1) return { error: 'Select at least 2×2 characters to draw a box' };
      const get = (r, c) => (lines[r] || '')[c] || ' ';
      const put = (r, c, ch) => {
        while (lines.length <= r) lines.push('');
        const l = lines[r].padEnd(c + 1);
        lines[r] = l.slice(0, c) + ch + l.slice(c + 1);
      };
      const corner = opts.rounded ? ['/', '\\', '\\', '/'] : ['+', '+', '+', '+'];
      for (let c = c1 + 1; c < c2; c++) {
        for (const r of [r1, r2]) put(r, c, '|:v^+'.includes(get(r, c)) && get(r, c) !== ' ' ? '+' : '-');
      }
      for (let r = r1 + 1; r < r2; r++) {
        for (const c of [c1, c2]) put(r, c, '-=<>+'.includes(get(r, c)) && get(r, c) !== ' ' ? '+' : '|');
      }
      put(r1, c1, corner[0]); put(r1, c2, corner[1]); put(r2, c1, corner[2]); put(r2, c2, corner[3]);
      const text = lines.map((l) => l.replace(/\s+$/, '')).join('\n');
      return { text, cursorR: r1 + 1, cursorC: c1 + 2, box: { r1, c1, r2, c2 } };
    }

    /**
     * Moves the characters of block b by one cell (dr, dc) together: they are lifted, the
     * cells they leave become blank, and they are put down one cell over. Nothing else moves,
     * with two obvious exceptions: a line attached to the block on the side it moves away
     * from stretches to follow it (an arrowhead moves along), and a line the block moves
     * into along its length gets one cell shorter (as long as some of it is left).
     * Anything else in the way: overwrite mode writes over it; insert mode makes room going
     * right or down (a column / line is made before the block, carrying the lines and walls
     * through and keeping labels elsewhere intact) and refuses left or up.
     * Returns { text, cursorR, cursorC, block } or { error }.
     */
    static moveBlock(rawText, b, dr, dc, opts = {}) {
      if (b.r1 + dr < 0) return { error: 'The block is at the top already: move the rest down instead' };
      if (b.c1 + dc < 0) return { error: 'The block is at the left edge already: move the rest right instead' };
      const lines = this.textLines(rawText);
      const get = (r, c) => (r < 0 || c < 0 ? ' ' : (lines[r] || '')[c] || ' ');
      const inside = (r, c) => r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;
      // Only what the parser reads as a line counts as one (a 'v' or '-' in prose is text)
      const roles = new DitaaParser().parse(rawText).cellRole;
      const wire = (r, c) => r >= 0 && c >= 0 && /^wire/.test((roles[r] && roles[r][c]) || '');
      const edge = (ch) => ch !== ' ' && '|:+-=<>^v/\\*'.includes(ch);
      const along = dc ? '-=<>' : '|:^v'; // line characters running the way the block moves
      const isAlong = (r, c) => { const ch = get(r, c); return ch !== ' ' && along.includes(ch) && wire(r, c); };
      let blocked = false;
      const heads = []; // arrowheads of lines that get shorter: they step back along their line
      // (the whole leading edge is checked, so in OVR every shortened line keeps its arrowhead)
      for (let r = b.r1 + dr; r <= b.r2 + dr; r++) {
        for (let c = b.c1 + dc; c <= b.c2 + dc; c++) {
          if (inside(r, c)) continue;
          const ch = get(r, c);
          if (ch === ' ') continue;
          // A line attached to the block's edge, running on past this cell: it gets shorter
          if (isAlong(r, c) && isAlong(r + dr, c + dc) && edge(get(r - dr, c - dc))) {
            if ('<>^v'.includes(ch)) heads.push([r + dr, c + dc, ch]);
            continue;
          }
          blocked = true;
        }
      }
      const moved = { r1: b.r1 + dr, c1: b.c1 + dc, r2: b.r2 + dr, c2: b.c2 + dc };
      const done = (text) => ({ text, cursorR: moved.r1, cursorC: moved.c1, block: moved });
      if (blocked && !opts.overwrite) {
        if (dr < 0 || dc < 0) {
          return { error: `Something is in the way ${dr < 0 ? 'above' : 'on the left'}: move it first, or switch to OVR to move over it` };
        }
        const n = Math.max(this.diagramLineCount(rawText), b.r2 + 1);
        while (lines.length < n) lines.push('');
        if (dc > 0) this.insertContinuingColumn(lines, b.c1, n, { lo: b.r1, hi: b.r2 });
        else this.insertContinuingRow(lines, b.r1);
        return done(lines.map((l) => l.replace(/\s+$/, '')).join('\n'));
      }
      const block = this.blockText(rawText, b);
      const out = this.textLines(this.overwriteBlock(this.clearBlock(rawText, b).text, moved.r1, moved.c1, block).text);
      const put = (r, c, ch) => {
        while (out.length <= r) out.push('');
        const l = out[r].padEnd(c + 1);
        out[r] = l.slice(0, c) + ch + l.slice(c + 1);
      };
      for (const [r, c, ch] of heads) put(r, c, ch);
      // Lines attached on the side the block moved away from follow it across the gap: an
      // arrowhead pointing at the block moves up to it; any other line end (a shaft, an
      // arrowhead pointing away, a junction) gets a piece of shaft to reach it
      const fill = (o, dashed) => (dc ? (o === '=' || dashed ? '=' : '-') : (o === ':' || dashed ? ':' : '|'));
      const toward = dc > 0 ? '>' : dc < 0 ? '<' : dr > 0 ? 'v' : '^';
      const ends = dc ? '-=+*<>' : '|:+*^v';
      for (let i = dc ? b.r1 : b.c1; i <= (dc ? b.r2 : b.c2); i++) {
        const [or, oc] = dc ? [i, dc > 0 ? b.c1 - 1 : b.c2 + 1] : [dr > 0 ? b.r1 - 1 : b.r2 + 1, i];
        const [gr, gc] = dc ? [i, dc > 0 ? b.c1 : b.c2] : [dr > 0 ? b.r1 : b.r2, i];
        const [nr, nc] = [gr + dr, gc + dc];
        const o = get(or, oc), e = (out[nr] || '')[nc] || ' ';
        if (o === ' ' || !ends.includes(o) || !wire(or, oc) || !edge(e)) continue;
        if (o === toward) {
          put(gr, gc, o);
          put(or, oc, fill(get(or - dr, oc - dc)));
        } else {
          put(gr, gc, fill(o, get(or - dr, oc - dc) === (dc ? '=' : ':')));
        }
      }
      return done(out.map((l) => l.replace(/\s+$/, '')).join('\n'));
    }

    /** Blanks the rectangle (overwrite mode cut / delete): nothing else moves. */
    static clearBlock(rawText, b) {
      const blank = Array(b.r2 - b.r1 + 1).fill(' '.repeat(b.c2 - b.c1 + 1)).join('\n');
      return { ...this.overwriteBlock(rawText, b.r1, b.c1, blank), cursorR: b.r1, cursorC: b.c1 };
    }

    /** Removes the rectangle's columns from its lines (insert mode cut / delete): text to its right moves left. */
    static deleteBlock(rawText, b) {
      const lines = this.textLines(rawText);
      for (let r = b.r1; r <= b.r2 && r < lines.length; r++) {
        const l = lines[r];
        lines[r] = (l.slice(0, b.c1) + l.slice(b.c2 + 1)).replace(/\s+$/, '');
      }
      return { text: lines.join('\n'), cursorR: b.r1, cursorC: b.c1 };
    }

    /*************************************************************************
     * CONNECTIONS: '+' endpoints on box walls, joined by a routed line
     *************************************************************************/

    /**
     * The wall cell of `box` nearest to (r, c) on one of `sides` (corners excluded), and
     * the side it is on. Returns { r, c, side } or null for a box too small to have one.
     */
    static nearestWallCell(box, sides, r, c) {
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      let best = null;
      for (const side of sides) {
        let cell;
        if (side === 'right' || side === 'left') {
          if (box.r2 - box.r1 < 2) continue;
          cell = { r: clamp(r, box.r1 + 1, box.r2 - 1), c: side === 'right' ? box.c2 : box.c1 };
        } else {
          if (box.c2 - box.c1 < 2) continue;
          cell = { r: side === 'below' ? box.r2 : box.r1, c: clamp(c, box.c1 + 1, box.c2 - 1) };
        }
        const d = Math.abs(cell.r - r) + Math.abs(cell.c - c);
        if (!best || d < best.d) best = { ...cell, side, d };
      }
      return best && { r: best.r, c: best.c, side: best.side };
    }

    /**
     * Puts a connection point '+' on the wall of `hit.box` nearest to (r, c).
     * Returns { text, cursorR, cursorC, port: { r, c } } or { error }.
     */
    static placePort(rawText, hit, r, c) {
      const cell = this.nearestWallCell(hit.box, hit.sides, r, c);
      if (!cell) return { error: 'This box is too small for a connection point there' };
      const state = this.toGridState(rawText);
      const ch = state.grid[cell.r][cell.c];
      if (!'-=|:+'.includes(ch) || ch === ' ') return { error: 'A connection point can only go on a straight part of a wall' };
      state.grid[cell.r][cell.c] = '+';
      const res = { text: this.fromGridState(state), cursorR: cell.r, cursorC: cell.c, port: { r: cell.r, c: cell.c } };
      return this.guardOtherBoxes(rawText, res, 'place a connection point');
    }

    /**
     * "Connect to here": draws a connection from the point `a` to the wall of `hit.box` near
     * (r, c). The end point goes on the wall cell nearest the click; if no clean route reaches
     * that cell, the next nearest cells on the same wall are tried. Returns the
     * connectPorts result for the first one that works, or the first error.
     */
    static connectToWall(rawText, a, hit, r, c, opts = {}) {
      const b = hit.box;
      const cells = [];
      for (const side of hit.sides) {
        if (side === 'right' || side === 'left') {
          for (let rr = b.r1 + 1; rr < b.r2; rr++) cells.push({ r: rr, c: side === 'right' ? b.c2 : b.c1 });
        } else {
          for (let cc = b.c1 + 1; cc < b.c2; cc++) cells.push({ r: side === 'below' ? b.r2 : b.r1, c: cc });
        }
      }
      cells.sort((p, q) => (Math.abs(p.r - r) + Math.abs(p.c - c)) - (Math.abs(q.r - r) + Math.abs(q.c - c)));
      let firstError = null;
      for (const cell of cells.slice(0, 16)) {
        const res = this.connectPorts(rawText, a, cell, opts);
        if (!res.error) return res;
        firstError = firstError || res;
      }
      return firstError || { error: 'Put the end point on a straight part of a box wall' };
    }

    /**
     * Where a click near (r, c) puts a connection end: on a box wall when the click is on a
     * wall, right next to one, or inside a (non-container) box; otherwise on the line or the
     * empty cell clicked. Returns { kind: 'wall', hit } | { kind: 'wire' | 'free' } | null.
     */
    static connectionTarget(rawText, r, c) {
      const ast = new DitaaParser().parse(rawText);
      const g = this.toGridState(rawText, r + 1, c + 1).grid;
      const kind = this.endpointKind(ast, g, { r, c });
      if (kind === 'wire') return { kind };
      const hit = this.hitBoxSides(rawText, r, c);
      if (hit) {
        const w = this.nearestWallCell(hit.box, hit.sides, r, c);
        const inLeaf = !hit.box.isContainer && r > hit.box.r1 && r < hit.box.r2 && c > hit.box.c1 && c < hit.box.c2;
        if (w && (inLeaf || Math.abs(w.r - r) + Math.abs(w.c - c) <= 1)) return { kind: 'wall', hit };
      }
      return kind === 'free' ? { kind } : null;
    }

    /**
     * "Start connection here": on a wall a '+' port is placed; on a line or empty space
     * nothing changes yet. Returns { text, cursorR, cursorC, port } or { error }.
     */
    static startConnection(rawText, r, c) {
      const t = this.connectionTarget(rawText, r, c);
      if (!t) return { error: 'Start a connection on a box wall, a line or empty space (not on text)' };
      if (t.kind === 'wall') return this.placePort(rawText, t.hit, r, c);
      return { text: rawText, cursorR: r, cursorC: c, port: { r, c } };
    }

    /** "Connect to here": finishes a connection from `a` at the place clicked. */
    static connectTo(rawText, a, r, c, opts = {}) {
      const t = this.connectionTarget(rawText, r, c);
      if (!t) return { error: 'End the connection on a box wall, a line or empty space (not on text)' };
      if (t.kind === 'wall') return this.connectToWall(rawText, a, t.hit, r, c, opts);
      return this.connectPorts(rawText, a, { r, c }, opts);
    }

    /** Directions a line can leave a wall point in: outward, and inward for a container. */
    static portDirections(boxes, r, c) {
      const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // up right down left
      const out = [];
      for (const b of boxes) {
        const corner = (r === b.r1 || r === b.r2) && (c === b.c1 || c === b.c2);
        if (corner || r < b.r1 || r > b.r2 || c < b.c1 || c > b.c2) continue;
        let d = -1;
        if (r === b.r1) d = 0;
        else if (c === b.c2) d = 1;
        else if (r === b.r2) d = 2;
        else if (c === b.c1) d = 3;
        if (d === -1) continue;
        out.push({ d, box: b });
        if (b.isContainer) out.push({ d: (d + 2) % 4, box: b });
      }
      return out.map((x) => x.d).filter((d, i, a) => a.indexOf(d) === i).map((d) => ({ d, delta: DIRS[d] }));
    }

    /**
     * What a connection endpoint at p is: 'wall' (a straight part of a box wall), 'wire' (a
     * cell of an existing line, which the new line joins), 'free' (an empty cell: the line
     * starts or ends right there) or null (text, or a box corner).
     */
    static endpointKind(ast, grid, p) {
      const ro = (ast.cellRole[p.r] && ast.cellRole[p.r][p.c]) || 'empty';
      const ch = (grid[p.r] && grid[p.r][p.c]) || ' ';
      if (ro === 'box-border') return this.portDirections(ast.boxes, p.r, p.c).length && '-=|:+'.includes(ch) ? 'wall' : null;
      if (ro.startsWith('wire-')) return 'wire';
      return ch === ' ' ? 'free' : null;
    }

    /**
     * Draws a connection from `a` to `b` ({ r, c } cells). Each end can be on a box wall
     * (it becomes a '+' port), on an existing line (the new line joins it: a '+' where it
     * meets the line from the side, or it just continues a line end) or in empty space (the
     * line starts / ends right there). The line is routed with horizontal and vertical
     * segments, leaving and entering walls at right angles, around boxes and text. It may
     * cross a container's wall (that cell becomes '+') or, when there is no other way,
     * another line (the crossing becomes '+'); both cost extra, as do turns, so it prefers
     * clean routes. The arrowhead (opts.arrow) goes on the end unless it joins a line.
     * opts: { dashed, arrow }. Returns { text, cursorR, cursorC } or { error }.
     */
    static connectPorts(rawText, a, b, opts = {}) {
      const parser = new DitaaParser();
      const ast0 = parser.parse(rawText);
      const g0 = this.toGridState(rawText).grid;
      const kindA = this.endpointKind(ast0, g0, a);
      const kindB = this.endpointKind(ast0, g0, b);
      if (!kindA) return { error: 'The start point is no longer on a wall, a line or empty space: start the connection again' };
      if (!kindB) return { error: 'End the connection on a box wall, a line or empty space (not on text or a corner)' };
      if (a.r === b.r && a.c === b.c) return { error: 'Pick a different point to connect to' };
      const ALL = [0, 1, 2, 3].map((d) => ({ d, delta: [[-1, 0], [0, 1], [1, 0], [0, -1]][d] }));
      const startDirs = kindA === 'wall' ? this.portDirections(ast0.boxes, a.r, a.c) : ALL;
      const endDirs = kindB === 'wall' ? this.portDirections(ast0.boxes, b.r, b.c) : ALL;

      // The search grid must hold both ends (a free end can be past the text), or cell keys alias
      const R = Math.max(ast0.numRows, a.r + 1, b.r + 1) + 8;
      const C = Math.max(ast0.numCols, a.c + 1, b.c + 1) + 40;
      const state = this.toGridState(rawText, R, C);
      const g = state.grid;
      if (kindB === 'wall') g[b.r][b.c] = '+';
      const ast = parser.parse(this.fromGridState(state));
      const role = (r, c) => (ast.cellRole[r] && ast.cellRole[r][c]) || 'empty';
      const owners = new Map();
      for (const bx of ast.boxes) {
        for (let r = bx.r1; r <= bx.r2; r++) for (let c = bx.c1; c <= bx.c2; c++) {
          if (r !== bx.r1 && r !== bx.r2 && c !== bx.c1 && c !== bx.c2) continue;
          const k = r * C + c;
          if (!owners.has(k)) owners.set(k, []);
          owners.get(k).push(bx);
        }
      }
      const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
      const horiz = (d) => d === 1 || d === 3;
      // Wall and line ends are entered from beside them; a free end is part of the route
      const isEnd = (r, c) => (r === a.r && c === a.c) || (kindB !== 'free' && r === b.r && c === b.c);
      // cost of entering (r, c) moving in direction d; crossing cells can't be turned on
      const enter = (r, c, d) => {
        if (r < 0 || c < 0 || r >= R || c >= C || isEnd(r, c)) return null;
        const ch = g[r][c] || ' ';
        const ro = role(r, c);
        if (ro === 'empty') return ch === ' ' ? { cost: 1, cross: false } : null;
        if (ro === 'box-border') {
          const own = owners.get(r * C + c) || [];
          if (!own.length || !own.every((bx) => bx.isContainer)) return null;
          for (const bx of own) {
            const corner = (r === bx.r1 || r === bx.r2) && (c === bx.c1 || c === bx.c2);
            const hWall = r === bx.r1 || r === bx.r2;
            if (corner || hWall === horiz(d)) return null; // only straight across a wall
          }
          return { cost: 8, cross: true };
        }
        // Crossing another line: the '+' joins all four ways, so never right next to a wall
        // (it would look attached to that box)
        const wallBeside = (dr, dc) => role(r + dr, c + dc) === 'box-border' || role(r - dr, c - dc) === 'box-border';
        if (ro === 'wire-h' && (ch === '-' || ch === '=') && !horiz(d) && !wallBeside(0, 1)) return { cost: 25, cross: true };
        if (ro === 'wire-v' && (ch === '|' || ch === ':') && horiz(d) && !wallBeside(1, 0)) return { cost: 25, cross: true };
        return null;
      };
      // Prefer open space: cells right next to a box cost a little more
      const nearWall = (r, c) => DIRS.some(([dr, dc]) => !isEnd(r + dr, c + dc) && role(r + dr, c + dc) === 'box-border');

      // A turn is drawn '+', which joins all four neighbours: it must not touch a wall other
      // than the two endpoints, or the line would look attached to that box.
      // It must not touch an existing line either (a wire cell that would join it from
      // that side), except the route's own previous / next cells.
      const joinsFrom = (nr, nc, k) => {
        const ro = role(nr, nc), ch = g[nr] ? g[nr][nc] : ' ';
        if (ro === 'wire-corner' || ro === 'wire-junction') return true;
        if (k === 1 || k === 3) return ro === 'wire-h' || (ro === 'wire-arrow' && (ch === '<' || ch === '>'));
        return ro === 'wire-v' || (ro === 'wire-arrow' && (ch === '^' || ch === 'v'));
      };
      const cornerOk = (r, c, d, nd) => DIRS.every(([dr, dc], k) => {
        const nr = r + dr, nc = c + dc;
        if (isEnd(nr, nc)) return true;
        if (k === (d + 2) % 4 || k === nd) return true; // where the route comes from / goes to
        return role(nr, nc) !== 'box-border' && !joinsFrom(nr, nc, k);
      });
      // Dijkstra over (cell, direction)
      const TURN = 3;
      const key = (r, c, d) => (r * C + c) * 4 + d;
      const dist = new Map(), prev = new Map(), crossAt = new Set();
      const heap = [];
      const push = (cost, r, c, d) => {
        heap.push([cost, r, c, d]);
        let i = heap.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
      };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, rr = l + 1;
            let m = i;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]];
            i = m;
          }
        }
        return top;
      };
      if (kindA === 'free') {
        for (const { d } of startDirs) {
          const k = key(a.r, a.c, d);
          dist.set(k, 0);
          prev.set(k, null);
          push(0, a.r, a.c, d);
        }
      }
      for (const { d } of kindA === 'free' ? [] : startDirs) {
        const r = a.r + DIRS[d][0], c = a.c + DIRS[d][1];
        const e = enter(r, c, d);
        if (!e || e.cross) continue;
        const k = key(r, c, d);
        dist.set(k, e.cost);
        prev.set(k, null);
        push(e.cost, r, c, d);
      }
      const goals = new Map(); // key -> true when arriving there moving into b
      for (const { d } of endDirs) {
        if (kindB === 'free') { goals.set(key(b.r, b.c, d), true); continue; }
        const r = b.r + DIRS[d][0], c = b.c + DIRS[d][1];
        goals.set(key(r, c, (d + 2) % 4), true);
      }
      let found = null;
      while (heap.length) {
        const [cost, r, c, d] = pop();
        const k = key(r, c, d);
        if (cost > dist.get(k)) continue;
        if (goals.has(k) && !crossAt.has(r * C + c)) { found = k; break; }
        const here = crossAt.has(r * C + c);
        for (let nd = 0; nd < 4; nd++) {
          if (nd === (d + 2) % 4) continue;
          if (here && nd !== d) continue;
          if (nd !== d && !cornerOk(r, c, d, nd)) continue;
          const nr = r + DIRS[nd][0], nc = c + DIRS[nd][1];
          const e = enter(nr, nc, nd);
          if (!e) continue;
          const nk = key(nr, nc, nd);
          const ncost = cost + e.cost + (nd !== d ? TURN : 0) + (nearWall(nr, nc) ? 2 : 0);
          if (ncost < (dist.has(nk) ? dist.get(nk) : Infinity)) {
            dist.set(nk, ncost);
            prev.set(nk, k);
            if (e.cross) crossAt.add(nr * C + nc);
            push(ncost, nr, nc, nd);
          }
        }
      }
      if (found === null) return { error: 'No route found between the two points (boxes or text are in the way)' };

      // Walk back, then draw
      const cells = [];
      for (let k = found; k !== null; k = prev.get(k)) {
        const d = k % 4, rc = (k - d) / 4;
        cells.unshift({ r: Math.floor(rc / C), c: rc % C, d });
      }
      const lastCell = cells[cells.length - 1];
      const intoB = kindB === 'free' ? lastCell.d : (endDirs.find(({ d }) =>
        lastCell.r === b.r + DIRS[d][0] && lastCell.c === b.c + DIRS[d][1]) || endDirs[0]).d ^ 2;
      const HEAD = ['^', '>', 'v', '<'];
      const straight = (d) => (horiz(d) ? (opts.dashed ? '=' : '-') : (opts.dashed ? ':' : '|'));
      // A line end the new line meets: continuing it keeps it straight, from the side it's a '+'
      // (an arrowhead it continues becomes line, in the style of the line behind it)
      const join = (p, d) => {
        const ch = g[p.r][p.c];
        const along = (chars) => [[0, -1], [0, 1], [-1, 0], [1, 0]]
          .map(([dr, dc]) => (g[p.r + dr] || [])[p.c + dc]).find((x) => x && chars.includes(x));
        if ('-='.includes(ch)) return horiz(d) ? ch : '+';
        if ('|:'.includes(ch)) return horiz(d) ? '+' : ch;
        if ('<>'.includes(ch)) return horiz(d) ? along('-=') || straight(d) : '+';
        if ('^v'.includes(ch)) return horiz(d) ? '+' : along('|:') || straight(d);
        return '+';
      };
      cells.forEach((cell, i) => {
        const inD = cell.d;
        const outD = i < cells.length - 1 ? cells[i + 1].d : intoB;
        const crossing = crossAt.has(cell.r * C + cell.c) && role(cell.r, cell.c) !== 'empty';
        let ch;
        if (crossing || inD !== outD) ch = '+';
        else if (horiz(inD)) ch = opts.dashed ? '=' : '-';
        else ch = opts.dashed ? ':' : '|';
        if (i === cells.length - 1 && opts.arrow !== false && kindB !== 'wire') ch = HEAD[intoB];
        g[cell.r][cell.c] = ch;
      });
      if (kindA === 'wire') g[a.r][a.c] = join(a, cells[0].d);
      if (kindB === 'wire') g[b.r][b.c] = join(b, intoB);
      this.normalizeWidth(state);
      const res = { text: this.fromGridState(state), cursorR: lastCell.r, cursorC: lastCell.c };
      // Boxes must all survive (a container wall crossing becomes '+', still a wall); the
      // wiring changes by design, so only boxes are checked. Joining lines may close a
      // shape on purpose (e.g. mending a box's wall), so new boxes are allowed then.
      const mending = kindA !== 'wall' || kindB !== 'wall';
      return this.guardOtherBoxes(rawText, res, 'connect', null, mending ? Infinity : 0, false);
    }
  }

  const api = { COLOR_MAP, DitaaParser, Grid2DEditor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DitaaEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
