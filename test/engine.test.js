'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DitaaParser, Grid2DEditor } = require('../src/engine.js');

// Most tests are about the editor, which reads extensions too; plain-ditaa tests say so
const LENIENT = { extensions: true };
const parse = (text, opts) => new DitaaParser({ ...LENIENT, ...opts }).parse(text);
const render = (text, opts) => {
  const p = new DitaaParser({ ...LENIENT, ...opts });
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
  // (plain ditaa needs a shaft behind the arrowhead: a line is made for it)
  assert.equal(res.sanitizedText, '+---------+\n| Node    |\n+----+----+\n     ^\n     |\n     +--');
  assert.equal(res.healedArrowsCount, 1);
  assert.equal(res.shaftsAdded, 1);
  assert.equal(res.insertedRowsCount, 1);
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
  assert.equal(res.insertedRowsCount, 2, 'one for the arrowhead, one for its shaft');
  assert.equal(lines[2], '+--+--+   |   |');
  assert.equal(lines[3], '   ^      |   |');
  assert.equal(lines[4], '   |      |   |');
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
  const p = new DitaaParser(LENIENT);
  const ast = p.parse(DIAMOND);
  assert.equal(ast.boxes.length, 1);
  const b = ast.boxes[0];
  assert.equal(b.shape, 'choice');
  assert.deepEqual(b.lines, ['Valid?']);
  const { x, y, w, h } = p.boxGeom(b);
  assert.ok(p.renderSVG(ast).includes(`points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"`));
});

test('wires attached to the centre ports end exactly on the diamond vertices', () => {
  const p = new DitaaParser(LENIENT);
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
  const p = new DitaaParser(LENIENT);
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
  const p = new DitaaParser(LENIENT);
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
    const p = new DitaaParser(LENIENT);
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
  const p = new DitaaParser(LENIENT);
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
  // The inserted columns would land inside the label and the tag: they go after each
  // word instead, so both stay whole and the box above just gets wider.
  const res = Grid2DEditor.resizeBox(text, dia, 2, 0);
  assert.ok(!res.error, res.error);
  const after = parse(res.text).boxes;
  assert.equal(after.length, 2);
  const top = after.find((b) => b.shape !== 'choice');
  assert.deepEqual(top.lines, ['ABCDEFGHIJKLMNOPQRSTUVWX']);
  assert.equal(top.colorKey, 'cBLU');
  const d = after.find((b) => b.shape === 'choice');
  assert.equal(d.c2 - d.c1, dia.c2 - dia.c1 + 2);
});

test('regression (PR #3 review): arrows near a diamond corner end on the slanted edge', () => {
  const text = ' |\n v\n' + Grid2DEditor.diamondTemplate('OK?').join('\n');
  const p = new DitaaParser(LENIENT);
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

test('narrowing only touches the box\'s own lines; it never joins words on them', () => {
  const below = '+------+\n| A    |\n+------+\n    x y';
  const res = Grid2DEditor.resizeBox(below, parse(below).boxes[0], -2, 0);
  assert.ok(!res.error, res.error);
  assert.equal(res.text, '+----+\n| A  |\n+----+\n    x y', 'text below is untouched');

  const beside = '+------+\n| A    | x y\n+------+';
  const res2 = Grid2DEditor.resizeBox(beside, parse(beside).boxes[0], -2, 0);
  assert.ok(!res2.error, res2.error);
  assert.equal(res2.text.split('\n')[1], '| A  | x y', 'text beside moves left with the wall');
});

test('widening moves wires and boxes beside it; lines above and below stay put', () => {
  const text = [
    '+----+    +---+',
    '| A  +--->| B |',
    '+----+    +---+',
    '  |',
    '  v',
    '+----+  +--+',
    '| C  |  |  |',
    '+----+  +--+'
  ].join('\n');
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes.find((b) => b.lines[0] === 'A'), 2, 0);
  assert.ok(!res.error, res.error);
  const lines = res.text.split('\n');
  assert.equal(lines[1], '| A    +--->| B |');
  assert.deepEqual(lines.slice(3), text.split('\n').slice(3), 'everything below unchanged');
  const ast = parse(res.text);
  assert.equal(ast.boxes.length, 4);
  assert.ok(ast.arrows.find((a) => a.dir === '>').touchesBox);
});

test('narrowing a diamond keeps a lead-in arrow touching it', () => {
  const text = '       +-------+-------+\n       |               |\n------>+  Valid? {c}   +\n       |               |\n       +-------+-------+';
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes[0], -2, 0);
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[2], '------->+ Valid? {c}  +');
  assert.ok(parse(res.text).arrows[0].touchesBox);
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
  // Narrowing now only changes the box's own lines, so the small box below is not touched
  const text = '+------+\n| A    |\n+------+\n\n    +--+\n    |  |\n    +--+';
  assert.equal(parse(text).boxes.length, 2);
  const res = Grid2DEditor.resizeBox(text, parse(text).boxes[0], -2, 0);
  assert.ok(!res.error, res.error);
  assert.equal(parse(res.text).boxes.length, 2);
  assert.deepEqual(res.text.split('\n').slice(3), text.split('\n').slice(3));
  // ...and a small empty box BESIDE it moves as a whole instead of collapsing
  const side = '+------++--+\n| A    ||  |\n+------++--+';
  const res2 = Grid2DEditor.resizeBox(side, parse(side).boxes.find((b) => b.lines[0] === 'A'), -2, 0);
  assert.ok(!res2.error, res2.error);
  assert.equal(res2.text, '+----++--+\n| A  ||  |\n+----++--+');
});

test('moving a box is a plain text operation: never refused, even onto another box', () => {
  const text = '+---++---+\n| A || B |\n+---++---+';
  const a = parse(text).boxes.find((b) => b.lines[0] === 'A');
  const res = Grid2DEditor.shiftBoxWithElasticWires(text, a, 0, 1);
  assert.ok(!res.error, 'the user is always right (Undo is there)');
  assert.ok(res.text.includes('A'));
});

test('no resize or tag operation on one box changes any other box (presets + edge layouts)', () => {
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

/* ---------------- Typing inside boxes (auto-fit) ---------------- */

const type = (text, r, c, op, sel = null) => Grid2DEditor.typeInBox(text, { r, c }, sel, op);

test('typing inside a box widens it to fit and shifts boxes and wires to its right', () => {
  const text = '+--------+     +-----+\n| Hello  +---->| B   |\n+--------+     |     |\n               +-----+';
  const res = type(text, 1, 7, { type: 'insert', text: ' world' });
  assert.ok(res && !res.error, res && res.error);
  const ast = parse(res.text);
  assert.equal(ast.boxes.length, 2);
  const a = ast.boxes.find((b) => b.lines[0] === 'Hello world');
  const b = ast.boxes.find((b2) => b2.lines[0] === 'B');
  assert.ok(a && b);
  assert.equal(res.text.split('\n')[1].slice(a.c1, a.c2 + 1), '| Hello world +', 'one cell of padding kept');
  assert.equal(b.r2 - b.r1, 3, 'taller neighbour moved as a whole');
  assert.ok(ast.arrows.find((x) => x.dir === '>').touchesBox, 'wire still reaches B');
  assert.deepEqual([res.cursorR, res.cursorC], [1, 13]);
});

test('typing that still fits does not widen the box', () => {
  const text = '+----------+\n| Hi       |\n+----------+';
  const res = type(text, 1, 4, { type: 'insert', text: '!' });
  assert.equal(res.text, '+----------+\n| Hi!      |\n+----------+');
});

test('Enter inside a box adds a row below and moves the rest of the line there', () => {
  const text = '+------------+  +---+\n| Hello world|  | B |\n+------------+  |   |\n                +---+';
  const res = type(text, 1, 7, { type: 'newline' });
  const lines = res.text.split('\n');
  assert.equal(lines[1], '| Hello      |  | B |');
  assert.equal(lines[2], '| world      |  |   |');
  assert.deepEqual([res.cursorR, res.cursorC], [2, 2], 'caret keeps the line indentation');
  const ast = parse(res.text);
  assert.deepEqual(ast.boxes.find((b) => b.c1 === 0).lines, ['Hello', 'world']);
  assert.equal(ast.boxes.length, 2, 'neighbour stretched, not torn');
});

test('Backspace and Delete edit within the box and join lines without touching walls', () => {
  const text = '+--------+\n| Hello  |\n| world  |\n+--------+';
  const bs = type(text, 1, 5, { type: 'backspace' });
  assert.equal(bs.text.split('\n')[1], '| Helo   |');

  const join = type(text, 2, 2, { type: 'backspace' }); // at the start of the text, after the padding
  assert.equal(join.text, '+------------+\n| Helloworld |\n+------------+');
  assert.deepEqual([join.cursorR, join.cursorC], [1, 7], 'caret at the join point');

  const del = type(text, 1, 7, { type: 'delete' });
  assert.equal(del.text, join.text, 'Delete at line end joins the next line');

  // Right after the left wall, Backspace deletes the wall: a wall edit, left to the editor
  assert.equal(type(text, 1, 1, { type: 'backspace' }), null);
});

test('paste with line breaks types each line', () => {
  const text = '+------+\n| A    |\n+------+';
  const res = type(text, 1, 3, { type: 'insert', text: 'lpha\nBeta\r\nGamma' });
  assert.deepEqual(parse(res.text).boxes[0].lines, ['Alpha', 'Beta', 'Gamma']);
});

test('selections inside a box are replaced; selections leaving the box use normal editing', () => {
  const text = '+------------+\n| Hello big  |\n| world      |\n+------------+';
  const rep = type(text, 1, 7, { type: 'insert', text: 'X' }, { r: 1, c: 11 });
  assert.equal(rep.text.split('\n')[1], '| HelloX     |');
  const multi = type(text, 1, 4, { type: 'backspace' }, { r: 2, c: 4 });
  assert.deepEqual(parse(multi.text).boxes[0].lines, ['He', 'rld']);
  assert.equal(type(text, 1, 4, { type: 'insert', text: 'x' }, { r: 4, c: 0 }), null);
});

test('typing outside any box is left to the editor', () => {
  assert.equal(type('+--+\n|  |\n+--+\nabc', 3, 1, { type: 'insert', text: 'x' }), null);
  assert.equal(type('+--+\n|  |\n+--+', 0, 2, { type: 'insert', text: 'x' }), null, 'on a wall');
});

test('typing in a diamond keeps it a diamond: ports on vertices, text centred, odd size', () => {
  const lines = Grid2DEditor.diamondTemplate('Ok?').map((l) => '     ' + l);
  lines[2] = '---->' + lines[2].slice(5);
  const text = lines.join('\n');
  const k = text.split('\n')[2].indexOf('?');
  let res = type(text, 2, k, { type: 'insert', text: ' really long question' });
  const check = (t) => {
    const p = new DitaaParser(LENIENT);
    const ast = p.parse(t);
    const b = ast.boxes[0];
    assert.equal(b.shape, 'choice');
    assert.equal((b.c2 - b.c1) % 2, 0);
    assert.equal((b.r2 - b.r1) % 2, 0);
    const L = t.split('\n');
    const mr = (b.r1 + b.r2) / 2, mc = (b.c1 + b.c2) / 2;
    assert.equal(L[b.r1][mc] + L[b.r2][mc] + L[mr][b.c1] + L[mr][b.c2], '++++', 'ports centred');
    assert.equal(ast.arrows[0].tipX, p.boxGeom(b).x, 'arrow on the left vertex');
    return b;
  };
  const b = check(res.text);
  assert.deepEqual(b.lines, ['Ok really long question?']);
  assert.ok(b.c2 - b.c1 <= 'Ok really long question? {c}'.length + 6, 'grows only as much as needed');
  res = type(res.text, 2, res.text.split('\n')[2].indexOf(' question'), { type: 'newline' });
  assert.deepEqual(check(res.text).lines, ['Ok really long', 'question?']);
});

test('typing in a container pushes nested boxes along; typing in a child uses the container\'s empty space', () => {
  const text = [
    '+------------------------+',
    '| Outer                  |',
    '|  +-----+   +-----+     |',
    '|  | A   |   | B   |     |',
    '|  +-----+   +-----+     |',
    '+------------------------+'
  ].join('\n');
  // Right up against A's wall would be a wall edit; one cell before it is text in the container
  assert.equal(type(text, 3, 3, { type: 'insert', text: 'note' }), null);
  const res = type(text, 3, 2, { type: 'insert', text: 'note' });
  const ast = parse(res.text);
  assert.equal(ast.boxes.length, 3);
  assert.ok(res.text.split('\n')[3].startsWith('| note | A   |'), res.text.split('\n')[3]);
  assert.ok(ast.freeTexts.some((t) => t.text === 'Outer'));

  // Typing in a nested box grows it into the empty space inside its container; the
  // container itself never changes
  const res2 = type(text, 3, 6, { type: 'insert', text: 'lp' });
  const ast2 = parse(res2.text);
  assert.deepEqual(ast2.boxes.map((b) => b.lines[0] || null).sort(), ['Alp', 'B', null].sort());
  const cont0 = parse(text).boxes.find((b) => b.isContainer), cont2 = ast2.boxes.find((b) => b.isContainer);
  assert.deepEqual([cont2.r1, cont2.c1, cont2.r2, cont2.c2], [cont0.r1, cont0.c1, cont0.r2, cont0.c2], 'container unchanged');
  // Not enough empty space next to A (B is in the way): typing goes in as plain text
  const res3 = type(text, 3, 6, { type: 'insert', text: 'lpha-very-long' });
  assert.ok(res3.error, 'auto-fit declines; the editor types it as plain text');
});

test('typing and Enter in every box of every preset never changes another box', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const PRESETS = new Function(presetSrc + '\nreturn PRESETS;')();
  const sig = (b) => JSON.stringify([b.lines, b.colorKey, b.customHex, b.shape, b.macroKey, b.dashedBorder]);
  for (const [name, text] of Object.entries(PRESETS)) {
    const before = parse(text).boxes;
    before.forEach((box, i) => {
      for (const op of [{ type: 'insert', text: 'a much longer label here' }, { type: 'newline' }, { type: 'backspace' }]) {
        const res = type(text, box.r1 + 1, box.c1 + 2, op);
        if (!res || res.error) continue;
        const after = parse(res.text).boxes;
        assert.equal(after.length, before.length, `${name} box#${i} ${op.type}: box count`);
        const others = before.filter((_, j) => j !== i).map(sig).sort();
        const afterSigs = after.map(sig);
        for (const o of others) {
          const k = afterSigs.indexOf(o);
          assert.ok(k !== -1, `${name} box#${i} ${op.type}: lost ${o}`);
          afterSigs.splice(k, 1);
        }
      }
    });
  }
});

test('typing in a box stacked with diamonds keeps every diamond symmetric', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { flowchart } = new Function(presetSrc + '\nreturn PRESETS;')();
  const symmetric = (t) => {
    const L = t.split('\n');
    for (const d of parse(t).boxes.filter((b) => b.shape === 'choice')) {
      assert.equal((d.c2 - d.c1) % 2, 0, 'odd width');
      assert.equal((d.r2 - d.r1) % 2, 0, 'odd height');
      const mr = (d.r1 + d.r2) / 2, mc = (d.c1 + d.c2) / 2;
      assert.equal(L[d.r1][mc] + L[d.r2][mc] + L[mr][d.c1] + L[mr][d.c2], '++++', `ports of ${d.lines[0]}`);
    }
  };
  const L = flowchart.split('\n');
  const r = L.findIndex((l) => l.includes('Read input'));
  let res = type(flowchart, r, L[r].indexOf('input') + 5, { type: 'insert', text: ' from the user, then trim it' });
  assert.ok(res && !res.error, res && res.error);
  symmetric(res.text);
  assert.equal(parse(res.text).boxes.length, 7);
  res = type(res.text, res.cursorR, res.cursorC, { type: 'newline' });
  symmetric(res.text);
  // Enter in the "Show error" box, which sits beside the Valid? diamond
  const L2 = res.text.split('\n');
  const er = L2.findIndex((l) => l.includes('Show error'));
  res = type(res.text, er, L2[er].indexOf('error') + 5, { type: 'newline' });
  assert.ok(res && !res.error, res && res.error);
  symmetric(res.text);
  assert.equal(parse(res.text).boxes.length, 7);
});

