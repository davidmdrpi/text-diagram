// A tiny rasterizer for tests: white canvas, filled rects, strokes, triangles

function canvas(W, H) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y, [r, g, b]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; };
  const fillRect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c); };
  const box = (x, y, w, h, fill, stroke = [30, 41, 59], t = 2) => { if (fill) fillRect(x, y, w, h, fill); fillRect(x, y, w, t, stroke); fillRect(x, y + h - t, w, t, stroke); fillRect(x, y, t, h, stroke); fillRect(x + w - t, y, t, h, stroke); };
  const hline = (x1, x2, y, c = [30, 41, 59], t = 2) => fillRect(Math.min(x1, x2), y - (t >> 1), Math.abs(x2 - x1) + 1, t, c);
  const vline = (x, y1, y2, c = [30, 41, 59], t = 2) => fillRect(x - (t >> 1), Math.min(y1, y2), t, Math.abs(y2 - y1) + 1, c);
  const tri = (x, y, dir, c = [30, 41, 59]) => { for (let k = 0; k < 10; k++) for (let j = -Math.floor(k / 2); j <= Math.floor(k / 2); j++) { if (dir === 'right') set(x - k, y + j, c); if (dir === 'left') set(x + k, y + j, c); if (dir === 'down') set(x + j, y - k, c); if (dir === 'up') set(x + j, y + k, c); } };
  const text = (x, y, n) => { for (let k = 0; k < n; k++) fillRect(x + k * 8, y, 5, 9, [20, 20, 20]); };
  return { W, H, data, box, hline, vline, tri, fillRect, text };
}
module.exports = canvas;
