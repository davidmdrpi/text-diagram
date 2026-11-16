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
    const p = new DitaaParser();
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

test('typing in a container pushes nested boxes along; typing in a child grows the container', () => {
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

  const res2 = type(text, 3, 6, { type: 'insert', text: 'lpha-long' });
  const ast2 = parse(res2.text);
  assert.deepEqual(ast2.boxes.map((b) => b.lines[0] || null).sort(), ['Alpha-long', 'B', null].sort());
  assert.equal(ast2.boxes.find((b) => b.isContainer).c2 - ast2.boxes.find((b) => b.lines[0] === 'B').c2, 6, 'container grew with it');
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

test('growing a box shifts only its own lines; a wire hanging off a moved box gets a jog', () => {
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
  const hello = (t) => parse(t).boxes.find((b) => b.lines[0] === 'Hello');
  let t = text;
  const steps = [];
  for (const dw of [2, 2, -2, -2]) {
    const res = Grid2DEditor.resizeBox(t, hello(t), dw, 0);
    assert.ok(!res.error, res.error);
    t = res.text;
    steps.push(t.split('\n')[3]);
    const ast = parse(t);
    assert.equal(ast.boxes.length, 3);
    assert.deepEqual(t.split('\n').slice(4), text.split('\n').slice(4), 'C and the arrow did not move');
  }
  assert.deepEqual(steps, ['                  +-+', '                  +---+', '                  +-+', '                  |']);
  assert.equal(t, text, 'round trip restores the straight wire');
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
  const p = new DitaaParser();
  const ast = p.parse(text);
  const name = (b) => { const n = b.lines[0] || b.macroKey || '?'; return rename[n] || n; };
  return p.connections(ast).map((ids) => ids.map((i) => name(ast.boxes[i])).sort().join(' – ')).sort();
};

test('regression (PR #4 review): a blocked wire jog refuses the edit instead of re-attaching the wire', () => {
  const text = [
    '+--------+     +-----+',
    '| Hello  +---->| B   |',
    '+--------+     +--+--+',
    '                  |X',
    '                  v',
    '               +-----+',
    '               | C   |',
    '               +-----+'
  ].join('\n');
  assert.deepEqual(connectionsByLabel(text), ['B – C', 'B – Hello']);
  const res = Grid2DEditor.typeInBox(text, { r: 1, c: 7 }, null, { type: 'insert', text: ' much longer' });
  assert.ok(res.error, 'refused');
  assert.match(res.error, /no room to follow/);
  // Same via the Size Box button
  const hello = parse(text).boxes.find((b) => b.lines[0] === 'Hello');
  assert.match(Grid2DEditor.resizeBox(text, hello, 2, 0).error, /no room to follow/);
  // Without the X the jog is drawn and every wire still connects the same boxes
  const clear = text.replace('|X', '| ');
  const ok = Grid2DEditor.typeInBox(clear, { r: 1, c: 7 }, null, { type: 'insert', text: ' much' });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.text.split('\n')[3], '                  +---+', 'B moved 4 columns; the jog follows');
  assert.deepEqual(connectionsByLabel(ok.text, { 'Hello much': 'Hello' }), ['B – C', 'B – Hello']);
  // Growing so far that Hello's own wall would sit on the jog's corner is refused too:
  // the wire would look like it leaves Hello
  const far = Grid2DEditor.typeInBox(clear, { r: 1, c: 7 }, null, { type: 'insert', text: ' much longer' });
  assert.match(far.error, /no room to follow/);
});

test('the safety check refuses any edit that changes what a wire connects', () => {
  const text = '+---+   +---+\n| A +-->| B |\n+---+   +---+\n\n+---+\n| C |\n+---+';
  // B moved away from the arrow (the arrow is left dangling): same boxes, different wiring
  const moved = '+---+    +---+\n| A +--> | B |\n+---+    +---+\n\n+---+\n| C |\n+---+';
  const res = Grid2DEditor.guardOtherBoxes(text, { text: moved, cursorR: 0, cursorC: 0 }, 'test');
  assert.match(res.error, /change what a wire connects/);
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

test('typing in the flowchart diamond keeps every wire connecting the same boxes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const presetSrc = src.slice(src.indexOf('const PRESETS = {'), src.indexOf('};', src.indexOf('const PRESETS = {')) + 2);
  const { flowchart } = new Function(presetSrc + '\nreturn PRESETS;')();
  const L = flowchart.split('\n');
  const r = L.findIndex((l) => l.includes('Valid?'));
  let t = flowchart;
  let cur = { r, c: L[r].indexOf('?') };
  for (const ch of ' and complete') {
    const res = type(t, cur.r, cur.c, { type: 'insert', text: ch });
    assert.ok(res && !res.error, res && res.error);
    t = res.text;
    cur = { r: res.cursorR, c: res.cursorC };
  }
  assert.deepEqual(connectionsByLabel(t, { 'Valid and complete?': 'Valid?' }), connectionsByLabel(flowchart));
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
  const g = Grid2DEditor.guardOtherBoxes(three, { text: moved, cursorR: 1, cursorC: 2 }, 'test', parse(three).boxes[0]);
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
    const p = new DitaaParser();
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
  const p = new DitaaParser();
  const ast = p.parse(res.text);
  const conn = p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].lines[0] || ast.boxes[i].macroKey).sort().join(' – '));
  assert.ok(conn.includes('API Gateway – Component'));
  assert.ok(conn.includes('Auth Verifier – Component'));
  assert.ok(conn.includes('Auth Verifier – Session Cache'), 'the dashed wire under Auth Verifier follows it');
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
  const p = new DitaaParser();
  const conn = p.connections(ast).map((ids) => ids.map((i) => ast.boxes[i].lines[0]).sort().join(' – ')).sort();
  assert.deepEqual(conn, ['App Service – Database', 'App Service – Ingress', 'Component – Ingress', 'Component – Ingress']);
});
