'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DitaaParser, Grid2DEditor } = require('../src/engine.js');

const parse = (text, opts) => new DitaaParser(opts).parse(text);
const render = (text, opts) => {
  const p = new DitaaParser(opts);
  return p.renderSVG(p.parse(text));
};

test('detects a simple box with color and shape tags', () => {
  const ast = parse('+--------+\n| Hi {s} |\n| cBLU   |\n+--------+');
  assert.equal(ast.boxes.length, 1);
  const b = ast.boxes[0];
  assert.deepEqual([b.r1, b.c1, b.r2, b.c2], [0, 0, 3, 9]);
  assert.equal(b.shape, 'storage');
  assert.equal(b.colorKey, 'cBLU');
  assert.deepEqual(b.lines, ['Hi']);
});

test('a box labelled with an Object.prototype name does not crash rendering', () => {
  for (const label of ['toString', 'constructor', '__proto__', 'valueOf']) {
    const text = `+-------------+\n| ${label.padEnd(11)} |\n+-------------+`;
    const ast = parse(text);
    assert.equal(ast.boxes[0].macroKey, null, label);
    assert.doesNotThrow(() => render(text), label);
  }
});

test('legend lines are blanked in place so grid rows match editor lines', () => {
  const text = '# title comment\n+----+\n| A  |\n+----+\n\n# [A] = Alpha';
  const ast = parse(text);
  assert.equal(ast.boxes.length, 1);
  assert.equal(ast.boxes[0].r1, 1, 'box must start on editor line 1, not 0');
  assert.equal(ast.legends.A, 'Alpha');
  assert.equal(ast.boxes[0].macroExpanded, 'Alpha');
});

test('spaced dashed arrow "= = = >" renders as a dashed wire with an arrowhead', () => {
  const ast = parse('x    = = = = >   y');
  assert.equal(ast.wires.length, 1);
  assert.equal(ast.wires[0].dashed, true);
  assert.equal(ast.arrows.length, 1);
  assert.equal(ast.arrows[0].dir, '>');
  assert.deepEqual(ast.freeTexts.map((t) => t.text), ['x', 'y']);
});

test('letters v and ^ inside words next to wires stay text', () => {
  const ast = parse('  |\n  vertical\n');
  assert.equal(ast.arrows.length, 0);
  assert.ok(ast.freeTexts.some((t) => t.text === 'vertical'));
});

test('nested boxes: container keeps inner wires and its tags, children are detected', () => {
  const text = [
    '+---------------------------+',
    '| Outer cBLU                |',
    '|  +-----+       +-----+    |',
    '|  | A   +------>| B   |    |',
    '|  +-----+       +-----+    |',
    '+---------------------------+'
  ].join('\n');
  const ast = parse(text);
  assert.equal(ast.boxes.length, 3);
  const outer = ast.boxes.find((b) => b.isContainer);
  assert.ok(outer);
  assert.equal(outer.colorKey, 'cBLU');
  assert.deepEqual(outer.lines, []);
  assert.ok(ast.freeTexts.some((t) => t.text === 'Outer'));
  assert.ok(!ast.freeTexts.some((t) => t.text.includes('cBLU')));
  assert.equal(ast.wires.length, 1, 'wire between the two children is traced');
  assert.equal(ast.arrows.filter((a) => a.dir === '>').length, 1);
  const a = ast.boxes.find((b) => b.lines[0] === 'A');
  assert.deepEqual(a.lines, ['A']);
});

test('custom hex colors: c#RRGGBB and ditaa cRGB; lowercase words are not colors', () => {
  assert.equal(parse('+------+\n| c1AF |\n+------+').boxes[0].customHex, '#11aaff');
  assert.equal(parse('+---------+\n| c#00FF00|\n+---------+').boxes[0].customHex, '#00ff00');
  const cafe = parse('+------+\n| cafe |\n+------+').boxes[0];
  assert.equal(cafe.customHex, null);
  assert.deepEqual(cafe.lines, ['cafe']);
});

test('arrowhead touching a box puts its tip on the border', () => {
  const ast = parse('--->+---+\n    |   |\n    +---+');
  const a = ast.arrows.find((x) => x.dir === '>');
  assert.equal(a.touchesBox, true);
});

test('inline arrows on shared walls are not duplicated', () => {
  const ast = parse('+---+\n| A |\n+-^-+\n| B |\n+---+');
  assert.equal(ast.boxes.length, 2);
  assert.equal(ast.arrows.filter((a) => a.inline).length, 1);
});

