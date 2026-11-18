'use strict';
// Browser checks for the single-file build (text-diagram.html). They need Playwright with
// a Chromium; without it they are skipped, so `npm test` still runs everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* not installed */ }
const skip = chromium ? false : 'Playwright not installed';
const FILE = 'file://' + path.join(__dirname, '..', 'text-diagram.html');

async function openPage() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/^https?:/, (r) => r.abort()); // offline, like a downloaded file
  let clip = '';
  await ctx.exposeFunction('__clip', () => clip);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => window.__clip(), writeText: async () => {} } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(FILE);
  return { browser, page, errors, setClipboard: (t) => { clip = t; } };
}

// Pixel position of a text cell, from canvas text metrics (independent of the app's own math)
const cellXY = (page, r, c) => page.evaluate(([r, c]) => {
  const ed = document.getElementById('ascii-editor');
  const cs = getComputedStyle(ed);
  const g = document.createElement('canvas').getContext('2d');
  g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const cw = g.measureText('M'.repeat(100)).width / 100;
  const rect = ed.getBoundingClientRect();
  return {
    x: rect.left + ed.clientLeft + parseFloat(cs.paddingLeft) + (c + 0.5) * cw - ed.scrollLeft,
    y: rect.top + ed.clientTop + parseFloat(cs.paddingTop) + (r + 0.5) * parseFloat(cs.lineHeight) - ed.scrollTop,
    right: rect.right, bottom: rect.bottom
  };
}, [r, c]);

const boxes = (page) => page.evaluate(() => new window.DitaaEngine.DitaaParser()
  .parse(document.getElementById('ascii-editor').value).boxes
  .map((b) => ({ r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2, name: b.macroKey ? `[${b.macroKey}]` : b.lines[0] || 'box' })));

const menuHeader = async (page) => (await page.locator('#ctx-menu').innerText()).split('\n')[0];

