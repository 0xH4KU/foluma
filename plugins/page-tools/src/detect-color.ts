import type { CropMargins, PageColor } from "../../../sdk/page-layout.ts";

export function detectColor(pixels: Uint8ClampedArray, width: number, height: number,
  margins: CropMargins = [0, 0, 0, 0]): { color: PageColor; certain: boolean } {
  const left = Math.floor(width * margins[0] / 100), top = Math.floor(height * margins[1] / 100);
  const right = Math.ceil(width * (1 - margins[2] / 100)), bottom = Math.ceil(height * (1 - margins[3] / 100));
  const band = Math.max(1, Math.round(Math.min(right - left, bottom - top) * 0.02));
  const edges = Array.from({ length: 4 }, () => ({ black: 0, white: 0, total: 0 }));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    if (x >= left + band && x < right - band && y >= top + band && y < bottom - band) continue;
    const offset = (y * width + x) * 4;
    const alpha = pixels[offset + 3] / 255;
    const brightness = (0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]) * alpha + 255 * (1 - alpha);
    for (const [side, near] of [x < left + band, y < top + band, x >= right - band, y >= bottom - band].entries()) {
      if (!near) continue;
      if (brightness < 64) edges[side].black++;
      if (brightness > 192) edges[side].white++;
      edges[side].total++;
    }
  }
  const strength = (color: PageColor) => Math.max(...[0, 1].map(side =>
    (edges[side][color] / (edges[side].total || 1) + edges[side + 2][color] / (edges[side + 2].total || 1)) / 2));
  const black = strength("black"), white = strength("white");
  return { color: black >= 0.75 ? "black" : "white", certain: Math.max(black, white) >= 0.75 && Math.min(black, white) < 0.75 };
}
