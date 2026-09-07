import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPosition } from './geolocate';

describe('currentPosition', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns coords from navigator.geolocation when available on web', async () => {
    const mockGetCurrentPosition = vi.fn((success) => {
      success({
        coords: {
          latitude: 51.5074,
          longitude: -0.1278,
          accuracy: 10,
        },
      });
    });

    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: mockGetCurrentPosition,
      },
    });

    const coords = await currentPosition();
    expect(coords).toEqual([-0.1278, 51.5074]);
    expect(mockGetCurrentPosition).toHaveBeenCalled();
  });

  it('returns null when navigator.geolocation errors', async () => {
    const mockGetCurrentPosition = vi.fn((_success, error) => {
      error(new Error('Permission denied'));
    });

    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: mockGetCurrentPosition,
      },
    });

    const coords = await currentPosition();
    expect(coords).toBeNull();
  });

  it('returns null when geolocation is not supported', async () => {
    vi.stubGlobal('navigator', {});

    const coords = await currentPosition();
    expect(coords).toBeNull();
  });
});