test('the 4x4 macro template stays aligned for any key length', () => {
  for (const key of ['M1', 'M10', 'M123']) {
    const tpl = Grid2DEditor.macroBoxTemplate(key);
    assert.equal(new Set(tpl.map((l) => l.length)).size, 1, key);
    const res = Grid2DEditor.smartStampBox('', 0, 0, tpl, { key, val: 'X' });
    const ast = parse(res.text);
    assert.equal(ast.boxes.length, 1, key);
    assert.equal(ast.boxes[0].macroKey, key);
  }
});

test('nextMacroKey never collides and legend entries match exact keys', () => {
  assert.equal(Grid2DEditor.nextMacroKey('# [M1] = a\n# [M10] = b'), 'M11');
  const res = Grid2DEditor.smartStampBox('# [M10] = ten', 0, 0, Grid2DEditor.macroBoxTemplate('M1'), { key: 'M1', val: 'one' });
  assert.match(res.text, /# \[M1\] = one/);
});

test('grid ops keep comments above the diagram in place', () => {
  const text = '# header\n+----+\n| A  |\n+----+\n\n# [A] = Alpha';
  const box = parse(text).boxes[0];
  const res = Grid2DEditor.shiftBoxWithElasticWires(text, box, 0, 1);
  const lines = res.text.split('\n');
  assert.equal(lines[0], '# header');
  assert.equal(lines[1], ' +----+');
  assert.equal(lines[lines.length - 1], '# [A] = Alpha');
});

test('toggleTag fits tags inside the box, toggles off, and replaces colors', () => {
  const text = '+--------------+\n|  Component   |\n|  cBLU        |\n+--------------+';
  const box = parse(text).boxes[0];
  const withS = Grid2DEditor.toggleTag(text, box, '{s}');
  assert.ok(!withS.error);
  const b2 = parse(withS.text).boxes[0];
  assert.equal(b2.shape, 'storage');
  assert.deepEqual([b2.c1, b2.c2], [0, 15], 'walls untouched');

  const off = Grid2DEditor.toggleTag(withS.text, b2, '{s}');
  assert.equal(parse(off.text).boxes[0].shape, 'rect');

  const green = Grid2DEditor.toggleTag(text, box, 'cGRE');
  assert.equal(parse(green.text).boxes[0].colorKey, 'cGRE');
  assert.ok(!green.text.includes('cBLU'));

  const narrow = '+-----+\n|[M1] |\n|cYEL |\n+-----+';
  assert.ok(Grid2DEditor.toggleTag(narrow, parse(narrow).boxes[0], '{s}').error);
});

test('resize refuses to delete text and keeps neighbouring boxes intact', () => {
  const text = '+------+\n| abcd |\n+------+';
  const box = parse(text).boxes[0];
  assert.ok(Grid2DEditor.resizeBox(text, box, -2, 0).error);
  assert.ok(Grid2DEditor.resizeBox(text, box, 0, -1).error);

  const side = '+---+  +---+\n| A |  | B |\n|   |  |   |\n+---+  |   |\n       +---+';
  const a = parse(side).boxes.find((b) => b.lines[0] === 'A');
  const res = Grid2DEditor.resizeBox(side, a, 0, 1);
  const ast = parse(res.text);
  assert.equal(ast.boxes.length, 2, 'box B must survive the inserted row');
});

test('resize wider then narrower round-trips', () => {
  const text = '+----+\n| A  |\n+----+';
  const wide = Grid2DEditor.resizeBox(text, parse(text).boxes[0], 2, 0);
  const narrow = Grid2DEditor.resizeBox(wide.text, parse(wide.text).boxes[0], -2, 0);
  assert.equal(narrow.text, text);
});

test('shift box stretches an attached wire', () => {
  const text = '--->+---+\n    |   |\n    +---+';
  const box = parse(text).boxes[0];
  const res = Grid2DEditor.shiftBoxWithElasticWires(text, box, 0, 1);
  assert.equal(res.text.split('\n')[0], '---->+---+');
});

test('legacy export moves inline arrows onto the adjacent wire cell', () => {
  const text = '+----^----+\n| Node    |\n+---------+';
  const flipped = '+---------+\n| Node    |\n+----^----+\n     |\n     +--';
  const res = DitaaParser.exportStrictLegacyDitaa(flipped);
  assert.equal(res.sanitizedText, '+---------+\n| Node    |\n+----+----+\n     ^\n     +--');
  assert.equal(res.healedArrowsCount, 1);
  assert.equal(res.insertedRowsCount, 0);
  // no wire attached → untouched
  assert.equal(DitaaParser.exportStrictLegacyDitaa(text).healedArrowsCount, 0);
});

test('legacy export inserts a spacer row when the neighbour is a corner, without tearing other boxes', () => {
  const text = [
    '+-----+   +---+',
    '|  A  |   | B |',
    '+--^--+   |   |',
    '   +---   +---+'
  ].join('\n');
  const res = DitaaParser.exportStrictLegacyDitaa(text);
  const lines = res.sanitizedText.split('\n');
  assert.equal(res.insertedRowsCount, 1);
  assert.equal(lines[2], '+--+--+   |   |');
  assert.equal(lines[3], '   ^      |   |');
  // Box B is still closed after the insertion
  const ast = parse(res.sanitizedText, { healInlineArrows: false });
  assert.ok(ast.boxes.some((b) => b.lines[0] === 'B'));
});

test('legacy export handles < and > on vertical walls', () => {
  const text = '      +---+\n------>   |\n      +---+';
  const res = DitaaParser.exportStrictLegacyDitaa(text);
  assert.equal(res.sanitizedText.split('\n')[1], '----->|   |');
  assert.equal(new DitaaParser({ healInlineArrows: true }).parse(text).boxes.length, 1);
});

test('all presets parse and render', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const PRESETS = new Function(presetSrc + '\nreturn PRESETS;')();
  const expected = { arch: 7, showcase: 7, microservices: 6, legacy_comparison: 4, flowchart: 7, nested: 4 };
  for (const [k, text] of Object.entries(PRESETS)) {
    const ast = parse(text);
    assert.equal(ast.boxes.length, expected[k], k);
    assert.ok(render(text).startsWith('<svg'), k);
    for (const mode of ['both', 'inline', 'card', 'off']) render(text, { legendMode: mode });
    DitaaParser.exportStrictLegacyDitaa(text);
  }
});

