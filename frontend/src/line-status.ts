export type LineStatusLevel = 'good' | 'minor' | 'severe';

export type LineStatusInfo = {
  level: LineStatusLevel;
  description: string;
  reason?: string;
};

const STATUS_CACHE_MS = 60_000;
let cachedStatuses: Map<string, LineStatusInfo> | null = null;
let lastFetchTime = 0;
let inflightFetch: Promise<Map<string, LineStatusInfo>> | null = null;

export async function fetchLineStatuses(): Promise<Map<string, LineStatusInfo>> {
  const now = Date.now();
  if (cachedStatuses && now - lastFetchTime < STATUS_CACHE_MS) {
    return cachedStatuses;
  }
  if (inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = (async () => {
    try {
      const response = await fetch(
        'https://api.tfl.gov.uk/Line/Mode/tube,overground,dlr,elizabeth-line,tram/Status',
      );
      if (!response.ok) {
        return cachedStatuses ?? new Map();
      }
      const data = (await response.json()) as Array<{
        id: string;
        lineStatuses?: Array<{
          statusSeverity: number;
          statusSeverityDescription: string;
          reason?: string;
        }>;
      }>;

      const map = new Map<string, LineStatusInfo>();
      for (const line of data) {
        const first = line.lineStatuses?.[0];
        if (!first) {
          continue;
        }
        const severity = first.statusSeverity;
        const level: LineStatusLevel =
          severity === 10 ? 'good' : severity === 9 ? 'minor' : 'severe';
        const info: LineStatusInfo = {
          level,
          description: first.statusSeverityDescription,
          reason: first.reason,
        };
        map.set(line.id.toLowerCase(), info);
        // Alias london-overground <-> overground
        if (line.id === 'london-overground') {
          map.set('overground', info);
        }
      }
      cachedStatuses = map;
      lastFetchTime = Date.now();
      return map;
    } catch {
      return cachedStatuses ?? new Map();
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}