test('narrowing that would make a diamond beside it lopsided is refused', () => {
  // A container whose narrowing columns run through a diamond inside it
  const text = [
    '+-----------------------+',
    '|  +-------+-------+    |',
    '|  |               |    |',
    '|  +    Q? {c}     +    |',
    '|  |               |    |',
    '|  +-------+-------+    |',
    '+-----------------------+'
  ].join('\n');
  const outer = parse(text).boxes.find((b) => b.isContainer);
  // remove 5 columns from the right of the container: the 5th runs through the diamond
  let t = text, res;
  for (let i = 0; i < 3; i++) {
    res = Grid2DEditor.resizeBox(t, parse(t).boxes.find((b) => b.isContainer), -2, 0);
    if (res.error) break;
    t = res.text;
  }
  assert.ok(res.error);
  assert.match(res.error, /lopsided|in the way/);
  assert.equal(parse(t).boxes.find((b) => b.shape === 'choice').c2 - parse(t).boxes.find((b) => b.shape === 'choice').c1, 16);
});

test('typing word by word, one key at a time, keeps the spaces (boxes and diamonds)', () => {
  const run = (text, r, c, str) => {
    let cur = { r, c };
    for (const ch of str) {
      const res = type(text, cur.r, cur.c, { type: 'insert', text: ch });
      text = res.text;
      cur = { r: res.cursorR, c: res.cursorC };
    }
    return text;
  };
  const box = run('+------------+\n| Read input |\n+------------+', 1, 12, ' from the user');
  assert.deepEqual(parse(box).boxes[0].lines, ['Read input from the user']);
  const dia = Grid2DEditor.diamondTemplate('Ok').join('\n');
  const k = dia.split('\n')[2].indexOf('Ok') + 2;
  const out = run(dia, 2, k, ' and more');
  assert.deepEqual(parse(out).boxes[0].lines, ['Ok and more']);
});

/* ---------------- Side-only growth: wires to moved boxes are re-joined ---------------- */

test('growing a box shifts only its own lines; lines beside it are not re-routed', () => {
  const text = [
    '+--------+     +-----+',
    '| Hello  +---->| B   |',
    '+--------+     +--+--+',
    '                  |',
    '                  v',
    '               +-----+',
    '               | C   |',
    '               +-----+'
  ].join('\n');
  const hello = parse(text).boxes.find((b) => b.lines[0] === 'Hello');
  const res = Grid2DEditor.resizeBox(text, hello, 2, 0);
  assert.ok(!res.error, res.error);
  const lines = res.text.split('\n');
  assert.equal(lines[1], '| Hello    +---->| B   |', 'B moved over on its own lines');
  assert.deepEqual(lines.slice(3), text.split('\n').slice(3), 'lines below untouched: no jogs, no re-routing');
});

test('typing in the flowchart diamond keeps the boxes below in place and re-joins the side wire', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { flowchart } = new Function(presetSrc + '\nreturn PRESETS;')();
  const L = flowchart.split('\n');
  const r = L.findIndex((l) => l.includes('Valid?'));
  let cur = { r, c: L[r].indexOf('?') };
  let t = flowchart;
  for (const ch of ' and complete') {
    const res = type(t, cur.r, cur.c, { type: 'insert', text: ch });
    assert.ok(res && !res.error, res && res.error);
    t = res.text;
    cur = { r: res.cursorR, c: res.cursorC };
  }
  const before = parse(flowchart), after = parse(t);
  assert.equal(after.boxes.length, 7);
  const find = (ast, label) => ast.boxes.find((b) => b.lines[0] === label);
  for (const label of ['Start', 'Read input', 'Cached?', 'Process', 'End']) {
    const a = find(before, label), b = find(after, label);
    assert.deepEqual([b.r1, b.c1, b.r2, b.c2], [a.r1, a.c1, a.r2, a.c2], `${label} did not move`);
  }
  const d = find(after, 'Valid and complete?');
  assert.equal((d.c1 + d.c2) / 2, (find(before, 'Valid?').c1 + find(before, 'Valid?').c2) / 2, 'diamond kept its centre');
  assert.ok(find(after, 'Show error').c1 > find(before, 'Show error').c1, 'box beside it moved over');
  // Every wire is still connected end to end: same number of arrowheads touching boxes
  const touching = (ast) => ast.arrows.filter((a) => a.touchesBox).length;
  assert.equal(touching(after), touching(before));
});

/* ---------------- Right-click inserts ---------------- */

const START = '\n\n\n\n\n     +---------+\n     | Start   |\n     +---------+';

test('hitBoxSides: wall or just outside picks that side, corners two, inside all four', () => {
  const t = '+---------+\n| Start   |\n+---------+';
  assert.deepEqual(Grid2DEditor.hitBoxSides(t, 1, 10).sides, ['right']);
  assert.deepEqual(Grid2DEditor.hitBoxSides(t, 1, 12).sides, ['right'], 'up to two cells outside');
  assert.deepEqual(Grid2DEditor.hitBoxSides(t, 2, 5).sides, ['below']);
  assert.deepEqual(Grid2DEditor.hitBoxSides(t, 0, 0).sides, ['left', 'above']);
  assert.deepEqual(Grid2DEditor.hitBoxSides(t, 1, 4).sides, ['right', 'below', 'left', 'above']);
  assert.equal(Grid2DEditor.hitBoxSides(t, 1, 14), null);
});

test('insertConnected draws a connected shape on each side, with a + port and the label selected', () => {
  for (const side of ['right', 'below', 'left', 'above']) {
    for (const kind of ['box', 'rbox', 'diamond']) {
      const res = Grid2DEditor.insertConnected(START, parse(START).boxes[0], side, kind);
      assert.ok(!res.error, `${side} ${kind}: ${res.error}`);
      const ast = parse(res.text);
      assert.equal(ast.boxes.length, 2, `${side} ${kind}`);
      const arrow = ast.arrows.find((a) => a.touchesBox);
      assert.ok(arrow, `${side} ${kind}: arrow reaches the new shape`);
      assert.equal(arrow.dir, { right: '>', below: 'v', left: '<', above: '^' }[side]);
      const label = res.text.split('\n')[res.cursorR].slice(res.selC1, res.selC2);
      assert.ok(['Component', 'Service', 'Decision?'].includes(label), `${side} ${kind}: label ${label}`);
      const start = ast.boxes.find((b) => b.lines[0] === 'Start');
      const L = res.text.split('\n');
      const port = {
        right: L[(start.r1 + start.r2) / 2 | 0][start.c2], left: L[(start.r1 + start.r2) / 2 | 0][start.c1],
        below: L[start.r2][(start.c1 + start.c2) / 2 | 0], above: L[start.r1][(start.c1 + start.c2) / 2 | 0]
      }[side];
      assert.equal(port, '+', `${side} ${kind}: port`);
      if (kind === 'diamond') assert.equal(ast.boxes.find((b) => b.shape === 'choice').lines[0], 'Decision?');
    }
  }
});

test('insertConnected "arrow only" draws just the port and arrow', () => {
  const res = Grid2DEditor.insertConnected(START, parse(START).boxes[0], 'right', 'arrow');
  assert.equal(res.text.split('\n')[6], '     | Start   +--->');
  assert.deepEqual([res.cursorR, res.cursorC], [6, 20], 'caret just after the arrowhead');
});

test('right/below into an existing connection: the new shape is spliced into the chain', () => {
  const below = '+---------+\n| Start   |\n+----+----+\n     |\n     v\n+----+----+\n| End     |\n+---------+';
  const r1 = Grid2DEditor.insertConnected(below, parse(below).boxes[0], 'below', 'box');
  assert.ok(!r1.error, r1.error);
  const a1 = parse(r1.text);
  assert.equal(a1.boxes.length, 3);
  assert.equal(a1.arrows.filter((a) => a.touchesBox).length, 2, 'Start -> new -> End');
  const right = '+-----+     +-----+\n| A   +---->| B   |\n+-----+     +-----+';
  const r2 = Grid2DEditor.insertConnected(right, parse(right).boxes[0], 'right', 'rbox');
  assert.equal(r2.text.split('\n')[1], '| A   +--->|   Service   +----->| B   |');
});

test('left/above draw only into empty space; at the diagram edge rows/columns are added', () => {
  const blocked = '+-----+     +-----+\n| A   +---->| B   |\n+-----+     +-----+';
  const res = Grid2DEditor.insertConnected(blocked, parse(blocked).boxes.find((b) => b.lines[0] === 'B'), 'left', 'box');
  assert.match(res.error, /No room on the left/);
  const above = 'text\n+-----+\n| A   |\n+-----+';
  assert.match(Grid2DEditor.insertConnected(above, parse(above).boxes[0], 'above', 'box').error, /press Enter/);
  const edge = '+-----+\n| A   |\n+-----+';
  const up = Grid2DEditor.insertConnected(edge, parse(edge).boxes[0], 'above', 'box');
  assert.ok(!up.error, up.error);
  assert.equal(parse(up.text).boxes.length, 2);
  const left = Grid2DEditor.insertConnected(edge, parse(edge).boxes[0], 'left', 'diamond');
  assert.ok(!left.error, left.error);
  assert.equal(parse(left.text).boxes.length, 2);
});

test('insertShapeAt only uses empty space', () => {
  const t = '+-----+\n| A   |\n+-----+';
  const ok = Grid2DEditor.insertShapeAt(t, 4, 2, 'box');
  assert.ok(!ok.error, ok.error);
  assert.equal(parse(ok.text).boxes.length, 2);
  assert.match(Grid2DEditor.insertShapeAt(t, 1, 3, 'box').error, /Not enough empty space/);
});

/* ---------------- PR #4 review follow-ups ---------------- */

// Which boxes each wire connects, by label: endpoint identity, not just counts
const connectionsByLabel = (text, rename = {}) => {
  const p = new DitaaParser(LENIENT);
  const ast = p.parse(text);
  const name = (b) => { const n = b.lines[0] || b.macroKey || '?'; return rename[n] || n; };
  return p.connections(ast).map((ids) => ids.map((i) => name(ast.boxes[i])).sort().join(' – ')).sort();
};


