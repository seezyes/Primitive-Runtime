// Adapted from the user-supplied tui-mockup-src.zip; see ../../NOTICE.md.
import { StringDecoder } from "node:string_decoder";

const CYR = Object.fromEntries(
  [..."йцукенгшщзхъфывапролджэячсмитьбюё"].map((c, i) => [
    c,
    [..."qwertyuiop[]asdfghjkl;'zxcvbnm,.`"][i],
  ]),
);

export function characterKey(ch) {
  if (ch === "\r" || ch === "\n") return { name: "return", sequence: "\r" };
  if (ch === "\t") return { name: "tab", sequence: ch };
  if (ch === "\x7f" || ch === "\b") return { name: "backspace", sequence: ch };
  if (ch < " ")
    return {
      name: String.fromCharCode(ch.charCodeAt(0) + 96),
      ctrl: true,
      sequence: ch,
    };
  const low = ch.toLowerCase();
  return {
    name: CYR[low] ?? low,
    sequence: ch,
    ctrl: false,
    shift: ch !== low,
  };
}

// Keep incomplete CSI/SGR packets across stdin chunks. Unknown escape sequences
// are discarded whole, never interpreted as shortcut characters.
// Windows Enter (\r\n) collapses to a single return; legacy X10 mouse (ESC[M...)
// is parsed as a best-effort fallback to SGR.
export function createInputDecoder(onKey, onMouse, escapeDelay = 50) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    timer,
    seqTimer,
    paste = false;
  // Windows Enter приходит как пара \r\n — схлопываем в один return,
  // иначе picker/деталь открываются и тут же закрываются вторым нажатием.
  // Состояние живёт между чанками: \r в конце чанка + \n в начале следующего тоже схлопнется.
  let lastNewline = null;
  function emitChar(ch) {
    if (ch === "\r" || ch === "\n") {
      if (lastNewline && ch !== lastNewline) {
        lastNewline = null;
        return;
      }
      lastNewline = ch;
      onKey(characterKey(ch));
      return;
    }
    lastNewline = null;
    onKey(characterKey(ch));
  }
  function drain() {
    clearTimeout(timer);
    while (pending) {
      if (paste) {
        const end = pending.indexOf("\x1b[201~");
        if (end < 0) return;
        const sequence = pending.slice(0, end);
        pending = pending.slice(end + 6);
        paste = false;
        onKey({ name: "paste", sequence });
        continue;
      }
      if (pending.startsWith("\x1b[200~")) {
        pending = pending.slice(6);
        paste = true;
        continue;
      }
      if (pending[0] !== "\x1b") {
        const ch = String.fromCodePoint(pending.codePointAt(0));
        pending = pending.slice(ch.length);
        emitChar(ch);
        continue;
      }
      if (pending.length === 1) {
        timer = setTimeout(() => {
          pending = "";
          lastNewline = null;
          onKey({ name: "escape", sequence: "\x1b" });
        }, escapeDelay);
        return;
      }
      if (pending[1] !== "[" && pending[1] !== "O") {
        lastNewline = null;
        pending = pending.slice(2);
        continue;
      }
      // Legacy X10-мышь: ESC [ M Cb Cx Cy (fallback когда хост не дал SGR).
      // Best-effort для небольших окон: байты >127 могут побиться UTF8-декодером.
      if (pending.startsWith("\x1b[M")) {
        if (pending.length < 6) {
          clearTimeout(seqTimer);
          seqTimer = setTimeout(() => {
            pending = "";
            lastNewline = null;
          }, escapeDelay);
          return;
        }
        const btn = pending.charCodeAt(3) - 32;
        const x = pending.charCodeAt(4) - 33;
        const y = pending.charCodeAt(5) - 33;
        pending = pending.slice(6);
        lastNewline = null;
        if (
          Number.isInteger(btn) &&
          Number.isInteger(x) &&
          Number.isInteger(y) &&
          x >= -1 &&
          y >= -1
        ) {
          onMouse(btn, x, y, (btn & 3) === 3);
        }
        continue;
      }
      const packet = /^\x1b(?:\[|O)([0-9;?<]*)([ -/]*)([@-~])/.exec(pending);
      if (!packet) {
        // Обрывок CSI/SGR (обрезанный фрейм мыши) не должен навсегда блокировать
        // декодер и глотать последующие клавиши — через escapeDelay выбрасываем целиком.
        clearTimeout(seqTimer);
        seqTimer = setTimeout(() => {
          pending = "";
          lastNewline = null;
        }, escapeDelay);
        return;
      }
      pending = pending.slice(packet[0].length);
      lastNewline = null;
      const [, params, , final] = packet;
      const mouse = /^<(\d+);(\d+);(\d+)$/.exec(params);
      if (mouse && /[Mm]/.test(final)) {
        onMouse(+mouse[1], +mouse[2] - 1, +mouse[3] - 1, final === "m");
        continue;
      }
      const name =
        final === "~"
          ? {
              1: "home",
              2: "insert",
              3: "delete",
              4: "end",
              5: "pageup",
              6: "pagedown",
              7: "home",
              8: "end",
            }[params.split(";")[0]]
          : { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[
              final
            ];
      if (name) onKey({ name, sequence: packet[0] });
    }
  }
  return {
    write(chunk) {
      clearTimeout(seqTimer);
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (pending.length > 65536) {
        pending = "";
        paste = false;
        return;
      }
      drain();
    },
    close() {
      clearTimeout(timer);
      clearTimeout(seqTimer);
      pending = "";
      paste = false;
    },
  };
}