test('right-click maps to the right box everywhere in the editor', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    let checked = 0;
    for (const preset of ['arch', 'showcase', 'flowchart']) {
      await page.selectOption('#preset-select', preset);
      for (const bx of await boxes(page)) {
        const pt = await cellXY(page, Math.floor((bx.r1 + bx.r2) / 2), bx.c2 + 1);
        if (pt.x > pt.right - 20 || pt.y > pt.bottom - 10) continue;
        await page.mouse.click(pt.x, pt.y, { button: 'right' });
        assert.equal(await menuHeader(page), `RIGHT OF “${bx.name.toUpperCase()}”`, `${preset}: ${bx.name}`);
        await page.keyboard.press('Escape');
        checked++;
      }
    }
    assert.ok(checked >= 15, `checked ${checked} boxes`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('inserting a box right of the top-right box works and scrolls it into view', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    const av = (await boxes(page)).find((b) => b.name === 'Auth Verifier');
    const pt = await cellXY(page, av.r1 + 1, av.c2);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    assert.equal(await menuHeader(page), 'RIGHT OF “AUTH VERIFIER”');
    await page.locator('#ctx-menu button', { hasText: '→ Box' }).first().click();
    assert.ok((await boxes(page)).some((b) => b.name === 'Component'), 'box added');
    const visible = await page.evaluate(() => {
      const v = document.getElementById('canvas-viewport').getBoundingClientRect();
      const g = [...document.querySelectorAll('#svg-wrapper .ditaa-box')].find((x) => x.textContent.includes('Component'));
      const r = g.getBoundingClientRect();
      return r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
    });
    assert.ok(visible, 'new box scrolled into view in the preview');
    // Typing replaces the selected placeholder label
    await page.keyboard.type('Token Store');
    assert.ok((await boxes(page)).some((b) => b.name === 'Token Store'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('menu Paste over a selected label replaces it; an over-long paste still goes in, as plain text', { skip }, async () => {
  const { browser, page, errors, setClipboard } = await openPage();
  try {
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.value = '+---------------+\n|  Component    |\n+---------------+';
      ed.dispatchEvent(new Event('input'));
      const s = ed.value.indexOf('Component');
      ed.focus();
      ed.selectionStart = s;
      ed.selectionEnd = s + 'Component'.length;
    });
    setClipboard('API');
    const pt = await cellXY(page, 1, 5);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Paste' }).first().click();
    await page.waitForFunction(() => document.getElementById('ascii-editor').value.includes('API'));
    assert.deepEqual((await boxes(page)).map((b) => b.name), ['API']);

    const before = await page.inputValue('#ascii-editor');
    setClipboard('x'.repeat(2500));
    const pt2 = await cellXY(page, 1, 5);
    await page.mouse.click(pt2.x, pt2.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Paste' }).first().click();
    // The user is always right about what they type/paste: it goes in, with a quiet note
    await page.waitForFunction(() => /Pasted as plain text/.test(document.getElementById('toast-indicator').textContent));
    assert.ok((await page.inputValue('#ascii-editor')).includes('x'.repeat(2500)));
    assert.notEqual(await page.inputValue('#ascii-editor'), before);
    assert.ok(await page.locator('#error-banner').isHidden(), 'no red error for typing');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('inserting below the bottom-left box moves the boxes beside it down; refusals are visible', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    const before = await boxes(page);
    const D = before.find((b) => b.name === '[D]');
    const pt = await cellXY(page, D.r2, Math.floor((D.c1 + D.c2) / 2));
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: '↓ Box' }).first().click();
    const after = await boxes(page);
    for (const name of ['[A]', '[Q]', '[S]']) {
      const a = before.find((b) => b.name === name), b = after.find((x) => x.name === name);
      assert.equal(b.r2 - b.r1, a.r2 - a.r1, `${name} keeps its height`);
      assert.ok(b.r1 > a.r1, `${name} moved down`);
    }
    // Then left of the top-left box (with the new placeholder still selected)
    const api = after.find((b) => b.name === 'API Gateway');
    const p2 = await cellXY(page, api.r1 + 1, api.c1);
    await page.mouse.click(p2.x, p2.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: '← Box' }).first().click();
    assert.equal((await boxes(page)).length, after.length + 1, 'box added left of API Gateway');
    // A refused insert says why, visibly
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.value = '+-----+     +-----+\n| A   +---->| B   |\n+-----+     +-----+';
      ed.dispatchEvent(new Event('input'));
    });
    const p3 = await cellXY(page, 1, 12);
    await page.mouse.click(p3.x, p3.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: '← Box' }).first().click();
    assert.ok(await page.locator('#error-banner').isVisible());
    assert.match(await page.locator('#error-banner').innerText(), /No room on the left/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('typing a border character back into a box is never blocked', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    // Insert a box left of [D], delete its right wall on the middle line, then type it back
    const D = (await boxes(page)).find((b) => b.name === '[D]');
    const pt = await cellXY(page, D.r1 + 1, D.c1);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: '← Box' }).first().click();
    const nb = (await boxes(page)).find((b) => b.name === 'Component');
    const row = nb.r1 + 1;
    const wall = await cellXY(page, row, nb.c2);
    await page.mouse.click(wall.x + 4, wall.y); // caret just after the '|'
    await page.evaluate(([r, c]) => {
      const ed = document.getElementById('ascii-editor');
      const lines = ed.value.split('\n');
      let i = 0;
      for (let k = 0; k < r; k++) i += lines[k].length + 1;
      ed.selectionStart = ed.selectionEnd = i + c + 1;
    }, [row, nb.c2]);
    await page.keyboard.press('Backspace');
    const line = () => page.inputValue('#ascii-editor').then((v) => v.split('\n')[row]);
    assert.equal((await line())[nb.c2], '<', 'wall deleted');
    await page.keyboard.type('|');
    assert.equal((await line())[nb.c2], '|', 'typed exactly where the caret was');
    assert.equal((await line()).slice(nb.c2, nb.c2 + 3), '|<-');
    assert.ok(await page.locator('#error-banner').isHidden(), 'no error for typing');
    // Status line: one line, shows position and selection
    assert.match(await page.textContent('#cursor-pos'), /^Ln \d+, Col \d+$/);
    await page.keyboard.press('Shift+ArrowLeft');
    assert.match(await page.textContent('#cursor-pos'), /· 1 selected/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('nested example: right-click just left of Ingress inserts inside the container', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.selectOption('#preset-select', 'nested');
    const ing = (await boxes(page)).find((b) => b.name === 'Ingress');
    const pt = await cellXY(page, ing.r1 + 1, ing.c1 - 2); // container space, two cells left of Ingress
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    assert.equal(await menuHeader(page), 'LEFT OF “INGRESS”');
    await page.locator('#ctx-menu button', { hasText: '← Box' }).first().click();
    const ast = await page.evaluate(() => new window.DitaaEngine.DitaaParser()
      .parse(document.getElementById('ascii-editor').value).boxes
      .map((b) => ({ r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2, label: b.lines[0] || '', container: b.isContainer })));
    const cluster = ast.find((b) => b.container);
    const added = ast.find((b) => b.label === 'Component');
    assert.ok(added, 'box added');
    assert.ok(added.c1 > cluster.c1 && added.c2 < cluster.c2 && added.r1 > cluster.r1 && added.r2 < cluster.r2, 'inside Cluster');
    // Right-clicking the container's own wall names it by its label
    const wall = await cellXY(page, cluster.r1, cluster.c1 + 5);
    await page.mouse.click(wall.x, wall.y, { button: 'right' });
    assert.equal(await menuHeader(page), 'ABOVE “CLUSTER”');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('connection: right-click start, then click or right-click a wall to connect; toggles; Esc', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.value = ['+-------+          +-------+', '| A     |          | B     |', '+-------+          +-------+', '', '', '+-------+', '| C     |', '+-------+'].join('\n');
      ed.dispatchEvent(new Event('input'));
    });
    const text = () => page.inputValue('#ascii-editor');
    const at = async (r, c) => cellXY(page, r, c);
    const rc = async (r, c) => { const p = await at(r, c); await page.mouse.click(p.x, p.y, { button: 'right' }); };
    const menuItems = async () => (await page.locator('#ctx-menu button').allInnerTexts()).map((t) => t.split('\n')[0].trim());
    // 1. start on A's right wall
    await rc(1, 8);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    assert.match(await page.textContent('#conn-status'), /Connecting from Ln 2, Col 9/);
    // 2. while pending, the right-click menu is only: connect here / cancel
    await rc(1, 19);
    assert.deepEqual(await menuItems(), ['→ Connect to here (solid, arrow)', '✕ Cancel connection']);
    await page.keyboard.press('Escape'); // closes the menu only
    assert.match(await page.textContent('#conn-status'), /Connecting from/);
    // ...and a plain left click on B's wall connects
    const p = await at(1, 19);
    await page.mouse.click(p.x, p.y);
    assert.equal((await text()).split('\n')[1], '| A     +--------->+ B     |');
    assert.equal(await page.textContent('#conn-status'), '');
    // 3. toggles: dashed, no arrow; A -> C via the right-click menu
    await page.click('#toggle-conn-dashed');
    await page.click('#toggle-conn-arrow');
    assert.equal(await page.getAttribute('#toggle-conn-dashed', 'aria-pressed'), 'true');
    await rc(2, 3);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    await rc(5, 3);
    await page.locator('#ctx-menu button', { hasText: 'Connect to here (dashed)' }).click();
    const lines = (await text()).split('\n');
    assert.equal(lines[3][3], ':');
    assert.equal(lines[4][3], ':', 'dashed vertical, no arrowhead');
    // 4. off any wall, the pending menu offers only Cancel; a left click there just moves the caret
    await rc(6, 8);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    const before = await text();
    const near = await at(4, 22); // two lines below B's wall: near, but not on it
    await page.mouse.click(near.x, near.y);
    assert.equal(await text(), before, 'a click that is not on a wall draws nothing');
    assert.match(await page.textContent('#conn-status'), /Connecting from/, 'still pending');
    await rc(4, 14); // empty space between the boxes
    assert.deepEqual(await menuItems(), ['✕ Cancel connection']);
    await page.keyboard.press('Escape');
    await rc(4, 14);
    assert.deepEqual(await menuItems(), ['✕ Cancel connection']);
    await page.locator('#ctx-menu button', { hasText: 'Cancel connection' }).click();
    assert.equal(await page.textContent('#conn-status'), '');
    // 5. Esc cancels a pending start
    await rc(6, 8);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.textContent('#conn-status'), '');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