test('the optional wire check (checkWires) detects an edit that changes what a wire connects', () => {
  const text = '+---+   +---+\n| A +-->| B |\n+---+   +---+\n\n+---+\n| C |\n+---+';
  // B moved away from the arrow (the arrow is left dangling): same boxes, different wiring
  const moved = '+---+    +---+\n| A +--> | B |\n+---+    +---+\n\n+---+\n| C |\n+---+';
  // Opt-in only (no editing operation uses it any more): checkWires = true
  const res = Grid2DEditor.guardOtherBoxes(text, { text: moved, cursorR: 0, cursorC: 0 }, 'test', null, 0, true);
  assert.match(res.error, /change what a wire connects/);
  // By default only boxes are checked: rewiring is the user's business
  assert.ok(!Grid2DEditor.guardOtherBoxes(text, { text: moved, cursorR: 0, cursorC: 0 }, 'test').error);
});

test('regression (PR #4 review): a selection is replaced the same way from the keyboard and the menu', () => {
  // Both the beforeinput handler and the context menu's Paste call editAtSelection with
  // the textarea's selectionStart/selectionEnd.
  const text = '+---------------+\n|  Component    |\n+---------------+';
  const s = text.indexOf('Component');
  const pasted = Grid2DEditor.editAtSelection(text, s, s + 'Component'.length, { type: 'insert', text: 'API' });
  assert.deepEqual(parse(pasted.text).boxes[0].lines, ['API']);
  const typed = Grid2DEditor.editAtSelection(text, s, s + 'Component'.length, { type: 'insert', text: 'A' });
  assert.deepEqual(parse(typed.text).boxes[0].lines, ['A']);
  // A freshly inserted shape's placeholder (selected by the menu) is replaced too
  const ins = Grid2DEditor.insertConnected('+-----+\n| X   |\n+-----+', parse('+-----+\n| X   |\n+-----+').boxes[0], 'right', 'box');
  const a = Grid2DEditor.getIndexFromRowCol(ins.text, ins.cursorR, ins.selC1);
  const b = Grid2DEditor.getIndexFromRowCol(ins.text, ins.cursorR, ins.selC2);
  const named = Grid2DEditor.editAtSelection(ins.text, a, b, { type: 'insert', text: 'Gateway' });
  assert.deepEqual(parse(named.text).boxes.map((x) => x.lines[0]).sort(), ['Gateway', 'X']);
});

test('regression (PR #4 review): hitting the size limit is an error, never a fallback to plain editing', () => {
  const dia = Grid2DEditor.diamondTemplate('Q?').join('\n');
  const r1 = Grid2DEditor.typeInBox(dia, { r: 2, c: 5 }, null, { type: 'insert', text: 'a'.repeat(850) });
  assert.ok(r1 && r1.error, 'diamond: error, not null');
  const box = '+-----+\n| A   |\n+-----+';
  const r2 = Grid2DEditor.typeInBox(box, { r: 1, c: 3 }, null, { type: 'insert', text: 'b'.repeat(2500) });
  assert.ok(r2 && r2.error, 'box: error, not null');
  assert.match(r2.error, /too large/);
  // null still means exactly "not inside a box"
  assert.equal(Grid2DEditor.typeInBox(box + '\nfree', { r: 3, c: 1 }, null, { type: 'insert', text: 'x' }), null);
  assert.equal(Grid2DEditor.editAtSelection(box, 0, 0, { type: 'insert', text: 'x' }), null, 'on a corner');
});


test('regression (PR #4 follow-up review): relabelling a box to match another box is allowed', () => {
  const text = '+---+   +---+\n| A +-->| B |\n+---+   +---+';
  const start = text.indexOf('A');
  const res = Grid2DEditor.editAtSelection(text, start, start + 1, { type: 'insert', text: 'B' });
  assert.ok(!res.error, res.error);
  assert.equal(res.text, '+---+   +---+\n| B +-->| B |\n+---+   +---+');
  // ...and typing into a box whose label already matches another one
  const twins = '+---+   +---+\n| B +-->| B |\n+---+   +---+';
  const grow = Grid2DEditor.typeInBox(twins, { r: 1, c: 3 }, null, { type: 'insert', text: 'ee' });
  assert.ok(!grow.error, grow.error);
  assert.deepEqual(parse(grow.text).boxes.map((b) => b.lines[0]), ['Bee', 'B']);
  // The edited box is still tracked by identity: re-wiring it is still caught
  const three = '+---+   +---+\n| A +-->| B |\n+---+   +---+\n\n+---+\n| B |\n+---+';
  const moved = '+---+    +---+\n| B +--> | B |\n+---+    +---+\n\n+---+\n| B |\n+---+';
  const g = Grid2DEditor.guardOtherBoxes(three, { text: moved, cursorR: 1, cursorC: 2 }, 'test', parse(three).boxes[0], 0, true);
  assert.match(g.error, /change what a wire connects/);
});

test('inserting below a box moves boxes that straddle the line down whole instead of stretching them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { arch } = new Function(presetSrc + '\nreturn PRESETS;')();
  const before = parse(arch).boxes;
  const D = before.find((b) => b.macroKey === 'D');
  const res = Grid2DEditor.insertConnected(arch, D, 'below', 'box');
  assert.ok(!res.error, res.error);
  const after = parse(res.text).boxes;
  assert.equal(after.length, before.length + 1);
  for (const key of ['A', 'Q', 'S']) {
    const a = before.find((b) => b.macroKey === key), b = after.find((x) => x.macroKey === key);
    assert.deepEqual([b.r2 - b.r1, b.c1, b.c2], [a.r2 - a.r1, a.c1, a.c2], `[${key}] same size and columns`);
    assert.equal(b.r1 - a.r1, 5, `[${key}] moved down by the inserted rows`);
  }
  for (const label of ['API Gateway', 'Auth Verifier', 'Session Cache']) {
    const a = before.find((b) => b.lines[0] === label), b = after.find((x) => x.lines[0] === label);
    assert.deepEqual([b.r1, b.c1, b.r2, b.c2], [a.r1, a.c1, a.r2, a.c2], `${label} untouched`);
  }
  // [D] -> new box -> [A]: the existing connection is spliced, not broken
  const conn = (t) => {
    const p = new DitaaParser(LENIENT);
    const ast = p.parse(t);
    return p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].macroKey || ast.boxes[i].lines[0]).sort().join('-')).sort();
  };
  assert.ok(conn(res.text).includes('Component-D'));
  assert.ok(conn(res.text).includes('A-Component'));
  // A container around the source still stretches to hold the new shape
  const nested = [
    '+-------------------------+',
    '|         +-----+         |',
    '|         | In  |         |',
    '|         +-----+         |',
    '+-------------------------+'
  ].join('\n');
  const inner = parse(nested).boxes.find((b) => b.lines[0] === 'In');
  const r2 = Grid2DEditor.insertConnected(nested, inner, 'below', 'box');
  assert.ok(!r2.error, r2.error);
  const outer = parse(r2.text).boxes.find((b) => b.isContainer);
  assert.ok(outer && outer.r2 - outer.r1 > 4, 'container grew around the new shape');
});

test('inserting right of the top-left box of the pipeline example splices into its connection', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { arch } = new Function(presetSrc + '\nreturn PRESETS;')();
  const api = parse(arch).boxes.find((b) => b.lines[0] === 'API Gateway');
  const res = Grid2DEditor.insertConnected(arch, api, 'right', 'box');
  assert.ok(!res.error, res.error);
  // Attached on the line the existing wire leaves from, not the middle line
  assert.ok(res.text.split('\n')[2].startsWith('|    cBLU           +--->|  Component  +'));
  const p = new DitaaParser(LENIENT);
  const ast = p.parse(res.text);
  const conn = p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].lines[0] || ast.boxes[i].macroKey).sort().join(' – '));
  assert.ok(conn.includes('API Gateway – Component'));
  assert.ok(conn.includes('Auth Verifier – Component'));
  assert.ok(!conn.includes('API Gateway – Auth Verifier'));
});

test('wall edits are plain text editing; text between the walls auto-fits (border rule)', () => {
  const text = '+---------+\n| Hello   |\n+---------+';
  // Typing right before the right wall lands in the wall's column: plain editing
  assert.equal(type(text, 1, 10, { type: 'insert', text: '+' }), null);
  assert.equal(type(text, 1, 10, { type: 'insert', text: 'x' }), null);
  // Delete right before the right wall deletes the wall: plain editing
  assert.equal(type(text, 1, 10, { type: 'delete' }), null);
  // Backspace right after the left wall deletes the wall: plain editing
  assert.equal(type(text, 1, 1, { type: 'backspace' }), null);
  // One space before the wall is still text: it grows the box, keeping the space
  const grow = type(text, 1, 9, { type: 'insert', text: '!!' });
  assert.equal(grow.text.split('\n')[1], '| Hello  !! |');
  // '|' typed between the walls is text like any other character
  const bar = type(text, 1, 7, { type: 'insert', text: '|' });
  assert.equal(parse(bar.text).boxes[0].lines[0], 'Hello|');
  // The reported sequence: right wall deleted, arrowhead '<' now read as the wall; typing
  // '|' or '+' at that column is a wall edit and goes in as typed
  const broken = '+-------------+    +-----+\n|  Component  <---+ D   |\n+-------------+    +-----+';
  assert.equal(type(broken, 1, 14, { type: 'insert', text: '|' }), null);
  assert.equal(type(broken, 1, 14, { type: 'insert', text: '+' }), null);
});

test('a right-click near a nested box picks it; inserting left/above inside a container grows the container', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { nested } = new Function(presetSrc + '\nreturn PRESETS;')();
  for (const c of [1, 2, 3, 4]) assert.equal(Grid2DEditor.hitBoxSides(nested, 4, c).name, 'Ingress', `col ${c}`);
  assert.deepEqual(Grid2DEditor.hitBoxSides(nested, 4, 1).sides, ['left']);
  assert.equal(Grid2DEditor.hitBoxSides(nested, 0, 10).name, 'Cluster', 'a container is named by its own label');
  assert.equal(Grid2DEditor.hitBoxSides(nested, 2, 20), null, 'empty space inside a container: insert here');

  const ingress = (t) => parse(t).boxes.find((b) => b.lines[0] === 'Ingress');
  const left = Grid2DEditor.insertConnected(nested, ingress(nested), 'left', 'box');
  assert.ok(!left.error, left.error);
  const above = Grid2DEditor.insertConnected(left.text, ingress(left.text), 'above', 'box');
  assert.ok(!above.error, above.error);
  const ast = parse(above.text);
  const cluster = ast.boxes.find((b) => b.isContainer);
  for (const b of ast.boxes.filter((x) => !x.isContainer)) {
    assert.ok(b.r1 > cluster.r1 && b.r2 < cluster.r2 && b.c1 > cluster.c1 && b.c2 < cluster.c2, `${b.lines[0]} stays inside Cluster`);
  }
  const p = new DitaaParser(LENIENT);
  const conn = p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].lines[0]).sort().join(' – ')).sort();
  assert.deepEqual(conn, ['App Service – Database', 'App Service – Ingress', 'Component – Ingress', 'Component – Ingress']);
});

/* ---------------- Enter / +H: boxes beside keep their size ---------------- */

const READ_NEXT = [
  '+-----------+     +-------+',
  '| Read      +---->| Next  |',
  '|           |     |       |',
  '+-----------+     +---+---+',
  '                      |',
  '                      v',
  '                  +-------+',
  '                  | Below |',
  '                  +-------+'
].join('\n');

const geom = (t) => Object.fromEntries(parse(t).boxes.map((b) => [b.lines[0], [b.r1, b.c1, b.r2, b.c2]]));
const wiring = (t, rename = {}) => {
  const p = new DitaaParser(LENIENT);
  const ast = p.parse(t);
  return p.connections(ast).map((ids) => ids.map((i) => rename[ast.boxes[i].lines[0]] || ast.boxes[i].lines[0]).sort().join(' – ')).sort();
};

test('Enter in a box grows only that box; a box beside it keeps its size and its arrow', () => {
  const res = Grid2DEditor.typeInBox(READ_NEXT, { r: 1, c: 6 }, null, { type: 'newline' });
  assert.ok(res && !res.error, res && res.error);
  const before = geom(READ_NEXT), after = geom(res.text);
  assert.deepEqual(after.Read, [0, 0, 4, 12], 'Read grew by one line');
  assert.deepEqual(after.Next, before.Next, 'Next: same size, same place');
  assert.deepEqual(after.Below, [7, 18, 9, 26], 'Below moved down with everything under the change');
  assert.deepEqual(wiring(res.text), wiring(READ_NEXT), 'Read – Next arrow and Next – Below wire still connected');
  assert.equal(res.text.split('\n')[4], '+-----------+         |', 'the wire under Next stretches');
});

test('the +H button behaves like Enter: neighbours keep their size', () => {
  const read = parse(READ_NEXT).boxes.find((b) => b.lines[0] === 'Read');
  const res = Grid2DEditor.resizeBox(READ_NEXT, read, 0, 1);
  assert.ok(!res.error, res.error);
  assert.deepEqual(geom(res.text).Next, geom(READ_NEXT).Next);
  assert.deepEqual(wiring(res.text), wiring(READ_NEXT));
});

