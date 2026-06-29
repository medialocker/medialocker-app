import type { MediaAsset } from './types';

export interface VariantTarget {
  aspectRatio: string;
  width: number;
  height: number;
  label: string;
}

export interface SetTarget {
  aspectRatio: string;
  width?: number;
  height?: number;
}

export interface AspectRatioDefinition {
  label: string;
  width: number;
  height: number;
}

export const STANDARD_ASPECT_RATIOS: Record<string, AspectRatioDefinition> = {
  '16:9': { label: '16:9', width: 16, height: 9 },
  '9:16': { label: '9:16', width: 9, height: 16 },
  '4:3': { label: '4:3', width: 4, height: 3 },
  '1:1': { label: '1:1', width: 1, height: 1 },
  '3:2': { label: '3:2', width: 3, height: 2 },
  '21:9': { label: '21:9', width: 21, height: 9 },
};

export function generateVariantTargets(
  baseAsset: MediaAsset,
  role: string,
): VariantTarget[] {
  if (!baseAsset.width || !baseAsset.height || baseAsset.width <= 0 || baseAsset.height <= 0) {
    return [];
  }

  const sourceRatio = baseAsset.width / baseAsset.height;
  const targets: VariantTarget[] = [];

  for (const [key, def] of Object.entries(STANDARD_ASPECT_RATIOS)) {
    const targetRatio = def.width / def.height;
    let targetWidth: number;
    let targetHeight: number;

    // Fit the target aspect ratio INSIDE the source — never upscale. For a target
    // wider than the source, the width is the limiting dimension; for a taller
    // target, the height is. Both resulting dimensions are therefore <= source.
    if (targetRatio >= sourceRatio) {
      targetWidth = baseAsset.width;
      targetHeight = Math.round(baseAsset.width / targetRatio);
    } else {
      targetHeight = baseAsset.height;
      targetWidth = Math.round(baseAsset.height * targetRatio);
    }

    // Encoders (e.g. h264) require even dimensions, so normalize both axes.
    if (targetWidth % 2 !== 0) targetWidth -= 1;
    if (targetHeight % 2 !== 0) targetHeight -= 1;

    if (targetWidth <= 0 || targetHeight <= 0) continue;

    targets.push({
      aspectRatio: key,
      width: targetWidth,
      height: targetHeight,
      label: def.label,
    });
  }

  return targets;
}

export function validateSetTargets(
  baseAsset: MediaAsset,
  targets: SetTarget[],
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!baseAsset.width || !baseAsset.height) {
    issues.push('Base asset has no dimensions — cannot compute variant targets');
    return { valid: false, issues };
  }

  if (targets.length === 0) {
    issues.push('No set targets provided');
    return { valid: false, issues };
  }

  const seenRatios = new Set<string>();

  for (const target of targets) {
    if (!STANDARD_ASPECT_RATIOS[target.aspectRatio]) {
      issues.push(`Unknown aspect ratio: "${target.aspectRatio}". Supported: ${Object.keys(STANDARD_ASPECT_RATIOS).join(', ')}`);
    }

    if (seenRatios.has(target.aspectRatio)) {
      issues.push(`Duplicate aspect ratio: "${target.aspectRatio}"`);
    }
    seenRatios.add(target.aspectRatio);

    if (target.width !== undefined && target.width <= 0) {
      issues.push(`Invalid width ${target.width} for target "${target.aspectRatio}"`);
    }
    if (target.height !== undefined && target.height <= 0) {
      issues.push(`Invalid height ${target.height} for target "${target.aspectRatio}"`);
    }
  }

  return { valid: issues.length === 0, issues };
}
