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
  // Offline, like a downloaded file; every request the page tries anyway is recorded
  const requests = [];
  ctx.on('request', (r) => { if (/^(https?|wss?):/i.test(r.url())) requests.push(r.url()); });
  await ctx.route(/^https?:/, (r) => r.abort());
  let clip = '';
  await ctx.exposeFunction('__clip', () => clip);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => window.__clip(), writeText: async () => {} } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(FILE);
  return { browser, page, errors, requests, setClipboard: (t) => { clip = t; } };
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
    assert.match(await page.textContent('#cursor-pos'), /· 1×1 block/, 'block selection is on by default');
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
    // 4. off any wall: a connection can end in empty space (and start on a line)
    await rc(6, 8);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    await rc(4, 14); // empty space between the boxes
    assert.deepEqual(await menuItems(), ['→ Connect to here (dashed)', '✕ Cancel connection']);
    await page.keyboard.press('Escape');
    const free = await at(4, 22);
    await page.mouse.click(free.x, free.y);
    assert.equal(await page.textContent('#conn-status'), '');
    let ls = (await text()).split('\n');
    assert.equal(ls[6].slice(8, 12), '+===', 'starts on C\'s wall');
    assert.match(ls[4][22], /[=:+]/, 'ends right on the empty cell clicked');
    // ...a start in empty space, then a click on plain text: cancelled, with a message
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      const ls = ed.value.split('\n');
      ls[3] = ls[3].padEnd(13) + 'note';
      ed.value = ls.join('\n');
      ed.dispatchEvent(new Event('input'));
    });
    await rc(4, 14);
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    assert.match(await page.textContent('#conn-status'), /Connecting from Ln 5, Col 15/);
    const before = await text();
    const onText = await at(3, 14);
    await page.mouse.click(onText.x, onText.y);
    assert.equal(await text(), before, 'nothing drawn');
    assert.equal(await page.textContent('#conn-status'), '');
    assert.match(await page.textContent('#error-banner'), /not on text.*connection cancelled/);
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