test('Enter in a diamond: the box beside it keeps its size and moves with the diamond\'s middle row', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { flowchart } = new Function(presetSrc + '\nreturn PRESETS;')();
  const L = flowchart.split('\n');
  const r = L.findIndex((l) => l.includes('Valid?'));
  const res = Grid2DEditor.typeInBox(flowchart, { r, c: L[r].indexOf('?') + 1 }, null, { type: 'newline' });
  assert.ok(res && !res.error, res && res.error);
  const before = parse(flowchart).boxes, after = parse(res.text).boxes;
  const find = (list, label) => list.find((b) => b.lines[0] === label);
  const se0 = find(before, 'Show error'), se1 = find(after, 'Show error');
  assert.deepEqual([se1.r2 - se1.r1, se1.c1, se1.c2], [se0.r2 - se0.r1, se0.c1, se0.c2], 'Show error keeps its size');
  const v1 = after.find((b) => b.shape === 'choice' && b.lines[0] === 'Valid?');
  assert.equal(v1.r2 - v1.r1, 6, 'the diamond grew by two lines (one each side of its centre)');
  // The "no" arrow leaves the diamond's middle row and still meets Show error's wall
  const no = parse(res.text).arrows.find((a) => a.dir === '>' && a.r === (v1.r1 + v1.r2) / 2);
  assert.ok(no && no.touchesBox, '"no" arrow still attached');
  assert.ok(no.r > se1.r1 && no.r < se1.r2, 'and level with Show error\'s side, not its corner');
  assert.deepEqual(wiring(res.text), wiring(flowchart));
});

/* ---------------- PR #8 review: vertical wires into a plain wall survive Enter / +H ---------------- */

test('regression (PR #8 review): Enter / +H beside a box keep a wire that meets its plain bottom wall', () => {
  const text = '+---+  +---+\n| A +->| B |\n+---+  +---+\n  ^      |\n  +------+';
  const B = parse(text).boxes[1];
  for (const [label, res] of [
    ['Enter in B', Grid2DEditor.typeInBox(text, { r: 1, c: 10 }, null, { type: 'newline' })],
    ['+H on B', Grid2DEditor.resizeBox(text, B, 0, 1)]
  ]) {
    assert.ok(res && !res.error, `${label}: ${res && res.error}`);
    assert.deepEqual(wiring(res.text), wiring(text), `${label}: same wiring`);
    const a = parse(res.text).boxes.find((b) => b.lines[0] === 'A');
    assert.deepEqual([a.r1, a.c1, a.r2, a.c2], [0, 0, 2, 4], `${label}: A keeps its size`);
    const up = parse(res.text).arrows.find((x) => x.dir === '^');
    assert.ok(up.touchesBox, `${label}: the ^ still touches A's wall`);
  }
});

test('regression (PR #8 review): Enter in [Q] and [S] of the pipeline example succeeds and keeps the wiring', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { arch } = new Function(presetSrc + '\nreturn PRESETS;')();
  const byKey = (t) => {
    const p = new DitaaParser(LENIENT);
    const ast = p.parse(t);
    return p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].macroKey || ast.boxes[i].lines[0]).sort().join(' – ')).sort();
  };
  for (const key of ['Q', 'S']) {
    const b = parse(arch).boxes.find((x) => x.macroKey === key);
    for (const r of [13, 14]) {
      // Enter at the end of the line's text (in the middle of "cBLU" it would split the tag)
      const line = arch.split('\n')[r].slice(b.c1 + 1, b.c2);
      const c = b.c1 + 1 + Math.max(1, line.replace(/\s+$/, '').length);
      const res = Grid2DEditor.typeInBox(arch, { r, c }, null, { type: 'newline' });
      assert.ok(res && !res.error, `[${key}] row ${r}: ${res && res.error}`);
      assert.deepEqual(byKey(res.text), byKey(arch), `[${key}] row ${r}: wiring`);
    }
  }
});

test('Enter at the end of the first line of every box in every preset succeeds and keeps the wiring', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const PRESETS = new Function(presetSrc + '\nreturn PRESETS;')();
  const sig = (t) => {
    const p = new DitaaParser(LENIENT);
    const ast = p.parse(t);
    const name = (b) => JSON.stringify([b.lines, b.macroKey, b.colorKey, b.shape]);
    return p.connections(ast).map((ids) => ids.map((i) => name(ast.boxes[i])).sort().join(' – ')).sort();
  };
  let checked = 0;
  for (const [preset, text] of Object.entries(PRESETS)) {
    for (const b of parse(text).boxes.filter((x) => !x.isContainer)) {
      const row = text.split('\n')[b.r1 + 1].slice(b.c1 + 1, b.c2);
      const end = row.replace(/\s+$/, '').length;
      const c = b.c1 + 1 + Math.max(1, end);
      if (c >= b.c2) continue; // no room before the wall on this line
      const res = Grid2DEditor.typeInBox(text, { r: b.r1 + 1, c }, null, { type: 'newline' });
      const label = `${preset}: ${b.macroKey || b.lines[0]}`;
      // A box inside another box only grows into empty space inside it; with none there,
      // auto-fit declines (the editor then types the newline as plain text)
      if (Grid2DEditor.enclosingBox(parse(text).boxes, b) && res && /Not enough empty space/.test(res.error || '')) continue;
      assert.ok(res && !res.error, `${label}: ${res && res.error}`);
      assert.equal(parse(res.text).boxes.length, parse(text).boxes.length, `${label}: box count`);
      assert.deepEqual(sig(res.text), sig(text), `${label}: wiring`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `checked ${checked} boxes`);
});

test('if growing only the edited box is refused, Enter / +H fall back to full-width lines (never a broken box)', () => {
  const original = Grid2DEditor.growRowsInPlace;
  // Simulate a layout the in-place growth can't handle: it tears the neighbour
  Grid2DEditor.growRowsInPlace = function (state, ys, src) {
    const at = Array.from({ length: state.cols }, (_, c) => (c >= src.c1 && c <= src.c2 ? ys.slice() : ys.map(() => state.rows)));
    this.insertRowsPerColumn(state, at);
  };
  try {
    const enter = Grid2DEditor.typeInBox(READ_NEXT, { r: 1, c: 6 }, null, { type: 'newline' });
    assert.ok(enter && !enter.error, enter && enter.error);
    assert.equal(parse(enter.text).boxes.length, 3);
    assert.deepEqual(wiring(enter.text), wiring(READ_NEXT));
    const read = parse(READ_NEXT).boxes.find((b) => b.lines[0] === 'Read');
    const taller = Grid2DEditor.resizeBox(READ_NEXT, read, 0, 1);
    assert.ok(!taller.error, taller.error);
    assert.equal(parse(taller.text).boxes.length, 3);
  } finally {
    Grid2DEditor.growRowsInPlace = original;
  }
});

/* ---------------- Connections ---------------- */

const CONN = [
  '+-------+          +-------+',
  '| A     |          | B     |',
  '|       |          |       |',
  '+-------+          +-------+',
  '',
  '         +------+',
  '         | Mid  |',
  '         +------+',
  '',
  '+-------+',
  '| C     |',
  '+-------+'
].join('\n');
const boxNamed = (t, n) => parse(t).boxes.find((b) => (b.macroKey || b.lines[0]) === n);
const connectNamed = (t, from, fromSide, to, toSide, opts = {}) => {
  const A = boxNamed(t, from), B = boxNamed(t, to);
  const start = Grid2DEditor.placePort(t, { box: A, sides: [fromSide] }, A.r1 + 1, A.c1 + 2);
  assert.ok(!start.error, start.error);
  return Grid2DEditor.connectToWall(start.text, start.port, { box: B, sides: [toSide] }, B.r1 + 1, B.c1 + 2, opts);
};

test('placePort puts a + on the wall cell nearest the click', () => {
  const A = boxNamed(CONN, 'A');
  const res = Grid2DEditor.placePort(CONN, { box: A, sides: ['below'] }, 5, 4);
  assert.deepEqual(res.port, { r: 3, c: 4 });
  assert.equal(res.text.split('\n')[3], '+---+---+          +-------+');
  assert.match(Grid2DEditor.placePort(CONN, { box: A, sides: ['below'] }, 3, 0).text.split('\n')[3], /^\+\+-/, 'corners are skipped');
});

test('a connection is routed around boxes, enters at right angles, and ends in an arrowhead', () => {
  const res = connectNamed(CONN, 'A', 'below', 'C', 'above', { arrow: true });
  assert.ok(!res.error, res.error);
  assert.deepEqual(wiring(res.text), ['A – C']);
  const arrow = parse(res.text).arrows.find((a) => a.dir === 'v');
  assert.ok(arrow && arrow.touchesBox, 'arrowhead touches C');
  const around = connectNamed(CONN, 'A', 'below', 'B', 'below', {});
  assert.ok(!around.error, around.error);
  assert.deepEqual(wiring(around.text), ['A – B']);
  assert.deepEqual(parse(around.text).boxes.find((b) => b.lines[0] === 'Mid').lines, ['Mid'], 'Mid untouched');
});

test('connection styles: dashed and plain (no arrowhead)', () => {
  const dashed = connectNamed(CONN, 'A', 'below', 'C', 'above', { dashed: true, arrow: true });
  assert.ok(parse(dashed.text).wires.every((w) => w.dashed), 'dashed');
  const plain = connectNamed(CONN, 'A', 'below', 'C', 'above', { arrow: false });
  assert.equal(parse(plain.text).arrows.length, 0, 'no arrowhead');
  assert.deepEqual(wiring(plain.text), ['A – C']);
});

test('a connection through a container wall replaces that wall cell with + and goes through', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { nested } = new Function(presetSrc + '\nreturn PRESETS;')();
  const t = nested + '\n\n  +---------+\n  | Outside |\n  +---------+';
  const res = connectNamed(t, 'Outside', 'above', 'Ingress', 'below', { arrow: true });
  assert.ok(!res.error, res.error);
  const cluster = parse(res.text).boxes.find((b) => b.isContainer);
  assert.ok(cluster, 'Cluster is still a box');
  const wallRow = res.text.split('\n')[cluster.r2];
  assert.ok(/^\+-*\+-*\+$/.test(wallRow.trim()) && (wallRow.match(/\+/g) || []).length === 3, `crossing drawn as +: ${wallRow}`);
  assert.equal(parse(res.text).boxes.length, parse(t).boxes.length, 'no box broken');
});

test('a connection crosses an existing line with + only when unavoidable, never next to a box', () => {
  // D above the A -> B line, C below it, both between A and B: C -> D must cross the line
  const t = [
    '       +-----+',
    '       | D   |',
    '       +-----+',
    '',
    '+-----+           +-----+',
    '| A   +---------->| B   |',
    '+-----+           +-----+',
    '',
    '',
    '       +-----+',
    '       | C   |',
    '       +-----+'
  ].join('\n');
  const res = connectNamed(t, 'C', 'above', 'D', 'below', { arrow: true });
  assert.ok(!res.error, res.error);
  const row = res.text.split('\n')[5];
  const plus = [...row].map((ch, i) => (ch === '+' ? i : -1)).filter((i) => i > 6 && i < 18);
  assert.ok(plus.length >= 1, `crossing on the A -> B line: ${row}`);
  for (const i of plus) assert.ok(row[i - 1] === '-' && row[i + 1] === '-', 'not right next to a box wall');
  assert.equal(parse(res.text).boxes.length, 4);
});

test('connection errors: no route, and a start point that is no longer on a wall', () => {
  const boxed = [
    '+---------------+',
    '|  +-----+      |',
    '|  | In  |      |',
    '|  +-----+      |',
    '+---------------+',
    '+-----+',
    '| Far |',
    '+-----+'
  ].join('\n');
  // In is a leaf inside a container; a start on In with no clear path out to Far's (blocked) wall
  const r1 = Grid2DEditor.connectPorts(CONN, { r: 6, c: 12 }, { r: 3, c: 4 });
  assert.match(r1.error, /no longer on a wall, a line or empty space/);
  const far = boxNamed(boxed, 'Far');
  const start = Grid2DEditor.placePort(boxed, { box: far, sides: ['left'] }, 6, 0);
  assert.ok(start.error || start.port, 'a 1-line box wall can still take a point');
});

/* ---------------- PR #9 review + sticky connection points ---------------- */

test('regression (PR #9 review): a new route never joins an unrelated line by touching it', () => {
  const t = [
    '      +---+     +---+',
    '    +>+ B |     | C |',
    '    | +---+     +---+',
    '    |',
    '    +------------+        +---+',
    '                 |        | D |',
    '            +---+|        +---+',
    '            | A ++',
    '            +---+'
  ].join('\n');
  const p = new DitaaParser(LENIENT);
  const boxes = p.parse(t).boxes;
  const C = boxes.find((b) => b.lines[0] === 'C');
  const D = boxes.find((b) => b.lines[0] === 'D');
  const start = Grid2DEditor.placePort(t, { box: C, sides: ['below'] }, 1, 18);
  const res = Grid2DEditor.connectToWall(start.text, start.port, { box: D, sides: ['above'] }, 5, 28);
  assert.ok(!res.error, res.error);
  assert.deepEqual(wiring(res.text), ['A – B', 'C – D'], 'A–B and C–D stay separate');
});



test('moving boxes in the examples keeps every connection (typed ASCII arrows are connections too)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const PRESETS = new Function(presetSrc + '\nreturn PRESETS;')();
  const nm = (b) => b.macroKey || b.lines[0];
  const byName = (t) => {
    const p = new DitaaParser(LENIENT);
    const ast = p.parse(t);
    return p.connections(ast).map((ids) => ids.map((i) => nm(ast.boxes[i])).sort().join(' – ')).sort();
  };
  for (const [preset, key, dr, dc] of [['arch', 'Q', 1, 0], ['arch', 'Q', 0, 1], ['arch', 'D', 0, 1],
    ['arch', 'Session Cache', 0, -1], ['flowchart', 'Process', 1, 0], ['flowchart', 'Show error', 0, 1]]) {
    const t = PRESETS[preset];
    const b = parse(t).boxes.find((x) => nm(x) === key);
    const res = Grid2DEditor.shiftBoxWithElasticWires(t, b, dr, dc);
    assert.ok(!res.error, `${preset} ${key}: ${res.error}`);
    assert.deepEqual(byName(res.text), byName(t), `${preset}: move ${key}`);
  }
});

