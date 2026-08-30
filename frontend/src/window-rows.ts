/**
 * Which slice of a uniformly-sized list is worth rendering.
 *
 * Extracted from `Sidebar` so it can be tested. Windowing is arithmetic that
 * looks obviously right and is wrong at the edges — an off-by-one at the top of
 * the list, a slice that runs past the end after a search narrows it, a stride
 * that disagrees with CSS — and every one of those failures presents as "the
 * list looks a bit odd sometimes", which is exactly the kind of bug that
 * survives a manual check.
 */

/**
 * Rows rendered either side of the visible window, so a fast flick does not
 * expose a blank strip before the scroll handler catches up.
 */
export const OVERSCAN_ROWS = 8;

/**
 * Below this the whole list is rendered outright. Windowing costs a scroll
 * listener, a resize observer and two wrapper elements; a list this short pays
 * for all of that and gets nothing back.
 */
export const VIRTUALIZE_ABOVE_ROWS = 60;

export type RowWindow = {
  /** Index of the first rendered row. */
  first: number;
  /** Exclusive end index, for `Array.prototype.slice`. */
  last: number;
  /** Pixels to translate the rendered block down by. */
  offset: number;
  /** Full scroll height, so the scrollbar tells the truth. */
  height: number;
};

export function rowWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  stride: number,
): RowWindow {
  const height = total * stride;

  // A stride of zero would divide to Infinity and a negative viewport is not a
  // thing; both mean "not measured yet", where rendering everything is correct
  // rather than merely safe — it is what the un-windowed list already does.
  if (!(stride > 0) || !(viewportHeight > 0) || total === 0) {
    return { first: 0, last: total, offset: 0, height };
  }

  // Clamped because a list that just shrank under a search leaves scrollTop
  // pointing past its own end, which would window in on nothing at all.
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, height - viewportHeight)));

  const first = Math.max(0, Math.floor(top / stride) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((top + viewportHeight) / stride) + OVERSCAN_ROWS);

  return { first, last, offset: first * stride, height };
}
