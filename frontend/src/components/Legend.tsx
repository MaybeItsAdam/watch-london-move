import { memo } from 'react';
import { FILTER_COLORS, FILTER_LABELS, FILTER_ORDER } from '../config';

type LegendProps = {
  onDismiss: () => void;
};

/**
 * What the map is showing, and how to work it.
 *
 * The app draws six modes in distinct colours, scatters bus livery by route,
 * swaps dots for 3D models past a zoom threshold and has two keyboard
 * shortcuts — and none of that was written down anywhere a user could reach.
 * The bus-red note in particular is here because the scatter is decorative:
 * without saying so it reads as data, as though a paler red meant something.
 *
 * Shown once and then dismissed for good (persisted in prefs), reachable again
 * from the map controls.
 */
export const Legend = memo(function Legend({ onDismiss }: LegendProps) {
  return (
    <aside className="legend panel" aria-label="Map legend">
      <div className="legend-head">
        <span className="legend-title">London, moving</span>
        <button className="icon-button" onClick={onDismiss} aria-label="Close legend">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 3l8 8M11 3l-8 8" />
            </g>
          </svg>
        </button>
      </div>

      <p className="legend-lede">
        Every bus, tube, tram, DLR and rail vehicle TfL is currently reporting, moving between
        the stops it is predicted to reach.
      </p>

      <ul className="legend-modes">
        {FILTER_ORDER.map((key) => (
          <li key={key}>
            <span className="legend-swatch" style={{ background: FILTER_COLORS[key] }} />
            {FILTER_LABELS[key]}
          </li>
        ))}
      </ul>

      <dl className="legend-notes">
        <dt>Zoom in</dt>
        <dd>Dots become models once a vehicle is big enough to be worth looking at.</dd>
        <dt>Bus reds vary</dt>
        <dd>Shade is scattered per route so neighbouring buses separate. It means nothing else.</dd>
        <dt>Tap a vehicle</dt>
        <dd>Its route, calling points and countdown; follow it, or show its route alone.</dd>
        <dt>Tap a stop</dt>
        <dd>Zoom to street level and tap any stop dot to see live arrivals and countdowns.</dd>
        <dt>Keyboard</dt>
        <dd>
          <kbd>/</kbd> search, <kbd>Z</kbd> clean view, <kbd>F</kbd> follow, <kbd>1</kbd>–<kbd>6</kbd> filter modes, <kbd>Esc</kbd> clear.
        </dd>
      </dl>
    </aside>
  );
});
