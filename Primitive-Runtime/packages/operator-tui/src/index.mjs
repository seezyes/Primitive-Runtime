import { Renderer } from "./core/render.mjs";
import { createInputDecoder } from "./core/input.mjs";
import { PanelController } from "./controller.mjs";
import { renderFrame } from "./screens.mjs";

export { PanelController, renderFrame };

/** Open an operator-only panel. Closing it never calls stop/drain/cancel. */
export async function runTui({
  call,
  input = process.stdin,
  output = process.stdout,
  refreshMs = 3000,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const error = new Error(
      "The operator panel requires an interactive terminal. Use the control CLI for redirected input/output.",
    );
    error.code = "TTY_REQUIRED";
    throw error;
  }
  const renderer = new Renderer(output);
  let frame = { lines: [], hits: [] },
    closed = false,
    timer,
    pendingFrame,
    resolveClosed;
  const completion = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const originalRaw = Boolean(input.isRaw),
    originalPaused = input.isPaused?.() ?? false;
  const draw = () => {
    if (closed || pendingFrame) return;
    pendingFrame = setTimeout(() => {
      pendingFrame = null;
      if (closed) return;
      const size = { width: output.columns || 100, height: output.rows || 30 };
      frame = renderFrame(controller.state, size.width, size.height);
      renderer.frame(frame.lines, size);
    }, 20);
  };
  const controller = new PanelController({
    call,
    onChange: draw,
    onClose: () => {
      closed = true;
      resolveClosed();
    },
  });
  let queue = Promise.resolve();
  const enqueue = (action) => {
    queue = queue
      .then(() => (closed ? undefined : action()))
      .catch(() => {
        controller.state.message =
          "PANEL_ERROR: action could not be completed.";
        controller.state.error = true;
        draw();
      });
  };
  const decoder = createInputDecoder(
    (key) => {
      // Ctrl+C can close a panel while a bounded network probe is still pending.
      if (key.ctrl && key.name === "c") controller.close();
      else enqueue(() => controller.key(key));
    },
    (button, x, y, released) =>
      enqueue(() => controller.mouse(button, x, y, released, frame.hits)),
  );
  const data = (chunk) => decoder.write(chunk);
  const resize = () => {
    renderer.reset();
    draw();
  };
  const end = () => controller.close();
  const signal = () => controller.close();
  try {
    input.setRawMode(true);
    input.resume();
    output.write(
      "\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h",
    );
    input.on("data", data);
    input.on("end", end);
    input.on("error", end);
    output.on("resize", resize);
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    draw();
    // All control calls inherit the authenticated, bounded IPC client supplied by CLI.
    void controller.refresh();
    timer = setInterval(
      () => {
        if (!controller.state.busy && !controller.state.closed)
          void controller.refresh({ quiet: true });
      },
      Math.max(1000, refreshMs),
    );
    await completion;
  } finally {
    closed = true;
    clearInterval(timer);
    clearTimeout(pendingFrame);
    decoder.close();
    input.off("data", data);
    input.off("end", end);
    input.off("error", end);
    output.off("resize", resize);
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    input.setRawMode(originalRaw);
    if (originalPaused) input.pause();
    output.write(
      "\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?7h\x1b[0m\x1b[?1049l",
    );
  }
}
