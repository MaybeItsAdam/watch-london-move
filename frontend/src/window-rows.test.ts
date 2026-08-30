import { describe, expect, it } from 'vitest';
import { OVERSCAN_ROWS, rowWindow } from './window-rows';

const STRIDE = 30;
const VIEWPORT = 300; // ten rows visible

/**
 * The property that actually matters: every row the user can see is rendered.
 * Asserted directly rather than inferred from the indices, because the indices
 * are the thing under test.
 */
function coversViewport(total: number, scrollTop: number) {
  const { first, last } = rowWindow(total, scrollTop, VIEWPORT, STRIDE);
  const height = total * STRIDE;
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, height - VIEWPORT)));
  const firstVisible = Math.floor(top / STRIDE);
  const lastVisible = Math.min(total - 1, Math.floor((top + VIEWPORT - 1) / STRIDE));
  return first <= firstVisible && last >= lastVisible + 1;
}

describe('rowWindow', () => {
  it('reports the full scroll height so the scrollbar is honest', () => {
    expect(rowWindow(500, 0, VIEWPORT, STRIDE).height).toBe(500 * STRIDE);
  });

  it('starts at the top of the list, never above it', () => {
    const { first, offset } = rowWindow(500, 0, VIEWPORT, STRIDE);
    expect(first).toBe(0);
    expect(offset).toBe(0);
  });

  it('keeps the rendered block aligned with its own offset', () => {
    for (const scrollTop of [0, 15, 100, 431, 5000]) {
      const { first, offset } = rowWindow(500, scrollTop, VIEWPORT, STRIDE);
      expect(offset).toBe(first * STRIDE);
    }
  });

  it('covers the visible rows at every scroll position', () => {
    for (let scrollTop = 0; scrollTop <= 500 * STRIDE; scrollTop += 7) {
      expect(coversViewport(500, scrollTop)).toBe(true);
    }
  });

  it('renders overscan either side once away from the edges', () => {
    const { first, last } = rowWindow(500, 100 * STRIDE, VIEWPORT, STRIDE);
    expect(first).toBe(100 - OVERSCAN_ROWS);
    expect(last).toBe(100 + VIEWPORT / STRIDE + OVERSCAN_ROWS);
  });

  it('never runs past the end of the list', () => {
    for (const scrollTop of [0, 1000, 14700, 99999]) {
      const { last } = rowWindow(500, scrollTop, VIEWPORT, STRIDE);
      expect(last).toBeLessThanOrEqual(500);
    }
  });

  // The realistic failure: a search narrows the list while scrolled well down.
  it('recovers when scrollTop is past the end of a list that just shrank', () => {
    const { first, last } = rowWindow(12, 9000, VIEWPORT, STRIDE);
    expect(first).toBe(0);
    expect(last).toBe(12);
    expect(coversViewport(12, 9000)).toBe(true);
  });

  it('renders everything when the list is shorter than the viewport', () => {
    const { first, last, offset } = rowWindow(4, 0, VIEWPORT, STRIDE);
    expect(first).toBe(0);
    expect(last).toBe(4);
    expect(offset).toBe(0);
  });

  it('handles an empty list', () => {
    expect(rowWindow(0, 0, VIEWPORT, STRIDE)).toEqual({
      first: 0,
      last: 0,
      offset: 0,
      height: 0,
    });
  });

  // Before the ResizeObserver has reported, and before the stylesheet has been
  // read. Rendering everything is correct here, not merely safe.
  it.each([
    [0, VIEWPORT, 'unmeasured stride'],
    [STRIDE, 0, 'unmeasured viewport'],
    [Number.NaN, VIEWPORT, 'NaN stride'],
  ])('falls back to the whole list for %s/%s (%s)', (stride, viewport) => {
    const { first, last } = rowWindow(500, 0, viewport, stride);
    expect(first).toBe(0);
    expect(last).toBe(500);
  });

  it('works at the touch stride as well as the desktop one', () => {
    for (const stride of [30, 46]) {
      for (let scrollTop = 0; scrollTop < 300 * stride; scrollTop += 13) {
        const { first, last } = rowWindow(300, scrollTop, VIEWPORT, stride);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(last).toBeLessThanOrEqual(300);
        expect(last).toBeGreaterThan(first);
      }
    }
  });
});
