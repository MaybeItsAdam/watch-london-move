import { describe, expect, it } from 'vitest';
import { bucketFleet } from './layers';
import type { VehicleRow } from './types';

/**
 * `bucketFleet`'s array identity is load-bearing, not an optimisation detail.
 * deck.gl re-runs every accessor over every row whenever a layer's `data`
 * reference changes, so returning a fresh array per frame — as this used to —
 * silently disabled every `updateTrigger` in layers.ts. These tests pin the
 * contract: same membership, same array; changed membership, new array.
 */

let nextId = 0;
function row(type: string, overrides: Partial<VehicleRow> = {}): VehicleRow {
  nextId += 1;
  return {
    id: `v${nextId}`,
    type,
    line: '24',
    routeGroup: type === 'bus' ? 'bus' : type,
    position: [-0.12, 51.5, 0],
    heading: 0,
    ...overrides,
  } as VehicleRow;
}

const all = () => true;

describe('bucketFleet', () => {
  it('splits by model shape, with everything shapeless landing in rail', () => {
    const rows = [row('bus'), row('tram'), row('dlr'), row('elizabeth'), row('tube')];
    const fleet = bucketFleet(rows, all, null);
    expect(fleet.all).toHaveLength(5);
    expect(fleet.bus).toHaveLength(1);
    expect(fleet.tram).toHaveLength(1);
    expect(fleet.dlr).toHaveLength(1);
    expect(fleet.elizabeth).toHaveLength(1);
    // 'tube' has no model of its own.
    expect(fleet.rail).toHaveLength(1);
  });

  it('applies the include predicate', () => {
    const rows = [row('bus'), row('tram')];
    const fleet = bucketFleet(rows, (v) => v.type === 'bus', null);
    expect(fleet.all).toHaveLength(1);
    expect(fleet.tram).toHaveLength(0);
  });

  it('hands back the identical arrays when membership is unchanged', () => {
    const rows = [row('bus'), row('tram')];
    const first = bucketFleet(rows, all, null);
    const second = bucketFleet(rows, all, first);
    // The whole object, not merely equal contents.
    expect(second).toBe(first);
    expect(second.all).toBe(first.all);
    expect(second.bus).toBe(first.bus);
  });

  // The rows are mutated in place every frame; that must not read as a change.
  it('is unmoved by a row changing its pose', () => {
    const rows = [row('bus')];
    const first = bucketFleet(rows, all, null);
    rows[0].position[0] = -0.2;
    rows[0].heading = 180;
    expect(bucketFleet(rows, all, first)).toBe(first);
  });

  it('produces a new array for a bucket that gained a vehicle', () => {
    const rows = [row('bus')];
    const first = bucketFleet(rows, all, null);
    rows.push(row('bus'));
    const second = bucketFleet(rows, all, first);
    expect(second.bus).not.toBe(first.bus);
    expect(second.bus).toHaveLength(2);
  });

  it('produces a new array for a bucket that lost a vehicle', () => {
    const rows = [row('bus'), row('bus')];
    const first = bucketFleet(rows, all, null);
    rows.pop();
    const second = bucketFleet(rows, all, first);
    expect(second.bus).not.toBe(first.bus);
    expect(second.bus).toHaveLength(1);
  });

  // Same length, different vehicles — the case a length check alone would miss.
  it('detects a swap that leaves the count identical', () => {
    const rows = [row('bus')];
    const first = bucketFleet(rows, all, null);
    rows[0] = row('bus');
    const second = bucketFleet(rows, all, first);
    expect(second.bus).not.toBe(first.bus);
    expect(second.bus[0]).toBe(rows[0]);
  });

  it('leaves untouched buckets alone when only one changed', () => {
    const rows = [row('bus'), row('tram')];
    const first = bucketFleet(rows, all, null);
    rows.push(row('bus'));
    const second = bucketFleet(rows, all, first);
    expect(second.tram).toBe(first.tram);
    expect(second.bus).not.toBe(first.bus);
    // `all` gained one too, so the container itself must be new.
    expect(second).not.toBe(first);
  });

  it('reflects a filter change immediately', () => {
    const rows = [row('bus'), row('tram')];
    const first = bucketFleet(rows, all, null);
    const second = bucketFleet(rows, (v) => v.type !== 'tram', first);
    expect(second.tram).not.toBe(first.tram);
    expect(second.tram).toHaveLength(0);
    expect(second.all).toHaveLength(1);
  });

  it('handles an empty fleet without inventing a change', () => {
    const first = bucketFleet([], all, null);
    expect(first.all).toHaveLength(0);
    expect(bucketFleet([], all, first)).toBe(first);
  });
});