/* ---------------- Boxes inside boxes resize into empty space only ---------------- */

const NESTED3 = [
  '+------------------------------------+',
  '|  Outer                             |',
  '|   +--------------------------+     |',
  '|   |  Mid                     |     |',
  '|   |   +-----+                |     |',
  '|   |   | In  |                |     |',
  '|   |   +-----+                |     |',
  '|   |                          |     |',
  '|   +--------------------------+     |',
  '+------------------------------------+'
].join('\n');
const rectOf = (t, pick) => { const b = parse(t).boxes.find(pick); return [b.r1, b.c1, b.r2, b.c2]; };
const isOuter = (b) => b.r1 === 0;
const isMid = (b) => b.r1 === 2;

test('resizing a box inside boxes uses the empty space; the outer boxes never change', () => {
  let t = NESTED3;
  const inner = () => parse(t).boxes.find((b) => b.lines[0] === 'In');
  for (const [dw, dh] of [[2, 0], [2, 0], [0, 1]]) {
    const res = Grid2DEditor.resizeBox(t, inner(), dw, dh);
    assert.ok(!res.error, res.error);
    t = res.text;
    assert.deepEqual(rectOf(t, isOuter), rectOf(NESTED3, isOuter), 'Outer unchanged');
    assert.deepEqual(rectOf(t, isMid), rectOf(NESTED3, isMid), 'Mid unchanged');
  }
  assert.deepEqual(rectOf(t, (b) => b.lines[0] === 'In'), [4, 8, 7, 18]);
  // No empty space left below (Mid's wall): the user must make Mid bigger first
  const full = Grid2DEditor.resizeBox(t, inner(), 0, 1);
  assert.match(full.error, /Not enough empty space inside “Mid”: make it bigger first/);
  // Narrowing back works and leaves the space empty again
  const back = Grid2DEditor.resizeBox(t, inner(), -2, 0);
  assert.ok(!back.error, back.error);
  assert.deepEqual(rectOf(back.text, (b) => b.lines[0] === 'In'), [4, 8, 7, 16]);
});

test('a diamond inside a box grows around its centre into the empty space', () => {
  const t = [
    '+-----------------------------+',
    '|                             |',
    '|      +-------+-------+      |',
    '|      |               |      |',
    '|      +    Ok? {c}    +      |',
    '|      |               |      |',
    '|      +-------+-------+      |',
    '|                             |',
    '+-----------------------------+'
  ].join('\n');
  const d = parse(t).boxes.find((b) => b.shape === 'choice');
  const res = Grid2DEditor.resizeBox(t, d, 2, 1);
  assert.ok(!res.error, res.error);
  const d2 = parse(res.text).boxes.find((b) => b.shape === 'choice');
  assert.deepEqual([d2.r1, d2.c1, d2.r2, d2.c2], [1, 6, 7, 24]);
  assert.equal((d2.c1 + d2.c2) / 2, (d.c1 + d.c2) / 2, 'centre unchanged');
  assert.equal((d2.r1 + d2.r2) / 2, (d.r1 + d.r2) / 2, 'middle unchanged');
  assert.deepEqual(rectOf(res.text, (b) => b.isContainer), rectOf(t, (b) => b.isContainer), 'container unchanged');
});

test('typing and Enter in a nested box grow it into empty space only', () => {
  let res = type(NESTED3, 5, 12, { type: 'insert', text: 'ner box' });
  assert.ok(!res.error, res.error);
  assert.deepEqual(parse(res.text).boxes.find((b) => b.lines[0] === 'Inner box').c2, 20);
  res = type(res.text, 5, 19, { type: 'newline' });
  assert.ok(!res.error, res.error);
  const inner = parse(res.text).boxes.find((b) => b.lines[0] === 'Inner box');
  assert.equal(inner.r2 - inner.r1, 3, 'one line taller');
  assert.deepEqual(rectOf(res.text, isMid), rectOf(NESTED3, isMid));
  assert.deepEqual(rectOf(res.text, isOuter), rectOf(NESTED3, isOuter));
  // No room left: auto-fit declines rather than growing Mid (the editor types it plainly)
  const again = type(res.text, 6, 10, { type: 'newline' });
  assert.match(again.error, /Not enough empty space/);
});

/* ---------------- Connections between lines and empty space ---------------- */

test('a connection mends a gap in a line: the two line ends are joined straight', () => {
  const t = [
    '+---+                +---+',
    '| A +------    ----->+ B |',
    '+---+                +---+'
  ].join('\n');
  const res = Grid2DEditor.connectTo(t, { r: 1, c: 10 }, 1, 15, { arrow: true });
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[1], '| A +--------------->+ B |', 'no arrowhead where it joins a line');
});

test('a connection from a line end to a box, and from empty space onto a line (a T)', () => {
  const t = [
    '+---+',
    '| A +------',
    '+---+',
    '',
    '',
    '              +---+',
    '              | B |',
    '              +---+'
  ].join('\n');
  // The line end continues to B's wall: the old end turns into a corner
  const toB = Grid2DEditor.connectTo(t, { r: 1, c: 10 }, 6, 14, { arrow: true });
  assert.ok(!toB.error, toB.error);
  assert.deepEqual(toB.text.split('\n').slice(1, 7), [
    '| A +-----+',
    '+---+     |',
    '          |',
    '          |',
    '          |   +---+',
    '          +-->+ B |'
  ]);
  // From an empty cell to the middle of the line: it joins with a '+', no arrowhead
  const start = Grid2DEditor.startConnection(t, 4, 1);
  assert.equal(start.text, t, 'starting in empty space changes nothing yet');
  const tee = Grid2DEditor.connectTo(t, start.port, 1, 8, { arrow: true });
  assert.ok(!tee.error, tee.error);
  const ls = tee.text.split('\n');
  assert.equal(ls[1][8], '+', 'joined from the side');
  assert.equal(ls[4][1], '-', 'starts right on the empty cell');
});

test('a connection from an arrowhead continues the arrow; one can end in empty space', () => {
  const t = ['+---+', '| A +----->', '+---+'].join('\n');
  const res = Grid2DEditor.connectTo(t, { r: 1, c: 10 }, 1, 16, { arrow: true });
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[1], '| A +----------->', 'the old arrowhead becomes line; the new one is at the end');
  const dashed = Grid2DEditor.connectTo(t, { r: 1, c: 10 }, 1, 16, { arrow: false, dashed: true });
  assert.equal(dashed.text.split('\n')[1], '| A +-------=-=-=', 'the old arrowhead becomes line; the new line is dashed the plain-ditaa way');
});

test('connection ends: text is refused; a click inside a box or next to it goes to the wall', () => {
  const t = ['', '   +---+   note', '   | A |', '   +---+', ''].join('\n');
  assert.equal(Grid2DEditor.connectionTarget(t, 1, 12), null, 'text');
  assert.match(Grid2DEditor.startConnection(t, 1, 12).error, /not on text/);
  assert.equal(Grid2DEditor.connectionTarget(t, 2, 5).kind, 'wall', 'inside the box');
  assert.equal(Grid2DEditor.connectionTarget(t, 2, 8).kind, 'wall', 'right next to it');
  assert.equal(Grid2DEditor.connectionTarget(t, 2, 10).kind, 'free', 'further away');
  const res = Grid2DEditor.connectTo(t, { r: 2, c: 10 }, 2, 6, { arrow: true });
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[2], '   | A +<--', 'from the empty cell clicked');
});

test('mending a box wall with a connection is allowed (it completes the box)', () => {
  const t = ['+------+', '| A    |', '+--  --+'].join('\n');
  const res = Grid2DEditor.connectTo(t, { r: 2, c: 2 }, 2, 5, { arrow: true });
  assert.ok(!res.error, res.error);
  assert.equal(res.text.split('\n')[2], '+------+');
  assert.equal(parse(res.text).boxes.length, 1);
});

/* ---------------- Block selection: whole rows, whole columns, rectangles ---------------- */

const ROWCOL = [
  '+---+    +---+',
  '| A +--->+ B |',
  '+-+-+    +-+-+',
  '  |        |',
  '  v        v',
  '+---+    +---+',
  '| C |    | D |',
  '+---+    +---+',
  '',
  '# [D] = Thing'
].join('\n');

test('a block is whole rows when it spans the width, whole columns when it spans the diagram (not the legend)', () => {
  const G = Grid2DEditor;
  assert.equal(G.diagramLineCount(ROWCOL), 8);
  // A drag has to reach past the content to mean whole rows / columns...
  assert.equal(G.blockKind(ROWCOL, { r1: 3, r2: 3, c1: 0, c2: 14 }), 'rows');
  assert.equal(G.blockKind(ROWCOL, { r1: 0, r2: 8, c1: 6, c2: 6 }), 'cols');
  assert.equal(G.blockKind(ROWCOL, { r1: 0, r2: 2, c1: 0, c2: 4 }), 'rect');
  // ...so a box that happens to span the whole diagram is still a rectangle
  assert.equal(G.blockKind(ROWCOL, { r1: 0, r2: 7, c1: 0, c2: 13 }), 'rect');
  assert.equal(G.blockKind(ROWCOL, { r1: 0, r2: 2, c1: 0, c2: 13 }), 'rect');
  // An explicit choice (Select row / column / box) wins
  assert.equal(G.blockKind(ROWCOL, { r1: 3, r2: 3, c1: 0, c2: 13, kind: 'rows' }), 'rows');
  assert.equal(G.blockKind(ROWCOL, { r1: 0, r2: 7, c1: 0, c2: 13, kind: 'rect' }), 'rect');
  assert.deepEqual(G.blockCopy(ROWCOL, { r1: 3, r2: 3, c1: 0, c2: 20 }), { text: '  |        |', kind: 'rows' });
  assert.equal(G.blockCopy(ROWCOL, { r1: 0, r2: 9, c1: 6, c2: 6 }).text.split('\n').length, 8, 'stops at the legend');
});

test('pasting a copied row inserts a line: vertical lines through it get longer', () => {
  const G = Grid2DEditor;
  const { text, kind } = G.blockCopy(ROWCOL, { r1: 3, r2: 3, c1: 0, c2: 13, kind: 'rows' });
  const res = G.pasteBlockInsert(ROWCOL, 3, 5, text, kind);
  assert.deepEqual(res.text.split('\n').slice(2, 6), ['+-+-+    +-+-+', '  |        |', '  |        |', '  v        v']);
  assert.equal(parse(res.text).boxes.length, 4);
  // ...and cutting rows in insert mode takes the lines out again
  assert.equal(G.removeBlock(res.text, { r1: 3, r2: 3, c1: 0, c2: 13, kind: 'rows' }, false).text, ROWCOL);
});

test('pasting a copied column inserts it on every diagram line: horizontal lines get longer, the legend is untouched', () => {
  const G = Grid2DEditor;
  const { text, kind } = G.blockCopy(ROWCOL, { r1: 0, r2: 7, c1: 6, c2: 6, kind: 'cols' });
  const res = G.pasteBlockInsert(ROWCOL, 4, 6, text, kind);
  const ls = res.text.split('\n');
  assert.equal(ls[1], '| A +---->+ B |');
  assert.equal(ls[6], '| C |     | D |');
  assert.equal(ls[9], '# [D] = Thing');
  assert.equal(G.removeBlock(res.text, { r1: 0, r2: 7, c1: 6, c2: 6, kind: 'cols' }, false).text, ROWCOL);
  // In overwrite mode the same paste writes over the column from the top instead
  const over = G.pasteBlockOverwrite(ROWCOL, 4, 2, text, kind);
  assert.equal(over.text.split('\n')[1], '| - +--->+ B |');
});

/* ---------------- PR #10 review ---------------- */

test('regression (PR #10 review): a connection in empty space ends exactly on the cell clicked, past the text in any direction', () => {
  const G = Grid2DEditor;
  for (const t of ['', '+---+\n| A |\n+---+']) {
    for (const [r, c] of [[0, 50], [12, 4], [20, 60], [3, 0]]) {
      const from = t ? { r: 1, c: 4 } : { r: 0, c: 0 };
      const start = G.startConnection(t, from.r, from.c);
      assert.ok(!start.error, start.error);
      const res = G.connectTo(t, start.port, r, c, { arrow: true });
      assert.ok(!res.error, `${JSON.stringify(t)} → (${r},${c}): ${res.error}`);
      assert.deepEqual([res.cursorR, res.cursorC], [r, c], 'the end is the clicked cell');
      assert.match(res.text.split('\n')[r][c], /[<>^v]/, 'with the arrowhead on it');
    }
  }
});

