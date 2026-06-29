// Real-binary probe tests (P2.38).
//
// Exercises the ACTUAL `probeFile` against real sharp / ffprobe binaries on a
// runtime-generated fixture — no mocks (this file deliberately does NOT mock
// sharp or fluent-ffmpeg, unlike probe.test.ts). GUARDED with `it.skipIf` so a CI
// box without the native sharp build or without ffmpeg/ffprobe on PATH stays
// green (a skipped test counts as a pass).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeFile } from '../src/probe';
import { MediaKind } from '../src/types';

// sharp's native binary may be absent on some platforms. sharp is published with
// `export =`, so the module namespace is the callable factory (interop default is
// the same function at runtime).
type Sharp = typeof import('sharp');
let sharp: Sharp | undefined;
try {
  const mod = (await import('sharp')) as unknown as { default?: Sharp } & Sharp;
  sharp = mod.default ?? mod;
} catch {
  sharp = undefined;
}
const hasSharp = sharp !== undefined;

function binaryExists(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasFfmpeg = binaryExists('ffmpeg');
const hasFfprobe = binaryExists('ffprobe');

describe('probeFile with real sharp', () => {
  it.skipIf(!hasSharp)('probes a generated PNG and reports real dimensions', async () => {
    const png = await sharp!({
      create: { width: 48, height: 24, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();

    const result = await probeFile(png, 'image/png', 'png');
    expect(result.kind).toBe(MediaKind.Image);
    expect(result.width).toBe(48);
    expect(result.height).toBe(24);
    expect(result.codec).toBe('png');
  });
});

describe('probeFile with real ffprobe', () => {
  it.skipIf(!hasFfmpeg || !hasFfprobe)(
    'probes a generated MP4 and reports a real duration',
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'ml-media-real-'));
      const videoPath = join(workDir, 'clip.mp4');
      try {
        execFileSync(
          'ffmpeg',
          [
            '-y',
            '-f', 'lavfi',
            '-i', 'testsrc=duration=1:size=32x32:rate=10',
            '-pix_fmt', 'yuv420p',
            videoPath,
          ],
          { stdio: 'ignore' },
        );

        const result = await probeFile(videoPath, 'video/mp4', 'mp4');
        expect(result.kind).toBe(MediaKind.Video);
        // ~1s clip; allow generous tolerance for container rounding.
        expect(result.duration_ms ?? 0).toBeGreaterThan(500);
        expect(result.probe_json).toBeDefined();
        // A successful probe records format/streams, NOT a probe_error.
        expect((result.probe_json as Record<string, unknown>).probe_error).toBeUndefined();
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
