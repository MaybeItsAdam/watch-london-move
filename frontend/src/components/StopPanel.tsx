import { memo, useEffect, useState } from 'react';
import { modeColorHex } from '../config';

export type SelectedStop = {
  id: string;
  name: string;
  coordinates: [number, number];
};

type StopArrival = {
  id: string;
  lineId: string;
  lineName: string;
  destinationName: string;
  timeToStation: number;
  platformName?: string;
  towards?: string;
};

type StopPanelProps = {
  stop: SelectedStop;
  onClose: () => void;
  onSelectLine?: (lineId: string) => void;
};

const REFRESH_INTERVAL_MS = 15_000;

function formatArrivalMinutes(seconds: number): string {
  if (seconds < 45) {
    return 'due';
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export const StopPanel = memo(function StopPanel({
  stop,
  onClose,
  onSelectLine,
}: StopPanelProps) {
  const [arrivals, setArrivals] = useState<StopArrival[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    const load = async () => {
      try {
        const res = await fetch(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(stop.id)}/Arrivals`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as StopArrival[];
        if (!cancelled) {
          // Sort soonest first
          data.sort((a, b) => a.timeToStation - b.timeToStation);
          setArrivals(data);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [stop.id]);

  return (
    <div className="stop-panel panel" role="region" aria-label={`Arrivals for ${stop.name}`}>
      <div className="stop-panel-header">
        <div className="stop-panel-title-wrap">
          <span className="stop-icon" aria-hidden="true">🚏</span>
          <h2 className="stop-panel-title">{stop.name}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close stop arrivals">
          ✕
        </button>
      </div>

      <div className="stop-panel-body">
        {loading && arrivals === null ? (
          <p className="stop-panel-status">Loading live arrivals…</p>
        ) : error ? (
          <p className="stop-panel-status">Live arrivals temporarily unavailable</p>
        ) : arrivals && arrivals.length === 0 ? (
          <p className="stop-panel-status">No arrivals reported in the next 30 minutes</p>
        ) : (
          <ul className="stop-arrivals-list">
            {arrivals?.slice(0, 8).map((arr) => {
              const color = modeColorHex(arr.lineId.toLowerCase()) || '#DC241F';
              return (
                <li
                  key={arr.id}
                  className="stop-arrival-row"
                  onClick={() => onSelectLine?.(arr.lineId.toLowerCase())}
                  role={onSelectLine ? 'button' : undefined}
                  tabIndex={onSelectLine ? 0 : undefined}
                >
                  <span className="stop-line-badge" style={{ backgroundColor: color }}>
                    {arr.lineName}
                  </span>
                  <div className="stop-dest-wrap">
                    <span className="stop-destination">{arr.destinationName || arr.towards || 'In Service'}</span>
                    {arr.platformName ? <span className="stop-platform">{arr.platformName}</span> : null}
                  </div>
                  <span className="stop-eta">{formatArrivalMinutes(arr.timeToStation)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});