test('regression (PR #10 review): pasting whole columns never writes into the legend or comments', () => {
  const G = Grid2DEditor;
  const { text, kind } = G.blockCopy('axx\nbxx\ncxx\ndxx', { r1: 0, r2: 3, c1: 0, c2: 0, kind: 'cols' });
  assert.equal(kind, 'cols');
  // Taller than the destination's diagram: blank lines are added above the footer first
  assert.equal(G.pasteBlockInsert('XX\nYY\n# keep', 0, 0, text, kind).text, 'aXX\nbYY\nc\nd\n# keep');
  assert.equal(G.pasteBlockOverwrite('XX\nYY\n# keep', 0, 0, text, kind).text, 'aX\nbY\nc\nd\n# keep');
  // Shorter: in insert mode every diagram line still shifts together; the legend doesn't
  const dest = 'XX\nYY\nZZ\nWW\nVV\n\n# [D] = keep';
  assert.equal(G.pasteBlockInsert(dest, 0, 1, 'a\nb', 'cols').text, 'XaX\nYbY\nZ Z\nW W\nV V\n\n# [D] = keep');
  assert.equal(G.pasteBlockOverwrite(dest, 0, 1, 'a\nb', 'cols').text, 'Xa\nYb\nZZ\nWW\nVV\n\n# [D] = keep');
});

test('regression (PR #10 review): deleting every row leaves an empty text with the caret at (0, 0)', () => {
  const G = Grid2DEditor;
  const res = G.removeBlock('abc', { r1: 0, r2: 0, c1: 0, c2: 2 }, false);
  assert.deepEqual(res, { text: '', cursorR: 0, cursorC: 0 });
  assert.equal(G.overwriteBlock(res.text, res.cursorR, res.cursorC, 'X').text, 'X');
  assert.equal(G.overwriteBlock('', -1, -1, 'X').text, 'X', 'a stale negative caret is clamped');
});

test('regression (PR #10 review): cutting whole columns and pasting them straight back gives back the same text', () => {
  const G = Grid2DEditor;
  const texts = ['AA\n B\n# keep', 'AA\n B', 'AA\n B\n\n# keep', '+--+\n|AB|\n+--+\n\n# [D] = x', ROWCOL];
  for (const overwrite of [false, true]) {
    for (const t of texts) {
      for (const c of [0, 1, 2]) {
        let x = t;
        for (let i = 0; i < 3; i++) { // repeating it must not add a line each time either
          const b = { r1: 0, r2: G.diagramLineCount(x) - 1, c1: c, c2: c, kind: 'cols' };
          const { text, kind } = G.blockCopy(x, b);
          assert.equal(kind, 'cols');
          const cut = G.removeBlock(x, b, overwrite).text;
          x = (overwrite ? G.pasteBlockOverwrite : G.pasteBlockInsert).call(G, cut, 0, c, text, kind).text;
        }
        assert.equal(x, t, `${overwrite ? 'OVR' : 'INS'} column ${c} of ${JSON.stringify(t)}`);
      }
    }
  }
});

/* ---------------- Draw a box around a block; right-click insert in overwrite mode ---------------- */

test('a box drawn around a block: insert mode makes room and lines crossing it join with +', () => {
  const G = Grid2DEditor;
  const res = G.drawBoxAround(ROWCOL, { r1: 0, c1: 0, r2: 2, c2: 13 }, { wrap: true });
  assert.ok(!res.error, res.error);
  assert.deepEqual(res.text.split('\n').slice(0, 8), [
    '+--------------+',
    '|+---+    +---+|',
    '|| A +--->+ B ||',
    '|+-+-+    +-+-+|',
    '|  |        |  |', // the lines leaving A and B keep a piece inside the new box
    '+--+--------+--+',
    '   |        |',
    '   v        v'
  ]);
  assert.equal(parse(res.text).boxes.length, 5, 'one more box; the arrows below still reach C and D');
  assert.ok(res.text.endsWith('# [D] = Thing'), 'the legend is untouched');
  // An arrow pointing into the block still touches what it pointed at (one more line or
  // column on that side makes room for its arrowhead inside the new box)
  const wrap = (t, b) => G.drawBoxAround(t, b, { wrap: true }).text.split('\n');
  assert.deepEqual(wrap('  |\n  v\n+---+\n| C |\n+---+', { r1: 2, c1: 0, r2: 4, c2: 4 }),
    ['   |', '   |', '+--+--+', '|  v  |', '|+---+|', '|| C ||', '|+---+|', '+-----+']);
  assert.deepEqual(wrap('+---+\n| C |\n+---+\n  ^\n  |', { r1: 0, c1: 0, r2: 2, c2: 4 }),
    ['+-----+', '|+---+|', '|| C ||', '|+---+|', '|  ^  |', '+--+--+', '   |', '   |']);
  assert.equal(wrap('    +---+\n--->| C |\n    +---+', { r1: 0, c1: 4, r2: 2, c2: 8 })[2], '--+>| C ||', 'uses the space already there');
  assert.equal(wrap('+---+\n| C |<---\n+---+', { r1: 0, c1: 0, r2: 2, c2: 4 })[2], '|| C |<+--');
});

test('a box drawn around a block in overwrite mode goes on the block\'s edge; rounded corners', () => {
  const G = Grid2DEditor;
  const t = ['       ', '  ab   ', '  cd   ', '       '].join('\n');
  assert.equal(G.drawBoxAround(t, { r1: 0, c1: 0, r2: 3, c2: 6 }, {}).text, ['+-----+', '| ab  |', '| cd  |', '+-----+'].join('\n'));
  assert.equal(G.drawBoxAround(t, { r1: 0, c1: 0, r2: 3, c2: 6 }, { rounded: true }).text, ['/-----\\', '| ab  |', '| cd  |', '\\-----/'].join('\n'));
  assert.match(G.drawBoxAround(t, { r1: 1, c1: 1, r2: 1, c2: 5 }, {}).error, /at least 2×2/);
});

test('right-click insert in overwrite mode draws over a container wall instead of growing the container', () => {
  const G = Grid2DEditor;
  const t = [
    '+--------------------+',
    '|  +-----+           |',
    '|  |  A  |           |',
    '|  +-----+           |',
    '+--------------------+'
  ].join('\n');
  const a = parse(t).boxes.find((b) => b.lines[0] === 'A');
  const ins = G.insertConnected(t, a, 'right', 'box');
  assert.ok(!ins.error, ins.error);
  const over = G.insertConnected(t, a, 'right', 'box', { overwrite: true });
  assert.ok(!over.error, over.error);
  assert.equal(over.text.split('\n')[0], '+--------------------+', 'the container keeps its size');
  assert.match(over.text.split('\n')[2], /\|  \|  A  \+--->\|  Component  \|/);
  assert.ok(ins.text.split('\n')[0].length > 22, 'insert mode makes room (the container grows)');
});

/* ---------------- PR #11 review ---------------- */

const conns = (t) => {
  const p = new DitaaParser(LENIENT);
  const ast = p.parse(t);
  return p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].lines[0] || 'container').sort().join('–')).sort();
};

test('regression (PR #11 review): wrapping a box keeps plain lines attached to it (walls and ports, both ways)', () => {
  const G = Grid2DEditor;
  const cases = [
    // [text, the box to wrap, the row to check, what it should read]
    ['+---+   +---+\n| A |---| B |\n+---+   +---+', 'B', 2, '| A |-+-| B ||'], // the border goes in the gap that is there
    ['+---+   +---+\n| A +---+ B |\n+---+   +---+', 'B', 2, '| A +-+-+ B ||'],
    ['+---+   +---+\n| A |---| B |\n+---+   +---+', 'A', 2, '|| A |-+-| B |'],
    ['+---+\n| A |\n+-+-+\n  |\n  |\n+-+-+\n| B |\n+---+', 'B', 6, '|  |  |'],
    ['+---+\n| A |\n+---+\n  |\n  |\n+---+\n| B |\n+---+', 'B', 6, '|  |  |'],
    ['+---+\n| A |\n+-+-+\n  |\n  |\n+-+-+\n| B |\n+---+', 'A', 4, '|  |  |']
  ];
  for (const [t, name, row, line] of cases) {
    const b = parse(t).boxes.find((x) => x.lines[0] === name);
    const res = G.drawBoxAround(t, b, { wrap: true });
    assert.ok(!res.error, res.error);
    assert.equal(res.text.split('\n')[row], line, `${name} in ${JSON.stringify(t)}:\n${res.text}`);
    const after = conns(res.text);
    assert.ok(after.includes(`${name}–container`), `${name} is still wired: ${after}`);
    const other = name === 'A' ? 'B' : 'A';
    assert.ok(after.includes(`${other}–container`), `${other} is still wired: ${after}`);
    assert.equal(parse(res.text).boxes.length, 3);
  }
});

test('regression (PR #11 review): wrapping a block never rewrites labels outside it; empty space is used as it is', () => {
  const G = Grid2DEditor;
  const t = '+----------+\n| HEADLINE |\n+----------+\n\n  XY';
  const res = G.drawBoxAround(t, { r1: 4, c1: 2, r2: 4, c2: 3 }, { wrap: true });
  assert.equal(res.text, '+----------+\n| HEADLINE |\n+----------+\n +--+\n |XY|\n +--+');
  assert.deepEqual(parse(res.text).boxes.map((b) => b.lines[0]), ['HEADLINE', 'XY']);
  // When columns must be made, a label above or below gets its gap after the label
  const tight = '+----------+\n| HEADLINE |\n+----------+\nXY';
  const r2 = G.drawBoxAround(tight, { r1: 3, c1: 0, r2: 3, c2: 1 }, { wrap: true });
  assert.ok(parse(r2.text).boxes.some((b) => b.lines[0] === 'HEADLINE'), r2.text);
  const labels = [
    ['| Big Label  |', 'XY'],
    ['|  App Service  |', 'AB']
  ];
  for (const [label, sel] of labels) {
    const w = label.length;
    const src = ['+' + '-'.repeat(w - 2) + '+', label, '+' + '-'.repeat(w - 2) + '+', ' '.repeat(3) + sel + ' ' + 'z'].join('\n');
    const out = G.drawBoxAround(src, { r1: 3, c1: 3, r2: 3, c2: 4 }, { wrap: true });
    assert.equal(parse(out.text).boxes.find((b) => b.r1 === 0).lines[0], label.slice(1, -1).trim(), out.text);
  }
});

test('regression (PR #11 re-review): wrapping either box keeps a connector of any length attached at both ends', () => {
  const G = Grid2DEditor;
  for (let gap = 1; gap <= 4; gap++) {
    const sp = ' '.repeat(gap);
    const horizontal = `+---+${sp}+---+\n| A |${'-'.repeat(gap)}| B |\n+---+${sp}+---+`;
    const vertical = '+---+\n| A |\n+---+\n' + '  |\n'.repeat(gap) + '+---+\n| B |\n+---+';
    const ported = `+---+${sp}+---+\n| A +${'-'.repeat(gap)}+ B |\n+---+${sp}+---+`;
    for (const t of [horizontal, vertical, ported]) {
      assert.deepEqual(conns(t), ['A–B']);
      for (const name of ['A', 'B']) {
        const b = parse(t).boxes.find((x) => x.lines[0] === name);
        const res = G.drawBoxAround(t, b, { wrap: true });
        assert.ok(!res.error, res.error);
        assert.deepEqual(conns(res.text), ['A–container', 'B–container'], `gap ${gap}, wrapping ${name}:\n${res.text}`);
      }
    }
  }
  // The two-cell case from the review: the border may not take A's last wire cell
  const t2 = '+---+  +---+\n| A |--| B |\n+---+  +---+';
  const b2 = parse(t2).boxes.find((x) => x.lines[0] === 'B');
  assert.equal(G.drawBoxAround(t2, b2, { wrap: true }).text.split('\n')[2], '| A |--+-| B ||');
});

test('regression (PR #11 re-review): making a column never edits label text elsewhere (punctuation, inner spaces, free text)', () => {
  const G = Grid2DEditor;
  for (const label of ['API-Gateway', 'API Gateway', 'a, b. c', 'x  y']) {
    const w = label.length + 4;
    const t = `+${'-'.repeat(w - 2)}+\n| ${label} |\n+${'-'.repeat(w - 2)}+\n XYz`;
    const res = G.drawBoxAround(t, { r1: 3, c1: 1, r2: 3, c2: 2 }, { wrap: true }); // the 'z' forces room to be made
    const top = parse(res.text).boxes.find((b) => b.r1 === 0);
    assert.equal(top.lines[0], label, res.text);
    assert.equal(res.text.split('\n')[1].slice(0, label.length + 2), `| ${label}`, 'not moved or re-spaced');
  }
  const free = 'API-Gateway and more\n\n XYz';
  assert.equal(G.drawBoxAround(free, { r1: 2, c1: 1, r2: 2, c2: 2 }, { wrap: true }).text.split('\n')[0], 'API-Gateway and more');
});

test('regression (PR #11 review 3): a one-cell arrow stays attached at both ends, pointing the same way, whichever box is wrapped', () => {
  const G = Grid2DEditor;
  const cases = [
    ['+---+ +---+\n| A |>| B |\n+---+ +---+', '>', 'right'],
    ['+---+ +---+\n| A |<| B |\n+---+ +---+', '<', 'left'],
    ['+---+\n| A |\n+---+\n  v\n+---+\n| B |\n+---+', 'v', 'down'],
    ['+---+\n| A |\n+---+\n  ^\n+---+\n| B |\n+---+', '^', 'up']
  ];
  for (const [t, head] of cases) {
    assert.deepEqual(conns(t), ['A–B']);
    for (const name of ['A', 'B']) {
      const b = parse(t).boxes.find((x) => x.lines[0] === name);
      const res = G.drawBoxAround(t, b, { wrap: true });
      assert.deepEqual(conns(res.text), ['A–container', 'B–container'], `wrapping ${name}:\n${res.text}`);
      const heads = [...res.text].filter((ch) => '<>^v'.includes(ch));
      assert.deepEqual(heads, [head], `one arrowhead, still pointing the same way:\n${res.text}`);
    }
  }
  const one = '+---+ +---+\n| A |>| B |\n+---+ +---+';
  assert.equal(G.drawBoxAround(one, parse(one).boxes.find((x) => x.lines[0] === 'A'), { wrap: true }).text.split('\n')[2], '|| A |-+>| B |');
});