/* ---------------- {c} conditional diamonds ---------------- */

const DIAMOND = [
  '       +-------+-------+',
  '       |               |',
  '------>+  Valid? {c}   +------>',
  '       |               |',
  '       +-------+-------+',
  '               |',
  '               v'
].join('\n');

test('{c} is parsed as a choice diamond and rendered as a polygon through the wall centres', () => {
  const p = new DitaaParser();
  const ast = p.parse(DIAMOND);
  assert.equal(ast.boxes.length, 1);
  const b = ast.boxes[0];
  assert.equal(b.shape, 'choice');
  assert.deepEqual(b.lines, ['Valid?']);
  const { x, y, w, h } = p.boxGeom(b);
  assert.ok(p.renderSVG(ast).includes(`points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"`));
});

test('wires attached to the centre ports end exactly on the diamond vertices', () => {
  const p = new DitaaParser();
  const ast = p.parse(DIAMOND);
  const { x, y, w, h, cx, cy } = p.boxGeom(ast.boxes[0]);
  const horiz = ast.wires.filter((wi) => wi.y1 === wi.y2);
  assert.ok(horiz.some((wi) => wi.y1 === cy && wi.x2 === x), 'incoming wire ends on the left vertex');
  assert.ok(horiz.some((wi) => wi.y1 === cy && wi.x1 === x + w), 'outgoing wire starts on the right vertex');
  const vert = ast.wires.find((wi) => wi.x1 === wi.x2);
  assert.equal(vert.x1, cx);
  assert.equal(vert.y1, y + h, 'down wire starts on the bottom vertex');
  const arrowIn = ast.arrows.find((a) => a.dir === '>' && a.c === 6);
  assert.equal(arrowIn.tipX, x, 'arrow tip on the left vertex');
});

test('a wire hitting a diamond off-centre is clipped to the slanted edge', () => {
  const text = [
    '    +-------+-------+',
    '--->|               |',
    '    +    Q? {c}     +',
    '    |               |',
    '    +-------+-------+'
  ].join('\n');
  const p = new DitaaParser();
  const ast = p.parse(text);
  const { x, cx } = p.boxGeom(ast.boxes[0]);
  const a = ast.arrows.find((ar) => ar.dir === '>');
  assert.ok(a.tipX > x && a.tipX < cx, `tip ${a.tipX} should be on the edge between ${x} and ${cx}`);
  const wire = ast.wires.find((wi) => wi.y1 === wi.y2);
  assert.equal(wire.x2, a.tipX);
});