test('regression (PR #9 review): a pending connection is cancelled when the diagram changes', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    // Start on API Gateway's bottom wall in the pipeline example, then switch examples
    const api = (await boxes(page)).find((b) => b.name === 'API Gateway');
    const p1 = await cellXY(page, api.r2, api.c1 + 3);
    await page.mouse.click(p1.x, p1.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    assert.match(await page.textContent('#conn-status'), /Connecting from/);
    await page.selectOption('#preset-select', 'showcase');
    assert.equal(await page.textContent('#conn-status'), '', 'cancelled by loading another example');
    // A click on a wall now does not connect anything
    const before = await page.inputValue('#ascii-editor');
    const sc = (await boxes(page)).find((b) => b.name === 'Storage Cylinder');
    const p2 = await cellXY(page, sc.r1, sc.c1 + 3);
    await page.mouse.click(p2.x, p2.y);
    assert.equal(await page.inputValue('#ascii-editor'), before);
    // Typing also cancels a pending start
    const p3 = await cellXY(page, sc.r1, sc.c1 + 3);
    await page.mouse.click(p3.x, p3.y, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Start connection here' }).click();
    assert.match(await page.textContent('#conn-status'), /Connecting from/);
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    assert.equal(await page.textContent('#conn-status'), '', 'cancelled by an edit');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('insert / overwrite: the toggle and the Insert key; typing, Backspace and paste overwrite', { skip }, async () => {
  const { browser, page, errors, setClipboard } = await openPage();
  try {
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.value = ['+-----+   +-----+', '| A   +-->+ B   |', '+-----+   +-----+'].join('\n');
      ed.dispatchEvent(new Event('input'));
    });
    const text = () => page.inputValue('#ascii-editor');
    const click = async (r, c) => { const p = await cellXY(page, r, c); await page.mouse.click(p.x, p.y); };
    assert.equal(await page.textContent('#toggle-overwrite'), 'INS');
    await click(1, 7);
    await page.keyboard.press('Insert');
    assert.equal(await page.textContent('#toggle-overwrite'), 'OVR');
    assert.equal(await page.locator('#editor-overlay .ovr-caret').count(), 1, 'a block caret shows the cell typed over');
    // Typing replaces the arrow's characters; the rest of the line stays where it was
    await page.keyboard.type('==');
    assert.equal((await text()).split('\n')[1], '| A   +==>+ B   |');
    await page.keyboard.press('Backspace');
    assert.equal((await text()).split('\n')[1], '| A   += >+ B   |', 'Backspace blanks');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');
    assert.equal((await text()).split('\n')[1], '| A   +=  + B   |', 'Delete blanks the character under the caret');
    // Typing inside a box overwrites too (no auto-fit)
    await click(1, 2);
    await page.keyboard.type('XYZ');
    assert.equal((await text()).split('\n')[1], '| XYZ +=  + B   |');
    // A click past the end of a line puts the caret there; typing goes right there
    await click(2, 20);
    await page.keyboard.type('n');
    assert.equal((await text()).split('\n')[2], '+-----+   +-----+   n');
    // Paste writes over the text at the caret
    setClipboard('##\n##');
    await click(0, 1);
    await page.mouse.click(...Object.values(await cellXY(page, 0, 1)).slice(0, 2), { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Paste' }).click();
    assert.deepEqual((await text()).split('\n').slice(0, 2), ['+##---+   +-----+', '|##YZ +=  + B   |']);
    // The button switches back to insert
    await page.click('#toggle-overwrite');
    assert.equal(await page.textContent('#toggle-overwrite'), 'INS');
    assert.equal(await page.locator('#editor-overlay .ovr-caret').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('block selection (on by default): rectangles, whole rows and whole columns; copy, cut, paste', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    const start = [
      '+---+    +---+',
      '| A +--->+ B |',
      '+-+-+    +-+-+',
      '  |        |',
      '  v        v',
      '+---+    +---+',
      '| C |    | D |',
      '+---+    +---+'
    ];
    await page.evaluate((lines) => {
      const ed = document.getElementById('ascii-editor');
      ed.value = lines.join('\n');
      ed.dispatchEvent(new Event('input'));
      // A stand-in for the system clipboard: remember what copy put there, give it to paste
      let clip = '';
      document.addEventListener('copy', (e) => { clip = e.clipboardData.getData('text/plain'); });
      window.__pasteClip = () => {
        const dt = new DataTransfer();
        dt.setData('text/plain', clip);
        ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      };
    }, start);
    const text = () => page.inputValue('#ascii-editor').then((v) => v.split('\n'));
    const at = (r, c) => cellXY(page, r, c);
    const click = async (r, c, opts) => { const p = await at(r, c); await page.mouse.click(p.x, p.y, opts); };
    // (whole pixels: headless Chromium's own drag-selection misbehaves at fractional ones with this font)
    const drag = async (a, b, alt) => {
      const p = await at(...a), q = await at(...b);
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(Math.round(p.x), Math.round(p.y));
      await page.mouse.down();
      await page.mouse.move(Math.round(q.x), Math.round(q.y), { steps: 4 });
      await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
    };
    const status = () => page.textContent('#cursor-pos');
    assert.equal(await page.getAttribute('#toggle-block', 'aria-pressed'), 'true', 'on by default');

    // 1. A plain drag selects a rectangle (box A); Alt+drag selects lines as usual
    await drag([0, 0], [2, 4]);
    assert.equal(await page.locator('#editor-overlay .block-sel').count(), 1);
    assert.match(await status(), /· 3×5 block/);
    await drag([1, 1], [2, 3], true);
    assert.equal(await page.locator('#editor-overlay .block-sel').count(), 0);
    assert.match(await status(), /· \d+ selected/);

    // 2. A row: right-click → Select row, copy, paste on the same line: it goes in above,
    //    everything below moves down and the vertical arrows are one line longer
    await click(3, 5, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Select row' }).click();
    assert.match(await status(), /· 1 row/);
    await page.keyboard.press('Control+C');
    await click(3, 0);
    await page.evaluate(() => window.__pasteClip());
    assert.deepEqual((await text()).slice(2, 7), ['+-+-+    +-+-+', '  |        |', '  |        |', '  v        v', '+---+    +---+']);

    // 3. A column with the keyboard: Shift+Down from the top selects the column; pasting it
    //    widens the gap between A and B, and the arrow between them stretches
    await page.keyboard.press('Control+Z');
    await click(0, 6);
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowDown');
    assert.match(await status(), /· 8×1 block/, 'down to the last line: still a rectangle');
    await page.keyboard.press('Shift+ArrowDown');
    assert.match(await status(), /· 1 column/, 'past the last line: whole columns');
    await page.keyboard.press('Control+C');
    await click(1, 6); // anywhere in that column: it goes in before it, on every line
    await page.evaluate(() => window.__pasteClip());
    assert.deepEqual(await text(), [
      '+---+     +---+',
      '| A +---->+ B |',
      '+-+-+     +-+-+',
      '  |         |',
      '  v         v',
      '+---+     +---+',
      '| C |     | D |',
      '+---+     +---+'
    ]);

    // 4. Cut of whole rows in insert mode removes the lines
    await page.keyboard.press('Control+Z');
    await drag([3, 0], [4, 20]); // a drag past the text is still a rectangle...
    assert.match(await status(), /· 2×21 block/);
    await page.keyboard.press('Escape');
    await click(3, 0); // ...whole rows come from the keyboard (or Select row)
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    assert.match(await status(), /· 2 rows/);
    await page.keyboard.press('Control+X');
    assert.deepEqual(await text(), [start[0], start[1], start[2], start[5], start[6], start[7]]);

    // 5. Overwrite mode: a copied rectangle is written over the text; Delete blanks a block
    await page.keyboard.press('Control+Z');
    await page.click('#toggle-overwrite');
    await drag([5, 0], [7, 4]); // box C
    await page.keyboard.press('Control+C');
    await click(5, 9);
    await page.evaluate(() => window.__pasteClip());
    assert.deepEqual((await text()).slice(5), ['+---+    +---+', '| C |    | C |', '+---+    +---+']);
    await drag([5, 9], [7, 13]);
    await page.keyboard.press('Delete');
    assert.deepEqual((await text()).slice(5), ['+---+', '| C |', '+---+']);

    // 6. With block mode off, Alt+drag selects a rectangle; Escape drops it
    await page.click('#toggle-block');
    await drag([0, 0], [2, 4], true);
    assert.match(await status(), /· 3×5 block/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#editor-overlay .block-sel').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('regression (PR #10 review): with Fit on, overwrite mode never auto-fits (Enter, typing over a selection)', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    const box = ['+-----+', '| A   |', '+-----+'];
    const set = (lines) => page.evaluate((v) => {
      const ed = document.getElementById('ascii-editor');
      ed.value = v.join('\n');
      ed.dispatchEvent(new Event('input'));
    }, lines);
    await set(box);
    assert.equal(await page.isChecked('#toggle-autofit'), true, 'Fit is on');
    await page.click('#toggle-overwrite');
    const caret = (r, c) => page.evaluate(([r, c]) => {
      const ed = document.getElementById('ascii-editor');
      const lines = ed.value.split('\n');
      let i = c;
      for (let k = 0; k < r; k++) i += lines[k].length + 1;
      ed.focus();
      ed.selectionStart = ed.selectionEnd = i;
    }, [r, c]);
    // Enter after "A": a plain line break, not a new bordered row
    await caret(1, 3);
    await page.keyboard.press('Enter');
    assert.equal(await page.inputValue('#ascii-editor'), ['+-----+', '| A', '   |', '+-----+'].join('\n'));
    // Typing over a selection: the first key replaces it as plain text (the box isn't
    // refitted), then the rest overwrite what follows, the wall included
    await set(box);
    await page.evaluate(() => { const ed = document.getElementById('ascii-editor'); ed.focus(); ed.selectionStart = 10; ed.selectionEnd = 11; });
    await page.keyboard.type('L');
    assert.equal(await page.inputValue('#ascii-editor'), ['+-----+', '| L   |', '+-----+'].join('\n'));
    await page.keyboard.type('ONGER');
    assert.equal(await page.inputValue('#ascii-editor'), ['+-----+', '| LONGER', '+-----+'].join('\n'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('nested example: copy the whole outer box and paste it beside itself; right-click Box in OVR vs INS; draw a box around a block', { skip }, async () => {
  const { browser, page, errors, setClipboard } = await openPage();
  try {
    await page.selectOption('#preset-select', 'nested');
    const text = () => page.inputValue('#ascii-editor').then((v) => v.split('\n'));
    const original = await text();
    const at = (r, c) => cellXY(page, r, c);
    const rclick = async (r, c, dx = 0) => { const p = await at(r, c); await page.mouse.click(p.x + dx, p.y, { button: 'right' }); };
    const item = (label) => page.locator('#ctx-menu button', { hasText: label }).first().click();
    assert.equal(await page.getAttribute('#ascii-editor', 'title'), null, 'no tooltip over the drawing');

    // 1. Select the outer box (it spans the whole diagram, but it's a box: a rectangle)
    await rclick(0, 20);
    await item('Select box');
    assert.match(await page.textContent('#cursor-pos'), /13×49 block/);
    await page.keyboard.press('Control+C');
    const copied = await page.evaluate(() => {
      const G = window.DitaaEngine.Grid2DEditor;
      return G.blockCopy(document.getElementById('ascii-editor').value, { r1: 0, c1: 0, r2: 12, c2: 48, kind: 'rect' }).text;
    });
    // 2. Right-click just after the top-right corner → Paste: a second copy beside the first
    setClipboard(copied);
    await rclick(0, 48, 3);
    await item('Paste');
    let ls = await text();
    assert.equal(ls.length, original.length, 'nothing inserted below');
    ls.forEach((l, i) => assert.equal(l, original[i] + original[i], `line ${i + 1}`));
    // ...the same with a left click there and Ctrl+V
    await page.keyboard.press('Control+Z');
    assert.deepEqual(await text(), original);
    const corner = await at(0, 48);
    await page.mouse.click(corner.x + 3, corner.y);
    await page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.getElementById('ascii-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, copied);
    ls = await text();
    ls.forEach((l, i) => assert.equal(l, original[i] + original[i], `Ctrl+V line ${i + 1}`));
    await page.keyboard.press('Control+Z');

    // 3. Right-click → Box right of App Service: OVR draws over the container's wall...
    await page.click('#toggle-overwrite');
    await rclick(4, 40);
    await item('→ Box');
    ls = await text();
    assert.equal(ls[0], original[0], 'the container keeps its size');
    assert.match(ls[4], /\|  App Service  \+--->\|  Component  \|$/);
    await page.keyboard.press('Control+Z');
    // ...INS makes room: the container grows
    await page.click('#toggle-overwrite');
    await rclick(4, 40);
    await item('→ Box');
    ls = await text();
    assert.ok(ls[0].length > original[0].length, 'the container grew');
    await page.keyboard.press('Control+Z');
    assert.deepEqual(await text(), original);

    // 4. +Box+ with a block selected draws a box around it (INS: room is made around it)
    const p1 = await at(3, 3), p2 = await at(11, 44); // the three inner boxes
    await page.mouse.move(Math.round(p1.x), Math.round(p1.y));
    await page.mouse.down();
    await page.mouse.move(Math.round(p2.x), Math.round(p2.y), { steps: 4 });
    await page.mouse.up();
    await page.click('#stamp-box');
    ls = await text();
    // The empty space around them is used: only the bottom needs a new line (the
    // container's wall was right below), and the inner boxes stay exactly where they were
    assert.equal(ls.length, original.length + 1);
    assert.equal(ls[2].slice(2, 46), '+' + '-'.repeat(42) + '+');
    for (let r = 3; r <= 11; r++) assert.equal(ls[r].slice(4, 43), original[r].slice(4, 43), `line ${r + 1}`);
    const n = await page.evaluate(() => new window.DitaaEngine.DitaaParser().parse(document.getElementById('ascii-editor').value).boxes.length);
    assert.equal(n, 5, 'one more box (4 + 1)');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('a block drag past the edge of the editor scrolls it, so the block can reach what was hidden; so do Shift+Arrows', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.value = Array.from({ length: 150 }, (_, i) => `${String(i).padStart(3, '0')} ` + 'x'.repeat(296)).join('\n');
      ed.dispatchEvent(new Event('input'));
      ed.focus();
      ed.selectionStart = ed.selectionEnd = 0; // (setting the text left the caret, and the view, at the end)
    });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => {
      const ed = document.getElementById('ascii-editor');
      ed.scrollTop = 0;
      ed.scrollLeft = 0;
      done();
    })));
    assert.equal(await page.evaluate(() => document.getElementById('ascii-editor').scrollTop), 0);
    const box = await page.locator('#ascii-editor').boundingBox();
    const state = () => page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      return { top: ed.scrollTop, left: ed.scrollLeft, status: document.getElementById('cursor-pos').textContent };
    });
    const rows = () => state().then((s) => { const m = s.status.match(/· (\d+)×(\d+) block/); return m ? [+m[1], +m[2]] : null; });
    // Drag from near the top-left to below the editor and hold there: it scrolls down
    await page.mouse.move(Math.round(box.x + 40), Math.round(box.y + 40));
    await page.mouse.down();
    await page.mouse.move(Math.round(box.x + 200), Math.round(box.y + box.height + 20), { steps: 5 });
    await page.waitForTimeout(600);
    const down = await state();
    assert.ok(down.top > 200, `scrolled down (${down.top})`);
    const [h1] = await rows();
    const visibleRows = Math.floor(box.height / 17);
    assert.ok(h1 > visibleRows, `the block reaches past the first screen (${h1} rows > ${visibleRows})`);
    // ...then past the right edge: it scrolls right too
    await page.mouse.move(Math.round(box.x + box.width + 40), Math.round(box.y + box.height - 60), { steps: 3 });
    await page.waitForTimeout(600);
    const right = await state();
    assert.ok(right.left > 200, `scrolled right (${right.left})`);
    const [, w1] = await rows();
    assert.ok(w1 * 7.8 > box.width, `the block is wider than the editor (${w1} columns)`);
    await page.mouse.up();
    // Releasing stops it
    const stopped = await state();
    await page.waitForTimeout(200);
    assert.equal((await state()).top, stopped.top, 'no more scrolling after the mouse is released');
    // Shift+Arrows keep the moving corner in view
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ed = document.getElementById('ascii-editor');
      ed.focus();
      ed.selectionStart = ed.selectionEnd = 0;
      ed.scrollTop = 0;
      ed.scrollLeft = 0;
    });
    for (let i = 0; i < 80; i++) await page.keyboard.press('Shift+ArrowDown');
    const kb = await state();
    assert.match(kb.status, /81×1 block/);
    assert.ok(kb.top > 200, `Shift+Down scrolled (${kb.top})`);
    await page.keyboard.press('Shift+End');
    assert.ok((await state()).left > 200, 'Shift+End scrolled right');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('select everything with a drag, Alt+Arrows (or the arrow buttons) move it together to make room, then draw a box around it', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.selectOption('#preset-select', 'arch');
    const text = () => page.inputValue('#ascii-editor').then((v) => v.split('\n'));
    const original = await text();
    const n = await page.evaluate(() => window.DitaaEngine.Grid2DEditor.diagramLineCount(document.getElementById('ascii-editor').value));
    const width = Math.max(...original.slice(0, n).map((l) => l.length));
    const nBoxes = () => page.evaluate(() => new window.DitaaEngine.DitaaParser().parse(document.getElementById('ascii-editor').value).boxes.length);
    const boxes0 = await nBoxes();
    const p1 = await cellXY(page, 0, 0), p2 = await cellXY(page, n - 1, width - 1);
    await page.mouse.move(Math.round(p1.x), Math.round(p1.y));
    await page.mouse.down();
    await page.mouse.move(Math.round(p2.x), Math.round(p2.y), { steps: 5 });
    await page.mouse.up();
    assert.match(await page.textContent('#cursor-pos'), new RegExp(`· ${n}×${width} block`));
    await page.keyboard.press('Alt+ArrowRight');
    await page.click('#shift-right'); // the toolbar arrows do the same
    await page.keyboard.press('Alt+ArrowDown');
    await page.click('#shift-down');
    assert.match(await page.textContent('#cursor-pos'), new RegExp(`· ${n}×${width} block`), 'still selected');
    let ls = await text();
    for (let r = 0; r < n; r++) assert.equal(ls[r + 2], original[r] ? '  ' + original[r] : '', `line ${r + 1} moved together`);
    assert.equal(ls[0], '');
    assert.equal(ls[ls.length - 1], original[original.length - 1], 'the legend stays put');
    // Now there is room: select around it and draw the box, even in OVR nothing is covered
    await page.click('#toggle-overwrite');
    const q1 = await cellXY(page, 0, 0), q2 = await cellXY(page, n + 3, width + 3);
    await page.mouse.move(Math.round(q1.x), Math.round(q1.y));
    await page.mouse.down();
    await page.mouse.move(Math.round(q2.x), Math.round(q2.y), { steps: 5 });
    await page.mouse.up();
    await page.click('#stamp-box');
    ls = await text();
    assert.equal(ls[0], '+' + '-'.repeat(width + 2) + '+');
    assert.equal(await nBoxes(), boxes0 + 1, 'every box intact, plus the new one');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('moving a container keeps it selected; drag a block to move it; delete a line / box; the preview shows the whole block selected', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.selectOption('#preset-select', 'nested');
    const text = () => page.inputValue('#ascii-editor').then((v) => v.split('\n'));
    const pill = () => page.textContent('#active-box-pill');
    const at = (r, c) => cellXY(page, r, c);
    const click = async (r, c, opts) => { const p = await at(r, c); await page.mouse.click(Math.round(p.x), Math.round(p.y), opts); };
    const marks = () => page.locator('#svg-wrapper rect[stroke="#6366f1"][stroke-dasharray="4,2"]').count();
    // 1. Select the container (click its top-left inside), move it: it stays the selected box
    await click(1, 1);
    const container = await pill();
    for (const key of ['Alt+ArrowRight', 'Alt+ArrowDown', 'Alt+ArrowRight']) {
      await page.keyboard.press(key);
      assert.equal(await pill(), container, `${key}: still the container, not the box at its centre`);
    }
    await page.keyboard.press('Control+Z');
    await page.keyboard.press('Control+Z');
    await page.keyboard.press('Control+Z');
    const original = await text();

    // 2. A block selection shows every box inside it selected in the preview
    const drag = async (a, b) => {
      const p = await at(...a), q = await at(...b);
      await page.mouse.move(Math.round(p.x), Math.round(p.y));
      await page.mouse.down();
      await page.mouse.move(Math.round(q.x), Math.round(q.y), { steps: 4 });
      await page.mouse.up();
    };
    await drag([3, 3], [6, 44]); // Ingress and App Service (its right wall is column 43)
    assert.equal(await marks(), 2);

    // 3. Drag the selection by pressing inside it: a ghost shows where it lands; drop places it
    const from = await at(4, 10), to = await at(4 + 6, 10);
    await page.mouse.move(Math.round(from.x), Math.round(from.y));
    await page.mouse.down();
    await page.mouse.move(Math.round(to.x), Math.round(to.y), { steps: 4 });
    assert.equal(await page.locator('#editor-overlay .block-ghost').count(), 1, 'a ghost while dragging');
    assert.match(await page.locator('#editor-overlay .block-ghost').textContent(), /Ingress/);
    await page.mouse.up();
    let ls = await text();
    assert.equal(await page.locator('#editor-overlay .block-ghost').count(), 0);
    assert.match(await page.textContent('#cursor-pos'), /4×42 block/, 'still selected where it landed');
    assert.ok(ls[9].includes('Ingress') || ls[10].includes('Ingress'), ls.join('\n'));
    assert.ok(!ls[4].includes('Ingress'), 'lifted from where it was');
    await page.keyboard.press('Control+Z');
    assert.deepEqual(await text(), original);

    // 4. Right-click the arrow → Delete line: traced to both ends, ports become wall
    await page.keyboard.press('Escape');
    await click(7, 35, { button: 'right' });
    await page.locator('#ctx-menu button', { hasText: 'Delete line' }).click();
    ls = await text();
    assert.ok(!/[|v]/.test(ls[7].slice(1, 47) + ls[8].slice(1, 47)), 'the arrow is gone (inside the container)');
    assert.equal(ls[6].slice(27, 44), '+---------------+', 'App Service: its port is wall again');
    assert.equal(ls[9].slice(27, 44), '+---------------+', 'Database: its port is wall again');
    // 5. Del button with the caret in a box deletes the box
    await click(10, 30);
    await page.click('#btn-delete');
    ls = await text();
    assert.ok(!ls.join('\n').includes('Database'), 'the box is gone');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('the divider between the editor and the preview can be dragged, all the way to either side, and reset', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    const widths = () => page.evaluate(() => [
      document.getElementById('editor-pane').getBoundingClientRect().width,
      document.getElementById('preview-pane').getBoundingClientRect().width
    ]);
    const [e0] = await widths();
    const dragTo = async (x) => {
      const d = await page.locator('#pane-divider').boundingBox(); // where it is now
      await page.mouse.move(d.x + d.width / 2, d.y + 200);
      await page.mouse.down();
      await page.mouse.move(x, d.y + 200, { steps: 5 });
      await page.mouse.up();
    };
    // (the divider itself stays reachable when the preview is hidden: it's at the right edge)
    await dragTo(300);
    let [e1, p1] = await widths();
    assert.ok(Math.abs(e1 - 300) < 12, `the editor is about 300px wide (${e1})`);
    assert.ok(p1 > 1000, 'the preview takes the rest');
    await dragTo(1435); // all the way right: the editor gets everything
    [e1, p1] = await widths();
    assert.equal(p1, 0, 'the preview is hidden');
    assert.ok(e1 > 1400);
    // ...but the divider stays on screen, so it can be dragged back
    const edge = await page.locator('#pane-divider').boundingBox();
    assert.ok(edge.width > 0 && edge.x >= 0 && edge.x + edge.width <= 1440, `divider at ${edge.x}+${edge.width}`);
    await dragTo(700);
    assert.ok((await widths())[1] > 600, 'dragged back: the preview is there again');
    await dragTo(1435);
    // ...and it is remembered
    await page.reload();
    assert.equal((await widths())[1], 0);
    await page.dblclick('#pane-divider');
    const [e2] = await widths();
    assert.ok(Math.abs(e2 - e0) < 2, 'double-click resets');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('a nested box copied with a drag (even one past its edge) pastes beside itself, in INS and OVR', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.selectOption('#preset-select', 'nested');
    await page.evaluate(() => {
      let clip = '';
      document.addEventListener('copy', (e) => { clip = e.clipboardData.getData('text/plain'); });
      window.__pasteClip = () => {
        const dt = new DataTransfer();
        dt.setData('text/plain', clip);
        document.getElementById('ascii-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      };
    });
    const text = () => page.inputValue('#ascii-editor').then((v) => v.split('\n'));
    const original = await text();
    const at = (r, c) => cellXY(page, r, c);
    const p = await at(0, 0), q = await at(12, 49); // one column past the right wall
    await page.mouse.move(Math.round(p.x), Math.round(p.y));
    await page.mouse.down();
    await page.mouse.move(Math.round(q.x), Math.round(q.y), { steps: 4 });
    await page.mouse.up();
    assert.match(await page.textContent('#cursor-pos'), /13×50 block/, 'a rectangle, not whole rows');
    await page.keyboard.press('Control+C');
    // INS: click just right of the top-right corner, paste: a second copy beside it
    const corner = await at(0, 48);
    await page.mouse.click(Math.round(corner.x + 3), Math.round(corner.y));
    await page.evaluate(() => window.__pasteClip());
    let ls = await text();
    assert.equal(ls.length, original.length, 'nothing went below');
    ls.forEach((l, i) => assert.equal(l.replace(/\s+$/, ''), (original[i] + original[i] + ' ').replace(/\s+$/, ''), `INS line ${i + 1}`));
    // OVR: the same, writing into the empty space beside it
    await page.keyboard.press('Control+Z');
    await page.click('#toggle-overwrite');
    const beyond = await at(0, 49);
    await page.mouse.click(Math.round(beyond.x), Math.round(beyond.y));
    await page.evaluate(() => window.__pasteClip());
    ls = await text();
    ls.forEach((l, i) => assert.equal(l.replace(/\s+$/, ''), (original[i] + original[i] + ' ').replace(/\s+$/, ''), `OVR line ${i + 1}`));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('import: an SVG file, a PNG picture of the diagram, and pasted SVG markup become ditaa text', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    await page.selectOption('#preset-select', 'nested');
    const count = () => page.evaluate(() => {
      const p = new window.DitaaEngine.DitaaParser();
      const ast = p.parse(document.getElementById('ascii-editor').value);
      return { boxes: ast.boxes.length, connections: p.connections(ast).length, labels: ast.boxes.map((b) => b.lines[0]).filter(Boolean).sort() };
    });
    const before = await count();
    const svg = await page.evaluate(() => {
      const p = new window.DitaaEngine.DitaaParser();
      return p.renderSVG(p.parse(document.getElementById('ascii-editor').value));
    });
    // 1. An SVG through the Import button
    await page.evaluate(() => { document.getElementById('ascii-editor').value = ''; document.getElementById('ascii-editor').dispatchEvent(new Event('input')); });
    await page.setInputFiles('#import-file', { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    await page.waitForFunction(() => document.getElementById('ascii-editor').value.length > 0);
    assert.deepEqual(await count(), before);
    assert.match(await page.textContent('#toast-indicator'), /Imported 4 boxes, 2 lines, 2 arrows/);
    // ...and Ctrl+Z puts back what was there
    await page.keyboard.press('Control+Z');
    assert.equal(await page.inputValue('#ascii-editor'), '');
    // 2. A PNG of the diagram, drawn by the browser
    const png = await page.evaluate(async (markup) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      cv.getContext('2d').drawImage(img, 0, 0);
      return cv.toDataURL('image/png').split(',')[1];
    }, svg);
    await page.setInputFiles('#import-file', { name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(() => document.getElementById('ascii-editor').value.length > 0);
    const fromPng = await count();
    assert.equal(fromPng.boxes, before.boxes, await page.inputValue('#ascii-editor'));
    assert.equal(fromPng.connections, before.connections);
    assert.match(await page.textContent('#toast-indicator'), /placeholder labels/);
    // 3. Pasting SVG markup imports it
    await page.evaluate(() => { document.getElementById('ascii-editor').value = ''; document.getElementById('ascii-editor').dispatchEvent(new Event('input')); });
    await page.evaluate((markup) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', markup);
      const ed = document.getElementById('ascii-editor');
      ed.focus();
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, svg);
    await page.waitForFunction(() => document.getElementById('ascii-editor').value.length > 0);
    assert.deepEqual(await count(), before);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('importing pictures of the busier examples finds most of their boxes and connections', { skip }, async () => {
  const { browser, page, errors } = await openPage();
  try {
    // [example, at least this many boxes, at least this many connections] (pictures are best-effort)
    for (const [preset, minBoxes, minConns] of [['nested', 4, 2], ['microservices', 5, 7], ['arch', 5, 7], ['flowchart', 5, 7]]) {
      await page.selectOption('#preset-select', preset);
      const got = await page.evaluate(async () => {
        const P = new window.DitaaEngine.DitaaParser();
        const svg = P.renderSVG(P.parse(document.getElementById('ascii-editor').value));
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        const res = window.DiagramImport.importDiagram({ width: cv.width, height: cv.height, data: g.getImageData(0, 0, cv.width, cv.height).data });
        const ast = P.parse(res.text);
        return { boxes: ast.boxes.length, conns: P.connections(ast).length, text: res.text };
      });
      assert.ok(got.boxes >= minBoxes, `${preset}: ${got.boxes} boxes\n${got.text}`);
      assert.ok(got.conns >= minConns, `${preset}: ${got.conns} connections\n${got.text}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('nothing is ever fetched from the network: loading, editing, importing, previewing and exporting', { skip }, async () => {
  const { browser, page, errors, requests } = await openPage();
  try {
    for (const preset of ['arch', 'showcase', 'nested']) await page.selectOption('#preset-select', preset);
    const svg = await page.evaluate(() => {
      const p = new window.DitaaEngine.DitaaParser();
      return p.renderSVG(p.parse(document.getElementById('ascii-editor').value));
    });
    // import an SVG and a picture
    await page.setInputFiles('#import-file', { name: 'd.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    const png = await page.evaluate(async (markup) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      cv.getContext('2d').drawImage(img, 0, 0);
      return cv.toDataURL('image/png').split(',')[1];
    }, svg);
    await page.setInputFiles('#import-file', { name: 'd.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(() => /Box 1/.test(document.getElementById('ascii-editor').value));
    // preview settings, zoom, exports
    await page.selectOption('#preset-select', 'flowchart');
    for (const id of ['#toggle-shadows', '#toggle-grid', '#toggle-light-canvas']) await page.click(id);
    await page.click('#btn-download-svg');
    await page.click('#btn-download-png');
    await page.click('#btn-legacy-modal');
    await page.waitForTimeout(300);
    assert.deepEqual(requests, [], 'no request to any host');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
