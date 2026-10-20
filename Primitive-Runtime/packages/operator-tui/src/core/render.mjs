// Palette and row-diff rendering adapted from tui-mockup-src.zip.
// See ../../NOTICE.md. All external strings pass through safeText first.

export const T = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
});
const fg = (hex) => {
  const n = Number.parseInt(hex, 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
export const C = Object.freeze({
  frame: fg("2a3550"),
  title: fg("e8eef7"),
  text: fg("c9d4e3"),
  dim: fg("6b7d96"),
  accent: fg("39c5ff"),
  ok: fg("3fdc97"),
  warn: fg("ffc857"),
  err: fg("ff6b6b"),
  purple: fg("b18cff"),
});
const SGR = /\x1b\[[0-9;]*m/g;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Strip terminal controls, including OSC hyperlinks/title changes and CSI. */
export function safeText(value, max = 4096) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, max);
}
export const stripAnsi = (value) => String(value).replace(SGR, "");

function codePointWidth(cp) {
  if (cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}
export function graphemeWidth(grapheme) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme))
    return 2;
  let width = 0;
  for (const char of grapheme)
    if (!/\p{Mark}|[\u200b\u200d\ufeff]/u.test(char))
      width += codePointWidth(char.codePointAt(0));
  return width;
}
export function visibleWidth(value) {
  let width = 0;
  for (const { segment } of segmenter.segment(stripAnsi(value)))
    width += graphemeWidth(segment);
  return width;
}
export function tailCells(value, width) {
  const segments = [...segmenter.segment(String(value))].map(
    (item) => item.segment,
  );
  let used = 0,
    start = segments.length;
  while (start > 0) {
    const next = graphemeWidth(segments[start - 1]);
    if (used + next > width) break;
    used += next;
    start--;
  }
  return segments.slice(start).join("");
}
export function trunc(value, width) {
  width = Math.max(0, Math.floor(width));
  const text = String(value);
  if (visibleWidth(text) <= width) return text;
  if (width === 0) return "";
  let used = 0,
    result = "";
  const tokens = text.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) ?? [];
  outer: for (const token of tokens) {
    if (token.startsWith("\x1b")) {
      result += token;
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      const cells = graphemeWidth(segment);
      if (used + cells > width - 1) break outer;
      used += cells;
      result += segment;
    }
  }
  return result + "…" + T.reset;
}
export function fit(value, width) {
  width = Math.max(0, Math.floor(width));
  const text = trunc(value, width);
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export class Renderer {
  constructor(output = process.stdout) {
    this.output = output;
    this.previous = null;
    this.size = "";
  }
  reset() {
    this.previous = null;
    this.size = "";
  }
  frame(lines, size) {
    const key = `${size?.width ?? ""}:${size?.height ?? ""}`;
    if (key !== this.size) {
      this.previous = null;
      this.size = key;
    }
    const buffer = [];
    for (let i = 0; i < lines.length; i++) {
      if (this.previous?.[i] !== lines[i])
        buffer.push(`\x1b[${i + 1};1H\x1b[2K${lines[i]}${T.reset}`);
    }
    if (this.previous && this.previous.length > lines.length) {
      for (let i = lines.length; i < this.previous.length; i++)
        buffer.push(`\x1b[${i + 1};1H\x1b[2K`);
    }
    if (buffer.length) this.output.write(buffer.join("") + "\x1b[?25l");
    this.previous = lines.slice();
  }
}