test('diamondTemplate has odd dimensions with ports at the wall centres', () => {
  for (const label of ['Decision?', 'Is the user logged in?']) {
    const t = Grid2DEditor.diamondTemplate(label);
    const W = t[0].length;
    assert.equal(t.length, 5);
    assert.equal(W % 2, 1, label);
    assert.ok(t.every((l) => l.length === W), label);
    const mid = (W - 1) / 2;
    assert.equal(t[0][mid], '+');
    assert.equal(t[4][mid], '+');
    assert.equal(t[2][0], '+');
    assert.equal(t[2][W - 1], '+');
    const b = parse(t.join('\n')).boxes[0];
    assert.equal(b.shape, 'choice', label);
    assert.deepEqual(b.lines, [label]);
  }
});

test('stamping a diamond on an arrow tip puts the arrow on the left vertex', () => {
  const res = Grid2DEditor.smartStampBox('\n\n------>', 2, 7, Grid2DEditor.diamondTemplate('Ok?'));
  const p = new DitaaParser();
  const ast = p.parse(res.text);
  assert.equal(ast.boxes[0].shape, 'choice');
  assert.equal(ast.arrows[0].tipX, p.boxGeom(ast.boxes[0]).x);
});

test('resizing a diamond keeps ports on the vertices and wires attached, and round-trips', () => {
  let text = DIAMOND;
  const steps = [[2, 0], [0, 1], [0, -1], [-2, 0]];
  for (const [dw, dh] of steps) {
    const box = parse(text).boxes[0];
    const res = Grid2DEditor.resizeBox(text, box, dw, dh);
    assert.ok(!res.error, res.error);
    text = res.text;
    const p = new DitaaParser();
    const ast = p.parse(text);
    const b = ast.boxes[0];
    assert.equal((b.c2 - b.c1) % 2, 0, 'odd width');
    assert.equal((b.r2 - b.r1) % 2, 0, 'odd height');
    const lines = text.split('\n');
    const midR = (b.r1 + b.r2) / 2, midC = (b.c1 + b.c2) / 2;
    assert.equal(lines[b.r1][midC], '+', 'top port centred');
    assert.equal(lines[b.r2][midC], '+', 'bottom port centred');
    assert.equal(lines[midR][b.c1], '+', 'left port centred');
    assert.equal(lines[midR][b.c2], '+', 'right port centred');
    assert.equal(ast.wires.length, 3, `all wires still attached after ${dw},${dh}`);
  }
  assert.equal(text, DIAMOND);
});

test('a diamond refuses to shrink through its label, and shrinks to 3 rows when it can', () => {
  const box = parse(DIAMOND).boxes[0];
  const res = Grid2DEditor.resizeBox(DIAMOND, box, 0, -1);
  assert.ok(!res.error);
  const small = parse(res.text).boxes[0];
  assert.equal(small.r2 - small.r1, 2);
  assert.ok(Grid2DEditor.resizeBox(res.text, small, 0, -1).error);
  let text = DIAMOND;
  let res2;
  for (let i = 0; i < 10; i++) {
    res2 = Grid2DEditor.resizeBox(text, parse(text).boxes[0], -2, 0);
    if (res2.error) break;
    text = res2.text;
    assert.deepEqual(parse(text).boxes[0].lines, ['Valid?'], 'label intact');
  }
  assert.ok(res2.error, 'narrowing stops before cutting the label');
  assert.match(text, /\+Valid\? \{c\} ?\+/);
});

test('{c} tag button replaces other shapes and toggles off', () => {
  const text = '+--------------+\n|  Check {s}   |\n+--------------+';
  const res = Grid2DEditor.toggleTag(text, parse(text).boxes[0], '{c}');
  const b = parse(res.text).boxes[0];
  assert.equal(b.shape, 'choice');
  assert.ok(!res.text.includes('{s}'));
  assert.equal(parse(Grid2DEditor.toggleTag(res.text, b, '{c}').text).boxes[0].shape, 'rect');
});

test('legacy export keeps {c} (supported by ditaa 0.9+)', () => {
  const res = DitaaParser.exportStrictLegacyDitaa(DIAMOND);
  assert.equal(res.sanitizedText, DIAMOND);
});

test('stamping a diamond on an arrow near the top adds rows so the arrow still hits the vertex', () => {
  const p = new DitaaParser();
  const res = Grid2DEditor.smartStampBox('------>', 0, 7, Grid2DEditor.diamondTemplate('Ok?'));
  const ast = p.parse(res.text);
  const b = ast.boxes[0];
  const arrow = ast.arrows.find((a) => a.dir === '>');
  assert.equal(arrow.r, (b.r1 + b.r2) / 2, 'arrow is on the middle row');
  assert.equal(arrow.tipX, p.boxGeom(b).x);
  assert.equal(res.text.split('\n')[res.cursorR][res.cursorC], '+', 'cursor on the right port for chaining');
});

