// Adapted from the user-supplied tui-mockup-src.zip; see ../../NOTICE.md.
// lib/listview.mjs — единый модуль списков: cursor/offset/viewport.
// Чистые функции без зависимостей от screens/mouse/keydispatch.
// Один источник истины для всех скроллящихся списков:
// models (cursor), harness-picker (pickCursor), usage/logs (offset-only).

export const WHEEL_STEP = 3;

export function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.trunc(n);
}

/** Окно для cursor-списка, центрированное на курсоре. */
export function cursorWindow(cursor, length, viewport) {
  const len = Math.max(0, Math.trunc(length) || 0);
  const vp = Math.max(1, Math.trunc(viewport) || 1);
  if (len === 0) return { start: 0, offset: 0, rows: 0 };
  const cur = clamp(cursor ?? 0, 0, len - 1);
  const start = clamp(cur - Math.floor(vp / 2), 0, Math.max(0, len - vp));
  const rows = Math.min(vp, len - start);
  return { start, offset: start, rows };
}

/** Окно для offset-списка (без курсора). */
export function offsetWindow(offset, length, viewport) {
  const len = Math.max(0, Math.trunc(length) || 0);
  const vp = Math.max(1, Math.trunc(viewport) || 1);
  if (len === 0) return { start: 0, offset: 0, rows: 0 };
  const start = clamp(offset ?? 0, 0, Math.max(0, len - vp));
  const rows = Math.min(vp, len - start);
  return { start, offset: start, rows };
}

/** Окно, которое сохраняет текущий offset, пока курсор в нём виден.
 *  Иначе минимальный сдвиг: вверх — курсор первой строкой, вниз — последней.
 *  Не центрирует: клик по уже видимой строке не должен прокручивать список. */
export function followWindow(offset, cursor, length, viewport) {
  const len = Math.max(0, Math.trunc(length) || 0);
  const vp = Math.max(1, Math.trunc(viewport) || 1);
  if (len === 0) return { start: 0, offset: 0, rows: 0 };
  const cur = clamp(cursor ?? 0, 0, len - 1);
  const maxStart = Math.max(0, len - vp);
  let start = clamp(offset ?? 0, 0, maxStart);
  if (cur < start) start = cur;
  else if (cur >= start + vp) start = cur - vp + 1;
  start = clamp(start, 0, maxStart);
  return { start, offset: start, rows: Math.min(vp, len - start) };
}

/** Пересчитать offset/rows из текущего cursor, не двигая cursor (для рендера).
 *  Сохраняет offset, пока курсор виден; центрирование — только у moveCursor. */
export function ensureCursorVisible(view, length, viewport) {
  const len = Math.max(0, Math.trunc(length) || 0);
  const cur = len === 0 ? 0 : clamp(view?.cursor ?? 0, 0, len - 1);
  const w = followWindow(view?.offset ?? 0, cur, len, viewport);
  if (view) {
    view.cursor = cur;
    view.offset = w.offset;
    view.rows = w.rows;
  }
  return w;
}

/** Кламп offset-списка (для рендера). */
export function ensureOffsetVisible(view, length, viewport) {
  const w = offsetWindow(view?.offset ?? 0, length, viewport);
  if (view) {
    view.offset = w.offset;
    view.rows = w.rows;
  }
  return w;
}

/** Сдвинуть cursor на delta (±1 стрелки, ±page, ±wheel). */
export function moveCursor(view, length, viewport, delta) {
  const len = Math.max(0, Math.trunc(length) || 0);
  if (!view || len === 0) return view;
  view.cursor = clamp(
    (view.cursor ?? 0) + (Math.trunc(delta) || 0),
    0,
    len - 1,
  );
  const w = cursorWindow(view.cursor, len, viewport);
  view.offset = w.offset;
  view.rows = w.rows;
  return view;
}

/** Поставить cursor абсолютно (клик). Возвращает false если idx вне списка.
 *  Уже видимую строку не прокручивает; выше окна — к верхнему краю, ниже — к нижнему. */
export function setCursor(view, length, viewport, idx) {
  const len = Math.max(0, Math.trunc(length) || 0);
  if (!view || !Number.isInteger(idx) || idx < 0 || idx >= len) return false;
  view.cursor = idx;
  const w = followWindow(view.offset ?? 0, idx, len, viewport);
  view.offset = w.offset;
  view.rows = w.rows;
  return true;
}

export function goHome(view, length, viewport) {
  if (!view) return view;
  view.offset = 0;
  return setCursor(view, length, viewport, 0) ? view : view;
}

export function goEnd(view, length, viewport) {
  const len = Math.max(0, Math.trunc(length) || 0);
  if (!view || len === 0) return view;
  const vp = Math.max(1, Math.trunc(viewport) || 1);
  view.offset = Math.max(0, len - vp);
  return setCursor(view, length, viewport, len - 1) ? view : view;
}

/** Скролл offset-списка на delta (стрелки/колесо). */
export function scrollOffset(view, length, viewport, delta) {
  const len = Math.max(0, Math.trunc(length) || 0);
  const vp = Math.max(1, Math.trunc(viewport) || 1);
  if (!view || len === 0) {
    if (view) {
      view.offset = 0;
      view.rows = 0;
    }
    return view;
  }
  view.offset = clamp(
    (view.offset ?? 0) + (Math.trunc(delta) || 0),
    0,
    Math.max(0, len - vp),
  );
  view.rows = Math.min(vp, len - view.offset);
  return view;
}

/** Колесо для cursor-списка. dir: -1 вверх, +1 вниз. */
export function wheelCursor(view, length, viewport, dir, step = WHEEL_STEP) {
  return moveCursor(
    view,
    length,
    viewport,
    (dir > 0 ? 1 : -1) * Math.max(1, step),
  );
}

/** Колесо для offset-списка. */
export function wheelOffset(view, length, viewport, dir, step = WHEEL_STEP) {
  return scrollOffset(
    view,
    length,
    viewport,
    (dir > 0 ? 1 : -1) * Math.max(1, step),
  );
}
