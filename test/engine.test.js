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
  const expected = { arch: 7, showcase: 7, microservices: 6, legacy_comparison: 4, nested: 4 };
  for (const [k, text] of Object.entries(PRESETS)) {
    const ast = parse(text);
    assert.equal(ast.boxes.length, expected[k], k);
    assert.ok(render(text).startsWith('<svg'), k);
    for (const mode of ['both', 'inline', 'card', 'off']) render(text, { legendMode: mode });
    DitaaParser.exportStrictLegacyDitaa(text);
  }
});