/* ---------------- Review follow-ups: operations must not damage other boxes ---------------- */

test('regression (PR #3 review): widening a diamond never splits another box label or tag', () => {
  const text = [
    '+-------------------------------+',
    '| ABCDEFGHIJKLMNOPQRSTUVWX cBLU |',
    '+-------------------------------+',
    '',
    ...Grid2DEditor.diamondTemplate('Q?').map((l) => '       ' + l)
  ].join('\n');
  assert.equal(parse(text).boxes.length, 2);
  const dia = parse(text).boxes.find((b) => b.shape === 'choice');
  const res = Grid2DEditor.resizeBox(text, dia, 2, 0);
  assert.ok(res.error, 'refused');
  assert.match(res.error, /ABCDEFGHIJKLMNOPQRSTUVWX/);

  // Same layout with a short label clear of the inserted columns: widening works and the
  // other box keeps its label and color.
  const ok = text.replace('ABCDEFGHIJKLMNOPQRSTUVWX cBLU', '         Top cBLU            ');
  const res2 = Grid2DEditor.resizeBox(ok, parse(ok).boxes.find((b) => b.shape === 'choice'), 2, 0);
  assert.ok(!res2.error, res2.error);
  const top = parse(res2.text).boxes.find((b) => b.shape !== 'choice');
  assert.deepEqual(top.lines, ['Top']);
  assert.equal(top.colorKey, 'cBLU');
});

test('regression (PR #3 review): arrows near a diamond corner end on the slanted edge', () => {
  const text = ' |\n v\n' + Grid2DEditor.diamondTemplate('OK?').join('\n');
  const p = new DitaaParser();
  const ast = p.parse(text);
  const { cx, cy, w, h } = p.boxGeom(ast.boxes[0]);
  const ax = 1.5 * p.cellW;
  const edgeY = cy - (h / 2) * (1 - Math.abs(ax - cx) / (w / 2));
  assert.equal(edgeY, 76.5);
  assert.equal(ast.arrows[0].tipY, edgeY);
  assert.equal(ast.wires[0].y2, edgeY);
});

test('regression (PR #1 review): widening a box keeps a taller neighbour intact, and round-trips', () => {
  const text = '+---+  +---+\n| A |  | B |\n|   |  |   |\n+---+  |   |\n       +---+';
  const a = parse(text).boxes.find((b) => b.lines[0] === 'A');
  const wide = Grid2DEditor.resizeBox(text, a, 2, 0);
  const ast = parse(wide.text);
  assert.equal(ast.boxes.length, 2);
  assert.deepEqual(ast.boxes.map((b) => b.lines).sort(), [['A'], ['B']]);
  const back = Grid2DEditor.resizeBox(wide.text, ast.boxes.find((b) => b.lines[0] === 'A'), -2, 0);
  assert.equal(back.text, text);
});

test('narrowing never joins two words or deletes text in other rows', () => {
  const text = '+------+\n| A    |\n+------+\n    x y';
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes[0], -2, 0);
  assert.ok(res.error);
  assert.match(res.error, /join text|in the way/);
});

test('widening keeps an arrowhead touching the box it points at', () => {
  // The inserted column falls exactly between the '>' and the box it points at
  const text = '+----+\n| A  |\n+----+\n\n---->+---+\n     |   |\n     +---+';
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes[0], 2, 0);
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[4], '------>+---+');
  const ast = parse(res.text);
  assert.equal(ast.boxes.length, 2);
  assert.ok(ast.arrows.find((a) => a.dir === '>').touchesBox);
});

test('regression (PR #1 review): recolouring a container keeps its children\'s tags', () => {
  const text = [
    '+--------------------------+',
    '| cBLU                     |',
    '|  +------+   +------+     |',
    '|  | cRED |   | {s}  |     |',
    '|  +------+   +------+     |',
    '+--------------------------+'
  ].join('\n');
  const outer = () => parse(text).boxes.find((b) => b.isContainer);
  const yellow = Grid2DEditor.toggleTag(text, outer(), 'cYEL');
  const boxes = parse(yellow.text).boxes;
  assert.deepEqual(boxes.map((b) => b.colorKey), ['cYEL', 'cRED', null]);
  assert.equal(yellow.text.split('\n')[1], '| cYEL                     |', 'new color replaces the old one in place');

  const doc = Grid2DEditor.toggleTag(text, outer(), '{d}');
  const after = parse(doc.text).boxes;
  assert.equal(after.find((b) => b.isContainer).shape, 'document');
  assert.equal(after.find((b) => !b.isContainer && b.colorKey === null).shape, 'storage', 'child shape untouched');
  assert.equal(after.find((b) => b.colorKey === 'cRED').shape, 'rect');
});