test('regression (PR #11 review 3): free text right above or below the block is kept verbatim', () => {
  const G = Grid2DEditor;
  assert.equal(G.drawBoxAround('API-Gateway\n XYz', { r1: 1, c1: 1, r2: 1, c2: 2 }, { wrap: true }).text,
    'API-Gateway\n +--+\n |XY|z\n +--+');
  const below = G.drawBoxAround(' XYz\nAPI Gateway, v2', { r1: 0, c1: 1, r2: 0, c2: 2 }, { wrap: true }).text.split('\n');
  assert.equal(below[below.length - 1], 'API Gateway, v2');
  const boxed = G.drawBoxAround('+-------------+\n| API-Gateway |\n+-------------+\n XYz', { r1: 3, c1: 1, r2: 3, c2: 2 }, { wrap: true });
  assert.equal(parse(boxed.text).boxes.find((b) => b.r1 === 0).lines[0], 'API-Gateway');
});

/* ---------------- Moving a block of characters ---------------- */

test('moving a block moves its characters together; lines attached behind it stretch, lines ahead get shorter', () => {
  const G = Grid2DEditor;
  const t = '+---+    +---+\n| A +--->+ B |\n+---+    +---+';
  const A = { r1: 0, c1: 0, r2: 2, c2: 4 }, B = { r1: 0, c1: 9, r2: 2, c2: 13 };
  const row = (res) => res.text.split('\n')[1];
  assert.equal(row(G.moveBlock(t, B, 0, 1)), '| A +---->+ B |', 'the arrow follows B');
  assert.equal(row(G.moveBlock(t, B, 0, -1)), '| A +-->+ B |', 'B moves into the arrow: shorter, arrowhead kept');
  assert.equal(row(G.moveBlock(t, A, 0, 1)), ' | A +-->+ B |');
  assert.deepEqual(G.moveBlock(t, B, 0, 1).block, { r1: 0, c1: 10, r2: 2, c2: 14 });
  assert.equal(conns(G.moveBlock(t, B, 0, 1).text).join(), 'A–B');
  const v = '+---+\n| A |\n+-+-+\n  |\n  v\n+-+-+\n| B |\n+---+';
  const B2 = { r1: 5, c1: 0, r2: 7, c2: 4 };
  assert.deepEqual(G.moveBlock(v, B2, 1, 0).text.split('\n').slice(3, 6), ['  |', '  |', '  v']);
  // moving into it would leave a bare 'v' (plain ditaa needs a shaft): INS refuses, OVR writes over
  assert.match(G.moveBlock(v, B2, -1, 0).error, /in the way above/);
  assert.equal(conns(G.moveBlock(v, B2, 1, 0).text).join(), 'A–B');
  // a longer arrow is shortened, keeping its shaft
  const v3 = '+---+\n| A |\n+-+-+\n  |\n  |\n  v\n+-+-+\n| B |\n+---+';
  assert.deepEqual(G.moveBlock(v3, { r1: 6, c1: 0, r2: 8, c2: 4 }, -1, 0).text.split('\n').slice(3, 5), ['  |', '  v']);
  // At the top / left edge there is nowhere to go
  assert.match(G.moveBlock(t, A, 0, -1).error, /left edge/);
  assert.match(G.moveBlock(t, A, -1, 0).error, /top/);
});

test('moving everything right and down makes room at the top and left, then a box fits around it', () => {
  const G = Grid2DEditor;
  let t = ROWCOL;
  let b = { r1: 0, c1: 0, r2: 7, c2: 13 };
  for (const [dr, dc] of [[0, 1], [0, 1], [1, 0], [1, 0]]) {
    const res = G.moveBlock(t, b, dr, dc);
    assert.ok(!res.error, res.error);
    t = res.text;
    b = res.block;
  }
  assert.deepEqual(b, { r1: 2, c1: 2, r2: 9, c2: 15 });
  assert.equal(t.split('\n')[3], '  | A +--->+ B |');
  assert.ok(t.endsWith('# [D] = Thing'), 'the legend stays put');
  const boxed = G.drawBoxAround(t, { r1: 0, c1: 0, r2: 11, c2: 17 }, {}); // OVR: on the edge, now empty
  assert.equal(parse(boxed.text).boxes.length, 5);
  assert.deepEqual(conns(boxed.text).filter((c) => !c.includes('container')), ['A–B', 'A–C', 'B–D']);
});

test('moving a block into something: OVR writes over it, INS makes room right / down and refuses left / up', () => {
  const G = Grid2DEditor;
  const t = '+---+x\n| A |x\n+---+x';
  const A = { r1: 0, c1: 0, r2: 2, c2: 4 };
  assert.equal(G.moveBlock(t, A, 0, 1, { overwrite: true }).text, ' +---+\n | A |\n +---+');
  assert.equal(G.moveBlock(t, A, 0, 1).text, ' +---+x\n | A |x\n +---+x', 'INS pushes what is beside it');
  const X = { r1: 0, c1: 5, r2: 2, c2: 5 };
  assert.match(G.moveBlock(t, X, 0, -1).error, /in the way on the left/);
  assert.equal(G.moveBlock(t, X, 0, -1, { overwrite: true }).text, '+---x\n| A x\n+---x');
});

/* ---------------- PR #12 review ---------------- */

test('regression (PR #12 review): moving a block never mistakes text for a line (INS makes room instead)', () => {
  const G = Grid2DEditor;
  const res = G.moveBlock('X\nversion\nvalue', { r1: 0, c1: 0, r2: 0, c2: 0 }, 1, 0);
  assert.ok(!res.error, res.error);
  assert.deepEqual(res.text.split('\n').slice(-2), ['version', 'value'], 'both words verbatim');
  assert.equal(res.text.split('\n')[res.block.r1][res.block.c1], 'X');
  // Hyphens in a label beside a moving block aren't a line either
  const hy = G.moveBlock('X  \na-b', { r1: 0, c1: 0, r2: 0, c2: 0 }, 0, 1);
  assert.equal(hy.text.split('\n')[1], 'a-b');
});

test('regression (PR #12 review): lines behind a moving block stay attached: arrows either way, plain lines and junctions', () => {
  const G = Grid2DEditor;
  const cases = [
    // [text, block, dr, dc, expected line, which line]
    ['+---+ +---+ +---+\n| A |<| B |>| C |\n+---+ +---+ +---+', { r1: 0, c1: 6, r2: 2, c2: 16 }, 0, 1, '| A |<-| B |>| C |', 1],
    ['+---+ +---+\n| A |>| B |\n+---+ +---+', { r1: 0, c1: 6, r2: 2, c2: 10 }, 0, 1, '| A |->| B |', 1],
    ['+---+    +---+\n| A +--+-+ B |\n+---+  | +---+\n       |', { r1: 0, c1: 9, r2: 2, c2: 13 }, 0, 1, '| A +--+--+ B |', 1],
    ['+---+   +---+\n| A +--+| B |\n+---+  |+---+\n       |', { r1: 0, c1: 8, r2: 2, c2: 12 }, 0, 1, '| A +--+-| B |', 1],
    ['+---+\n| A |\n+-+-+\n  ^\n+-+-+\n| B |\n+---+', { r1: 4, c1: 0, r2: 6, c2: 4 }, 1, 0, '  |', 4],
    ['+---+\n| A |\n+-+-+\n  v\n+-+-+\n| B |\n+---+', { r1: 4, c1: 0, r2: 6, c2: 4 }, 1, 0, '  v', 4]
  ];
  for (const [t, b, dr, dc, line, row] of cases) {
    const before = conns(t);
    const res = G.moveBlock(t, b, dr, dc);
    assert.ok(!res.error, res.error);
    assert.equal(res.text.split('\n')[row], line, `${JSON.stringify(t)}:\n${res.text}`);
    assert.deepEqual(conns(res.text), before, `still connected:\n${res.text}`);
    const heads = (x) => [...x].filter((ch) => '<>^v'.includes(ch)).sort().join('');
    assert.equal(heads(res.text), heads(t), 'every arrowhead kept');
  }
});

test('regression (PR #12 review): in OVR, a collision on one line does not stop another line\'s arrowhead stepping back', () => {
  const G = Grid2DEditor;
  const A = { r1: 0, c1: 0, r2: 2, c2: 4 };
  const withX = G.moveBlock('+---+x   +---+\n| A |<---| B |\n+---+    +---+', A, 0, 1, { overwrite: true });
  const without = G.moveBlock('+---+    +---+\n| A |<---| B |\n+---+    +---+', A, 0, 1, { overwrite: true });
  assert.equal(withX.text.split('\n')[1], ' | A |<--| B |');
  assert.equal(withX.text.split('\n')[1], without.text.split('\n')[1]);
  assert.deepEqual(conns(withX.text), ['A–B']);
});

test('regression (PR #12 re-review): when INS makes room, lines behind the block stay attached too', () => {
  const G = Grid2DEditor;
  const group = { r1: 0, c1: 8, r2: 2, c2: 18 };
  const clear = '+---+   +---+ +---+\n| A +--+| B |>| C |\n+---+  |+---+ +---+\n       |';
  const blocked = '+---+   +---+ +---+x\n| A +--+| B |>| C |\n+---+  |+---+ +---+\n       |';
  for (const t of [clear, blocked]) {
    const res = G.moveBlock(t, group, 0, 1);
    assert.ok(!res.error, res.error);
    assert.equal(res.text.split('\n')[1], '| A +--+-| B |>| C |', JSON.stringify(t));
    assert.deepEqual(conns(res.text), ['A–B', 'B–C']);
  }
  assert.equal(G.moveBlock(blocked, group, 0, 1).text.split('\n')[0], '+---+    +---+ +---+x', 'the x was moved over to make room');
  // The same going down, with a junction above and something in the way below
  const v = '+---+\n| A |\n+-+-+\n  +--\n+---+\n| B |\n+---+\nxxxxx';
  const res = G.moveBlock(v, { r1: 4, c1: 0, r2: 6, c2: 4 }, 1, 0);
  assert.deepEqual(res.text.split('\n').slice(3, 6), ['  +--', '  |', '+---+']);
  assert.deepEqual(conns(res.text), ['A–B']);
  assert.equal(res.text.split('\n').pop(), 'xxxxx');
});

/* ---------------- Enter beside a container; deleting lines; dragging blocks ---------------- */

test('Enter in a box beside a container never stretches the container or the boxes inside it', () => {
  let t = [
    '+-------------+  +-------------+',
    '| Left        |  | Right       |',
    '|  +-------+  |  |  +-------+  |',
    '|  |  L1   |  |  |  |  R1   |  |',
    '|  +---+---+  |  |  +-------+  |',
    '|      |      |  |             |',
    '|      v      |  +-------------+',
    '|  +-------+  |',
    '|  |  L2   |  |',
    '|  +-------+  |',
    '+-------------+'
  ].join('\n');
  const left = (x) => x.split('\n').map((l) => l.slice(0, 15).replace(/\s+$/, ''));
  const before = left(t);
  let r = 5, c = 29;
  for (let i = 0; i < 8; i++) {
    const idx = Grid2DEditor.getIndexFromRowCol(t, r, c);
    const res = Grid2DEditor.editAtSelection(t, idx, idx, { type: 'newline' }, { r, c });
    assert.ok(res && !res.error, res && res.error);
    t = res.text; r = res.cursorR; c = res.cursorC;
    assert.deepEqual(left(t).slice(0, before.length), before, `after Enter ${i + 1}:\n${t}`);
  }
  assert.equal(parse(t).boxes.find((b) => b.r1 === 0 && b.c1 === 17).r2, 14, 'Right grew by 8');
});

