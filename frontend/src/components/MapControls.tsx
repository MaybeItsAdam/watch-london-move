import { memo } from 'react';

type MapControlsProps = {
  onLocate: () => void;
  locating: boolean;
  onShare: () => void;
  /** Briefly true after a copy-to-clipboard fallback, to confirm it happened. */
  shareCopied: boolean;
  onShowLegend: () => void;
  bearing: number;
  onResetNorth: () => void;
  zenMode: boolean;
  onToggleZen: () => void;
};

/* Drawn rather than set as characters, for the same reason MenuIcon is in
   Sidebar.tsx: the obvious glyphs are not in the iOS system font and render as
   tofu boxes there. */
function LocateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="1.6" fill="none">
        <circle cx="8" cy="8" r="3.2" />
        <path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function CompassIcon({ bearing }: { bearing: number }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      style={{ transform: `rotate(${-bearing}deg)`, transition: 'transform 0.15s ease-out' }}
    >
      <g strokeWidth="1.2">
        <polygon points="8,2 11.5,8 8,6.5" fill="#e53e3e" stroke="#e53e3e" />
        <polygon points="8,2 4.5,8 8,6.5" fill="#fc8181" stroke="#fc8181" />
        <polygon points="8,14 11.5,8 8,9.5" fill="#a0aec0" stroke="#a0aec0" />
        <polygon points="8,14 4.5,8 8,9.5" fill="#cbd5e0" stroke="#cbd5e0" />
      </g>
    </svg>
  );
}

function ZenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
        <circle cx="8" cy="8" r="2" />
      </g>
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M8 10.5V2m0 0L5.2 4.8M8 2l2.8 2.8" />
        <path d="M3.5 8.6v4.2a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.6" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M6.3 6.2a1.8 1.8 0 1 1 2.2 2.2v1" />
      </g>
      <circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
    </svg>
  );
}

/**
 * The three things a live city map is expected to offer and this one did not:
 * take me to where I am, give me a link to what I am looking at, and tell me
 * what the colours mean.
 */
export const MapControls = memo(function MapControls({
  onLocate,
  locating,
  onShare,
  shareCopied,
  onShowLegend,
  bearing,
  onResetNorth,
  zenMode,
  onToggleZen,
}: MapControlsProps) {
  return (
    <div className="map-controls">
      <button
        className="map-control panel"
        onClick={onResetNorth}
        aria-label="Reset bearing to North and reset pitch"
        title="Reset bearing to North"
      >
        <CompassIcon bearing={bearing} />
      </button>
      <button
        className={`map-control panel${zenMode ? ' active' : ''}`}
        onClick={onToggleZen}
        aria-label="Toggle clean view mode (Z)"
        title="Toggle clean view (Z)"
      >
        <ZenIcon />
      </button>
      <button
        className={`map-control panel${locating ? ' busy' : ''}`}
        onClick={onLocate}
        aria-label="Centre the map on my location"
      >
        <LocateIcon />
      </button>
      <button
        className="map-control panel"
        onClick={onShare}
        aria-label="Share a link to this view"
      >
        <ShareIcon />
      </button>
      <button className="map-control panel" onClick={onShowLegend} aria-label="What am I looking at?">
        <HelpIcon />
      </button>
      {/* Only rendered after a copy, and announced, because the clipboard
          fallback is otherwise completely silent. */}
      {shareCopied ? (
        <span className="share-toast panel" role="status">
          Link copied
        </span>
      ) : null}
    </div>
  );
});