test('regression (PR #3 follow-up review): narrowing never collapses a small empty box elsewhere', () => {
  const text = '+------+\n| A    |\n+------+\n\n    +--+\n    |  |\n    +--+';
  assert.equal(parse(text).boxes.length, 2);
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes[0], -2, 0);
  assert.ok(res.error, 'refused');
  assert.match(res.error, /line 5/);
});

test('moving a box onto another box is refused', () => {
  const text = '+---++---+\n| A || B |\n+---++---+';
  const a = parse(text).boxes.find((b) => b.lines[0] === 'A');
  assert.ok(Grid2DEditor.shiftBoxWithElasticWires(text, a, 0, 1).error);
});

test('no resize, move or tag operation on one box changes any other box (presets + edge layouts)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const PRESETS = new Function(presetSrc + '\nreturn PRESETS;')();
  // Small/empty/adjacent boxes that the presets don't exercise
  Object.assign(PRESETS, {
    smallEmptyBelow: '+------+\n| A    |\n+------+\n\n    +--+\n    |  |\n    +--+',
    smallEmptyAbove: '    +--+\n    |  |\n    +--+\n\n+------+\n| A    |\n+------+',
    tallNeighbour: '+---+  +---+\n| A |  | B |\n|   |  |   |\n+---+  |   |\n       +---+',
    touching: '+---++---+\n| A || B |\n+---++---+',
    stacked: '+-----+\n| A   |\n+-----+\n| B   |\n+-----+',
    grid3: '+--+ +--+ +--+\n|  | |  | |  |\n+--+ +--+ +--+\n+--+ +--+ +--+\n|  | |  | |  |\n+--+ +--+ +--+',
    diamondPair: [
      '  +--+',
      '  |  |',
      '  +--+',
      ...Grid2DEditor.diamondTemplate('X?')
    ].join('\n')
  });
  const sig = (b) => JSON.stringify([b.lines, b.colorKey, b.customHex, b.shape, b.macroKey, b.dashedBorder]);

  const ops = [
    ['wider', (t, b) => Grid2DEditor.resizeBox(t, b, 2, 0)],
    ['narrower', (t, b) => Grid2DEditor.resizeBox(t, b, -2, 0)],
    ['taller', (t, b) => Grid2DEditor.resizeBox(t, b, 0, 1)],
    ['shorter', (t, b) => Grid2DEditor.resizeBox(t, b, 0, -1)],
    ['left', (t, b) => Grid2DEditor.shiftBoxWithElasticWires(t, b, 0, -1)],
    ['right', (t, b) => Grid2DEditor.shiftBoxWithElasticWires(t, b, 0, 1)],
    ['up', (t, b) => Grid2DEditor.shiftBoxWithElasticWires(t, b, -1, 0)],
    ['down', (t, b) => Grid2DEditor.shiftBoxWithElasticWires(t, b, 1, 0)],
    ['cRED', (t, b) => Grid2DEditor.toggleTag(t, b, 'cRED')],
    ['{s}', (t, b) => Grid2DEditor.toggleTag(t, b, '{s}')]
  ];
  for (const [name, text] of Object.entries(PRESETS)) {
    const before = parse(text).boxes;
    before.forEach((box, i) => {
      for (const [opName, op] of ops) {
        const res = op(text, box);
        if (!res || res.error) continue;
        const after = parse(res.text).boxes;
        const others = (list, skip) => list.filter((_, j) => j !== skip).map(sig).sort();
        // the operated box keeps its position in detection order unless tags changed it
        const isTag = opName === 'cRED' || opName === '{s}';
        if (isTag) {
          assert.equal(after.length, before.length, `${name} box#${i} ${opName}: box count`);
          assert.deepEqual(others(after, i), others(before, i), `${name} box#${i} ${opName}: other boxes changed`);
        } else {
          assert.deepEqual(after.map(sig).sort(), before.map(sig).sort(), `${name} box#${i} ${opName}: boxes changed`);
        }
      }
    });
  }
});
