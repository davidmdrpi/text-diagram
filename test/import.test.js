'use strict';
// Import: SVG and pictures of boxes and arrows become ditaa text
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DitaaParser } = require('../src/engine.js');
const I = require('../src/import.js');
const canvas = require('./fixtures/raster.js');

const P = new DitaaParser();
const summary = (t) => {
  const ast = P.parse(t);
  return {
    boxes: ast.boxes.length,
    labels: ast.boxes.map((b) => b.lines.filter((l) => l.trim())[0] || '').filter(Boolean).sort(),
    connections: P.connections(ast).length
  };
};
const presets = {};
for (const m of fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8').matchAll(/^ {4}(\w+): `([\s\S]*?)`/gm)) {
  presets[m[1]] = m[2].replace(/\\\\/g, '\\');
}

test('every example survives a round trip through its own SVG export: boxes, labels and connections', () => {
  assert.ok(Object.keys(presets).length >= 6);
  for (const [name, text] of Object.entries(presets)) {
    const svg = P.renderSVG(P.parse(text));
    const back = I.importDiagram(svg);
    assert.ok(!back.error, back.error);
    assert.deepEqual(summary(back.text), summary(text), `${name}:\n${back.text}`);
  }
});

test('legend macros come back as [key] boxes with their legend lines', () => {
  const back = I.importDiagram(P.renderSVG(P.parse(presets.arch))).text;
  assert.match(back, /\| *\[D\] *\|/);
  assert.match(back, /^# \[D\] = Diagram Engine$/m);
  assert.ok(!/LEGEND/.test(back), 'the legend card is not a box');
});

test('a generic SVG: rounded and diamond shapes, colors, text lines, a dashed bent connector, markers, HTML text', () => {
  const svg = fs.readFileSync(path.join(__dirname, 'fixtures', 'generic.svg'), 'utf8');
  const res = I.importDiagram(svg);
  const ast = P.parse(res.text);
  const byLabel = Object.fromEntries(ast.boxes.map((b) => [b.lines.filter((l) => l.trim()).join(' / '), b]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['OK?', 'Retry / later', 'Start'], res.text);
  assert.equal(byLabel['OK?'].shape, 'choice');
  assert.equal(byLabel.Start.customHex.toLowerCase(), '#fff2cc');
  assert.match(res.text, /^\/-+\\/m, 'the rounded box keeps rounded corners');
  assert.match(res.text, /\|<=+\+/, 'the dashed connector with its arrowhead into Retry');
  assert.match(res.text, /-+>\|/, 'the arrow into the diamond');
  assert.match(res.text, /Note: free text/, 'text outside boxes, inline HTML on one line');
  assert.equal(P.connections(ast).length, 2);
});

test('transforms, paths and a hidden or background shape', () => {
  assert.deepEqual(I.parseTransform('translate(10,5) scale(2)'), [2, 0, 0, 2, 10, 5]);
  const subs = I.parsePath('M10 10 h20 v20 H10 z m40 0 l5 5');
  assert.deepEqual(subs[0].pts, [[10, 10], [30, 10], [30, 30], [10, 30]]);
  assert.equal(subs[0].closed, true);
  assert.deepEqual(subs[1].pts, [[50, 10], [55, 15]]);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>' +
    '<g transform="translate(100,50)"><rect x="0" y="0" width="120" height="50" fill="none" stroke="#000"/><text x="60" y="30" text-anchor="middle" font-size="12">Hi</text></g>' +
    '<rect x="0" y="0" width="60" height="30" style="display:none" stroke="#000"/></svg>';
  const scene = I.fromSVG(svg);
  assert.equal(scene.boxes.length, 1);
  assert.deepEqual([scene.boxes[0].x1, scene.boxes[0].y1], [100, 50]);
  assert.match(I.toAscii(scene).text, /\| +Hi +\|/);
});

test('a picture: boxes (with their fill colors), lines and arrowheads from pixels; writing gets placeholder labels', () => {
  const c = canvas(420, 260);
  c.box(20, 20, 100, 50, [219, 234, 254]); c.text(40, 40, 5);
  c.box(220, 20, 120, 50, null); c.text(240, 40, 6);
  c.hline(121, 218, 45); c.tri(218, 45, 'right');
  c.vline(280, 71, 160); c.tri(280, 160, 'down');
  c.box(220, 162, 120, 50, [220, 252, 231]);
  const res = I.importDiagram({ width: c.W, height: c.H, data: c.data });
  assert.ok(!res.error, res.error);
  const ast = P.parse(res.text);
  assert.equal(ast.boxes.length, 3, res.text);
  assert.equal(res.arrows, 2);
  assert.equal(P.connections(ast).length, 2);
  assert.deepEqual(ast.boxes.map((b) => b.lines[0]).filter((l) => /^Box/.test(l)).sort(), ['Box 1', 'Box 2']);
  assert.ok(ast.boxes.some((b) => b.colorKey === 'cBLU'), 'the blue fill is cBLU');
  assert.match(res.text, /-+>\|/);
  assert.match(res.text, /v\n *\+-+\+/);
  // nothing recognisable
  const blank = canvas(50, 50);
  assert.match(I.importDiagram({ width: 50, height: 50, data: blank.data }).error, /No boxes or lines/);
});

test('a picture with boxes inside a box and a dashed line', () => {
  const c = canvas(400, 240);
  c.box(10, 10, 380, 220, null);
  c.box(40, 60, 100, 50, null);
  c.box(240, 60, 100, 50, null);
  for (let x = 141; x < 236; x += 8) c.hline(x, x + 4, 85);
  c.tri(239, 85, 'right');
  const res = I.importDiagram({ width: c.W, height: c.H, data: c.data });
  const ast = P.parse(res.text);
  assert.equal(ast.boxes.length, 3, res.text);
  assert.equal(ast.boxes.filter((b) => b.isContainer).length, 1);
  assert.match(res.text, /=+>/, `a dashed arrow:\n${res.text}`);
});

/* ---------------- PR #14 review ---------------- */

test('regression (PR #14 review): a box filled with a dark color is a box, and the plain line beside it has no arrowhead', () => {
  const c = canvas(400, 140);
  c.fillRect(20, 30, 100, 50, [20, 30, 40]);
  c.box(230, 30, 100, 50, null);
  c.hline(120, 229, 55);
  const res = I.importDiagram({ width: c.W, height: c.H, data: c.data });
  assert.equal(res.boxes, 2, res.text);
  assert.equal(res.arrows, 0, res.text);
  assert.ok(!/[<>^v]/.test(res.text), res.text);
  const ast = P.parse(res.text);
  assert.equal(ast.boxes.length, 2);
  assert.equal(P.connections(ast).length, 1, 'still joined by the line');
  assert.ok(ast.boxes.some((b) => (b.customHex || '').toLowerCase() === '#141e28'), 'with its own color');
  // a small solid badge is still not a box
  const d = canvas(300, 120);
  d.box(20, 20, 120, 60, null);
  d.fillRect(26, 26, 20, 14, [40, 40, 120]);
  assert.equal(I.importDiagram({ width: d.W, height: d.H, data: d.data }).boxes, 1);
});

test('regression (PR #14 review): every shape tag survives a round trip through our SVG', () => {
  for (const tag of ['{d}', '{io}', '{mo}', '{o}', '{s}', '{c}']) {
    const t = `+-----------+\n| Thing ${tag.padEnd(4)}|\n+-----------+`;
    const before = P.parse(t).boxes[0];
    const after = P.parse(I.importDiagram(P.renderSVG(P.parse(t))).text).boxes[0];
    assert.equal(after.shape, before.shape, tag);
    assert.equal(after.lines[0], 'Thing', tag);
  }
});

test('regression (PR #14 review): legend definitions come back with the legend shown as a card only (or both ways, once)', () => {
  const t = '+-----+\n| [A] |\n+-----+\n\n# [A] = Alpha';
  for (const legendMode of ['card', 'both', 'inline']) {
    const p = new DitaaParser({ legendMode });
    const back = I.importDiagram(p.renderSVG(p.parse(t))).text;
    assert.match(back, /\| *\[A\] *\|/, legendMode);
    assert.equal((back.match(/^# \[A\] = Alpha$/gm) || []).length, 1, `${legendMode}:\n${back}`);
  }
});

test('regression (PR #14 review): only one branch of an SVG switch is read (an HTML label with a text fallback)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="120" height="60" fill="#fff" stroke="#000"/>' +
    '<switch><foreignObject x="10" y="10" width="120" height="60" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility">' +
    '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:12px">Start</div></foreignObject>' +
    '<text x="70" y="44" text-anchor="middle" font-size="12">Start</text></switch></svg>';
  const ast = P.parse(I.importDiagram(svg).text);
  assert.deepEqual(ast.boxes.map((b) => b.lines.join(' / ')), ['Start']);
  // a switch whose first branch is the text works the same
  const textFirst = svg.replace(/<switch>(<foreignObject[\s\S]*?<\/foreignObject>)(<text[\s\S]*?<\/text>)<\/switch>/, '<switch>$2$1</switch>');
  assert.deepEqual(P.parse(I.importDiagram(textFirst).text).boxes.map((b) => b.lines.join(' / ')), ['Start']);
});
