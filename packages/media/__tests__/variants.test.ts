import { describe, it, expect } from 'vitest';
import {
  generateVariantTargets,
  validateSetTargets,
  STANDARD_ASPECT_RATIOS,
} from '../src/variants';
import type { MediaAsset } from '../src/types';
import { MediaKind } from '../src/types';

function asset(width?: number, height?: number): MediaAsset {
  return { object_id: 'obj-1', kind: MediaKind.Image, width, height };
}

describe('generateVariantTargets', () => {
  it('returns one target per standard aspect ratio for a valid landscape source', () => {
    const targets = generateVariantTargets(asset(1920, 1080), 'master');
    expect(targets).toHaveLength(Object.keys(STANDARD_ASPECT_RATIOS).length);
    expect(targets.map((t) => t.aspectRatio).sort()).toEqual(
      Object.keys(STANDARD_ASPECT_RATIOS).sort(),
    );
  });

  it('computes correct dimensions for a 1920x1080 (16:9) landscape source', () => {
    const targets = generateVariantTargets(asset(1920, 1080), 'master');
    const byRatio = Object.fromEntries(targets.map((t) => [t.aspectRatio, t]));

    // sourceRatio = 1.7778. Fit-inside (no upscale): all dims <= 1920x1080.
    // 16:9 (>= source) -> width kept 1920, height = round(1920/1.7778) = 1080
    expect(byRatio['16:9']).toMatchObject({ width: 1920, height: 1080 });
    // 21:9 (>= source) -> width kept 1920, height = round(1920/2.3333) = 823 -> odd -> 822
    expect(byRatio['21:9']).toMatchObject({ width: 1920, height: 822 });
    // 9:16 (< source) -> height kept 1080, width = round(1080*0.5625) = 608
    expect(byRatio['9:16']).toMatchObject({ width: 608, height: 1080 });
    // 4:3 (< source) -> height kept 1080, width = round(1080*1.3333) = 1440
    expect(byRatio['4:3']).toMatchObject({ width: 1440, height: 1080 });
    // 1:1 (< source) -> height kept 1080, width = 1080
    expect(byRatio['1:1']).toMatchObject({ width: 1080, height: 1080 });
    // 3:2 (< source) -> height kept 1080, width = round(1080*1.5) = 1620
    expect(byRatio['3:2']).toMatchObject({ width: 1620, height: 1080 });
  });

  it('handles a square source', () => {
    const targets = generateVariantTargets(asset(1000, 1000), 'master');
    const byRatio = Object.fromEntries(targets.map((t) => [t.aspectRatio, t]));

    // sourceRatio = 1.0. Fit-inside: all dims <= 1000x1000.
    // 1:1 (>= 1.0) -> width kept 1000, height = 1000
    expect(byRatio['1:1']).toMatchObject({ width: 1000, height: 1000 });
    // 16:9 (>= 1.0) -> width kept 1000, height = round(1000/1.7778) = 563 -> odd -> 562
    expect(byRatio['16:9']).toMatchObject({ width: 1000, height: 562 });
    // 9:16 (< 1.0) -> height kept 1000, width = round(1000*0.5625) = 563 -> odd -> 562
    expect(byRatio['9:16']).toMatchObject({ width: 562, height: 1000 });
  });

  it('handles a portrait source', () => {
    const targets = generateVariantTargets(asset(1080, 1920), 'master');
    const byRatio = Object.fromEntries(targets.map((t) => [t.aspectRatio, t]));

    // sourceRatio = 0.5625. Fit-inside: all dims <= 1080x1920.
    // 9:16 (>= source) -> width kept 1080, height = round(1080/0.5625) = 1920
    expect(byRatio['9:16']).toMatchObject({ width: 1080, height: 1920 });
    // 16:9 (>= source) -> width kept 1080, height = round(1080/1.7778) = 608
    expect(byRatio['16:9']).toMatchObject({ width: 1080, height: 608 });
    // 1:1 (>= source) -> width kept 1080, height = 1080
    expect(byRatio['1:1']).toMatchObject({ width: 1080, height: 1080 });
  });

  it('always produces even width and height', () => {
    for (const dims of [[1920, 1080], [1080, 1920], [1001, 999], [1333, 777]] as const) {
      const targets = generateVariantTargets(asset(dims[0], dims[1]), 'master');
      for (const t of targets) {
        expect(t.width % 2, `${dims} ${t.aspectRatio} width`).toBe(0);
        expect(t.height % 2, `${dims} ${t.aspectRatio} height`).toBe(0);
      }
    }
  });

  it('returns an empty array when width is missing', () => {
    expect(generateVariantTargets(asset(undefined, 1080), 'master')).toEqual([]);
  });

  it('returns an empty array when height is missing', () => {
    expect(generateVariantTargets(asset(1920, undefined), 'master')).toEqual([]);
  });

  it('returns an empty array for zero dimensions', () => {
    expect(generateVariantTargets(asset(0, 0), 'master')).toEqual([]);
  });

  it('returns an empty array for negative dimensions', () => {
    expect(generateVariantTargets(asset(-10, -10), 'master')).toEqual([]);
  });

  it('carries through the label from the standard ratio definition', () => {
    const targets = generateVariantTargets(asset(1920, 1080), 'master');
    for (const t of targets) {
      expect(t.label).toBe(STANDARD_ASPECT_RATIOS[t.aspectRatio]!.label);
    }
  });
});

describe('validateSetTargets', () => {
  it('accepts a single valid target', () => {
    const result = validateSetTargets(asset(1920, 1080), [{ aspectRatio: '16:9' }]);
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('accepts multiple distinct valid targets', () => {
    const result = validateSetTargets(asset(1920, 1080), [
      { aspectRatio: '16:9' },
      { aspectRatio: '1:1' },
      { aspectRatio: '9:16', width: 1080, height: 1920 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('fails when the base asset has no dimensions', () => {
    const result = validateSetTargets(asset(undefined, undefined), [
      { aspectRatio: '16:9' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      'Base asset has no dimensions — cannot compute variant targets',
    ]);
  });

  it('fails when no targets are provided', () => {
    const result = validateSetTargets(asset(1920, 1080), []);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['No set targets provided']);
  });

  it('reports an unknown aspect ratio', () => {
    const result = validateSetTargets(asset(1920, 1080), [{ aspectRatio: '5:4' }]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('Unknown aspect ratio: "5:4"');
    expect(result.issues[0]).toContain('Supported:');
  });

  it('reports duplicate aspect ratios', () => {
    const result = validateSetTargets(asset(1920, 1080), [
      { aspectRatio: '16:9' },
      { aspectRatio: '16:9' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Duplicate aspect ratio: "16:9"');
  });

  it('reports invalid (non-positive) width and height overrides', () => {
    const result = validateSetTargets(asset(1920, 1080), [
      { aspectRatio: '16:9', width: 0, height: -5 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Invalid width 0 for target "16:9"');
    expect(result.issues).toContain('Invalid height -5 for target "16:9"');
  });

  it('accumulates multiple issues across targets', () => {
    const result = validateSetTargets(asset(1920, 1080), [
      { aspectRatio: 'bogus' },
      { aspectRatio: '1:1' },
      { aspectRatio: '1:1' },
    ]);
    expect(result.valid).toBe(false);
    // one unknown-ratio issue + one duplicate issue
    expect(result.issues).toHaveLength(2);
  });
});
