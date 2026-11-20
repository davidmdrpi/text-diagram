'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('text-diagram.html is self-contained and up to date with src/ (run `npm run build`)', () => {
  const html = read('text-diagram.html');
  assert.ok(html.includes(read('src/engine.js')), 'src/engine.js changed since the last build');
  assert.ok(html.includes(read('src/app.js')), 'src/app.js changed since the last build');
  assert.ok(html.includes(read('src/import.js')), 'src/import.js changed since the last build');
  assert.ok(!/<script[^>]+src=/.test(html), 'must not load external scripts');
  assert.ok(!html.includes('cdn.tailwindcss.com'), 'Tailwind must be compiled in, not loaded from the CDN');
  // Nothing is fetched from anywhere: no remote stylesheets, fonts, preconnects or CSS urls
  assert.ok(!/<link\b[^>]*href=["']?(https?:)?\/\//i.test(html), 'must not link remote stylesheets or fonts');
  assert.ok(!/rel=["']?(preconnect|dns-prefetch|preload|prefetch)/i.test(html), 'must not preconnect to other hosts');
  assert.ok(!/url\(\s*["']?(https?:)?\/\//i.test(html), 'CSS must not load remote resources');
  assert.ok(!/@import\s/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'CSS must not @import anything');
  const markup = (s) => s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '')
      .split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').join('\n');
  assert.equal(markup(html), markup(read('index.html')), 'index.html markup changed since the last build');
});