test('deleting a line traces it to its ends; ports become wall, crossings and other lines are kept', () => {
  const G = Grid2DEditor;
  const simple = '+---+    +---+\n| A +--->+ B |\n+---+    +---+';
  assert.equal(G.deleteLine(simple, 1, 6).text, '+---+    +---+\n| A |    | B |\n+---+    +---+');
  const corners = '+---+\n| A |\n+-+-+\n  |\n  +-----+\n        |\n        v\n     +--+--+\n     | B   |\n     +-----+';
  const c1 = G.deleteLine(corners, 3, 2);
  assert.equal(parse(c1.text).boxes.length, 2);
  assert.ok(!/[|v]/.test(c1.text.split('\n').slice(3, 7).join('')), 'every piece of it is gone');
  assert.equal(c1.text.split('\n')[2], '+---+', 'the port is wall again');
  assert.equal(c1.text.split('\n')[7], '     +-----+');
  const cross = '      |\n+---+ | +---+\n| A +-+-+ B |\n+---+ | +---+\n      |';
  assert.equal(G.deleteLine(cross, 2, 5).text.split('\n')[2], '| A | | | B |', 'the crossing line stays');
  assert.equal(G.deleteLine(cross, 0, 6).text.split('\n')[2], '| A +---+ B |', 'and the other way round');
  const tee = '+---+     +---+\n| A +--+--+ B |\n+---+  |  +---+\n       |\n    +--+--+\n    | C   |\n    +-----+';
  const stem = G.deleteLine(tee, 3, 7);
  assert.equal(stem.text.split('\n')[1], '| A +-----+ B |', 'the T becomes straight line');
  assert.equal(stem.text.split('\n')[4], '    +-----+');
  assert.deepEqual(conns(stem.text), ['A–B']);
  const inside = '+------------+\n|  +---+     |\n|  | A +-----+------>\n|  +---+     |\n+------------+';
  assert.equal(G.deleteLine(inside, 2, 17).text.split('\n')[2], '|  | A |     |', 'through a container wall, which is mended');
  assert.equal(G.deleteLine('+---+\n| A += = = >\n+---+', 1, 7).text, '+---+\n| A |\n+---+', 'a spaced dashed line');
  assert.match(G.deleteLine(simple, 1, 2).error, /on a line/);
});

test('dragging a block: placed on empty space; on something, OVR writes over it and INS makes room', () => {
  const G = Grid2DEditor;
  const t = '+---+        x\n| A |        x\n+---+        x';
  const A = { r1: 0, c1: 0, r2: 2, c2: 4 };
  const placed = G.dragBlock(t, A, 0, 6);
  assert.equal(placed.text, '      +---+  x\n      | A |  x\n      +---+  x');
  assert.deepEqual(placed.block, { r1: 0, c1: 6, r2: 2, c2: 10 });
  assert.equal(G.dragBlock(t, A, 0, 10, { overwrite: true }).text, '          +---+\n          | A |\n          +---+');
  assert.equal(G.dragBlock(t, A, 0, 10).text, '          +---+   x\n          | A |   x\n          +---+   x', 'INS: the x moves over');
  assert.equal(G.dragBlock(t, A, 3, 0).text, '             x\n             x\n             x\n+---+\n| A |\n+---+', 'down into new lines');
  assert.deepEqual(G.dragBlock(t, A, -5, -5).block, A, 'clamped at the top-left');
});

test('the preview can show several boxes selected (a block selection)', () => {
  const p = new DitaaParser(LENIENT);
  const ast = p.parse('+---+ +---+ +---+\n| A | | B | | C |\n+---+ +---+ +---+');
  const marks = (svg) => (svg.match(/stroke="#6366f1" stroke-width="2.5" stroke-dasharray="4,2"/g) || []).length;
  assert.equal(marks(p.renderSVG(ast, 1)), 1);
  assert.equal(marks(p.renderSVG(ast, [0, 2])), 2);
  assert.equal(marks(p.renderSVG(ast, [])), 0);
  assert.equal(marks(p.renderSVG(ast)), 0);
});

/* ---------------- PR #13 review ---------------- */

test('regression (PR #13 review): deleting the stem of a T right beside a wall keeps the other connection', () => {
  const G = Grid2DEditor;
  const t = '+---+   +---+\n| A +--+| B |\n+---+  |+---+\n       |';
  assert.deepEqual(conns(t), ['A–B']);
  const res = G.deleteLine(t, 3, 7);
  assert.equal(res.text, '+---+   +---+\n| A +---| B |\n+---+   +---+');
  assert.deepEqual(conns(res.text), ['A–B']);
  // ...and the same T upside down, against a wall above
  const up = '       |\n+---+  |+---+\n| A +--+| B |\n+---+   +---+';
  assert.deepEqual(conns(G.deleteLine(up, 0, 7).text), ['A–B']);
});

test('regression (PR #13 review): deleting a line goes round its rounded corners, from either leg', () => {
  const G = Grid2DEditor;
  const blank = (t) => t.replace(/\s/g, '');
  for (const [t, starts] of [['--.\n  |\n  v', [[0, 0], [0, 2], [2, 2]]], ["  |\n--'", [[0, 2], [1, 0], [1, 2]]], ["'--\n|\n^", [[0, 2], [2, 0]]]]) {
    for (const [r, c] of starts) assert.equal(blank(G.deleteLine(t, r, c).text), '', `${JSON.stringify(t)} from ${r},${c}`);
  }
});

test('regression (PR #13 review): a spaced dashed arrow is deleted whole from its tip too', () => {
  const G = Grid2DEditor;
  const t = '+---+\n| A += = = >\n+---+';
  for (const c of [5, 7, 9, 11]) assert.equal(G.deleteLine(t, 1, c).text, '+---+\n| A |\n+---+', `from column ${c}`);
  assert.equal(G.deleteLine('< = = =', 0, 0).text, '');
});

test('regression (PR #13 re-review): deleting one of two arrows side by side leaves the other exactly as it was', () => {
  const G = Grid2DEditor;
  for (const c of [0, 1, 2]) assert.equal(G.deleteLine('==> ==>', 0, c).text, '    ==>', `first arrow, from column ${c}`);
  for (const c of [4, 5, 6]) assert.equal(G.deleteLine('==> ==>', 0, c).text, '==>', `second arrow, from column ${c}`);
  assert.equal(G.deleteLine('--> -->', 0, 0).text, '    -->');
  assert.equal(G.deleteLine('<== <==', 0, 4).text, '<==');
  // a real spaced dashed line is still deleted whole, from either end
  for (const c of [0, 6]) assert.equal(G.deleteLine('= = = >', 0, c).text, '');
});

/* ---------------- Plain ditaa by default ---------------- */

const STRICT = new DitaaParser();
const strictRoles = (t) => STRICT.parse(t).cellRole.map((row) => row.map((x) => (x.startsWith('wire') ? 'w' : x === 'empty' ? '.' : x[4])).join('')).join('/');
const presetsAll = () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  return new Function(presetSrc + '\nreturn PRESETS;')();
};

test('plain ditaa by default: a dashed line needs - (or |) as well as = (or :), and an arrowhead needs a shaft', () => {
  assert.equal(new DitaaParser().extensions, false);
  assert.equal(new DitaaParser().healInlineArrows, false, 'inline border arrows are never on by default');
  // horizontal
  assert.equal(strictRoles('====='), '.....', '===== is text');
  assert.equal(strictRoles('--=--'), 'wwwww');
  assert.equal(STRICT.parse('--=--').wires[0].dashed, true);
  assert.equal(strictRoles('x = = = > y'), '...........', 'spaced dashes are an extension');
  // vertical
  assert.equal(strictRoles(' :\n :\n v'), '../../..', 'a column of : is text, and so is the v under it');
  assert.equal(strictRoles(' :\n |\n v'), '.w/.w/.w');
  assert.equal(STRICT.parse(' :\n |\n v').wires[0].dashed, true);
  // arrowheads need a shaft
  const oneCell = '+---+\n| A |\n+-+-+\n  v\n+-+-+\n| B |\n+---+';
  assert.equal(STRICT.parse(oneCell).arrows.length, 0, 'a bare v is not an arrow');
  assert.equal(STRICT.connections(STRICT.parse(oneCell)).length, 0);
  const shafted = '+---+\n| A |\n+-+-+\n  |\n  v\n+-+-+\n| B |\n+---+';
  assert.equal(STRICT.parse(shafted).arrows.length, 1);
  assert.equal(STRICT.connections(STRICT.parse(shafted)).length, 1);
  assert.equal(STRICT.parse('+---+ +---+\n| A |>| B |\n+---+ +---+').arrows.length, 0);
  assert.equal(STRICT.parse('-->').arrows.length, 1);
  // inline border arrows break the box in plain ditaa
  assert.equal(STRICT.parse('+---+\n| A |\n+-^-+\n  |').boxes.length, 0);
  // ...and with the extensions on, all of it reads as before
  const X = new DitaaParser({ extensions: true });
  assert.equal(X.parse('=====').wires.length, 1);
  assert.equal(X.parse(oneCell).arrows.length, 1);
  assert.equal(X.parse('+---+\n| A |\n+-^-+\n  |').boxes.length, 1);
});

test('the examples are plain ditaa (except the inline-arrow one): strict and lenient readings agree', () => {
  const X = new DitaaParser({ extensions: true });
  for (const [k, text] of Object.entries(presetsAll())) {
    if (k === 'legacy_comparison') continue;
    const a = STRICT.parse(text), b = X.parse(text);
    assert.equal(a.boxes.length, b.boxes.length, `${k}: boxes`);
    assert.equal(STRICT.connections(a).length, X.connections(b).length, `${k}: connections`);
    assert.equal(a.arrows.length, b.arrows.length, `${k}: arrowheads`);
    assert.equal(a.wires.filter((w) => w.dashed).length, b.wires.filter((w) => w.dashed).length, `${k}: dashed lines`);
    assert.ok(!/= =/.test(text) && !/\{\*\}/.test(text) && !/[-+][\^v][-+]/.test(text), `${k}: no extension syntax`);
  }
});

test('what the editor draws is plain ditaa: dashed connections and stamps alternate, arrows always have a shaft', () => {
  const G = Grid2DEditor;
  // a dashed connection
  const t = '+---+          +---+\n| A |          | B |\n+---+          +---+';
  const start = G.placePort(t, { box: parse(t).boxes[0], sides: ['right'] }, 1, 4);
  const res = G.connectPorts(start.text, start.port, { r: 1, c: 15 }, { dashed: true, arrow: true });
  const row = res.text.split('\n')[1].slice(5, 15);
  assert.ok(row.includes('-') && row.includes('=') && row.endsWith('>'), row);
  assert.equal(STRICT.connections(STRICT.parse(res.text)).length, 1);
  assert.equal(STRICT.parse(res.text).wires[0].dashed, true);
  // a vertical dashed one
  const v = '+---+\n| A |\n+---+\n\n\n\n+---+\n| B |\n+---+';
  const sv = G.placePort(v, { box: parse(v).boxes[0], sides: ['below'] }, 2, 2);
  const rv = G.connectPorts(sv.text, sv.port, { r: 6, c: 2 }, { dashed: true, arrow: true });
  const col = rv.text.split('\n').slice(3, 6).map((l) => l[2]).join('');
  assert.ok(col.includes(':') && col.includes('|') && col.endsWith('v'), col);
  // the arrowhead always has a shaft: one cell apart there is no room for an arrow
  const close = '+---+ +---+\n| A | | B |\n+---+ +---+';
  const sc = G.placePort(close, { box: parse(close).boxes[0], sides: ['right'] }, 1, 4);
  assert.match(G.connectPorts(sc.text, sc.port, { r: 1, c: 6 }, { arrow: true }).error, /No route/);
  assert.equal(G.connectPorts(sc.text, sc.port, { r: 1, c: 6 }, { arrow: false }).text.split('\n')[1], '| A +-+ B |');
  // a route that turns right before the end still has a straight shaft into it
  const turn = '+---+\n| A |\n+---+\n\n        +---+\n        | B |\n        +---+';
  const st = G.placePort(turn, { box: parse(turn).boxes[0], sides: ['right'] }, 1, 4);
  const rt = G.connectPorts(st.text, st.port, { r: 4, c: 10 }, { arrow: true });
  assert.equal(STRICT.connections(STRICT.parse(rt.text)).length, 1, rt.text);
  // the dashed stamp arrow
  const stamp = G.smartStampArrow('', 0, 0, null, 'dashed-right').text;
  assert.ok(stamp.includes('-') && stamp.includes('=') && stamp.endsWith('>'), stamp);
  assert.equal(STRICT.parse(stamp).arrows.length, 1);
});

test('Export ditaa makes the extensions plain ditaa: dashes, : columns, spaced dashes, bare arrowheads, inline arrows', () => {
  const ex = (t) => DitaaParser.exportStrictLegacyDitaa(t).sanitizedText;
  assert.equal(ex('A =====> B'), 'A -=-=-> B');
  assert.equal(ex('x = = = > y'), 'x =-=-=-> y');
  assert.equal(ex('  :\n  :\n  v'), '  |\n  :\n  v');
  assert.equal(ex('+=====+\n| A   |\n+=====+'), '+-=-=-+\n| A   |\n+-=-=-+');
  assert.equal(ex('+---+ +---+\n| A |>| B |\n+---+ +---+'), '+---+  +---+\n| A |->| B |\n+---+  +---+');
  const one = ex('+---+\n| A |\n+-+-+\n  v\n+-+-+\n| B |\n+---+');
  assert.equal(STRICT.connections(STRICT.parse(one)).length, 1, one);
  const inline = ex('+---+\n| A |\n+-^-+\n  |\n+-+-+\n| B |\n+---+');
  assert.equal(STRICT.parse(inline).boxes.length, 2, inline);
  assert.equal(STRICT.connections(STRICT.parse(inline)).length, 1, inline);
  // the inline-arrow example exports to plain ditaa with every box and connection
  const legacy = presetsAll().legacy_comparison;
  const out = ex(legacy);
  const X = new DitaaParser({ extensions: true });
  assert.equal(STRICT.parse(out).boxes.length, X.parse(legacy).boxes.length, out);
  assert.equal(STRICT.connections(STRICT.parse(out)).length, X.connections(X.parse(legacy)).length, out);
  // text is never changed
  assert.equal(ex('a == b, c :: d, v1.2 and x -> y'), 'a == b, c :: d, v1.2 and x -> y');
});
