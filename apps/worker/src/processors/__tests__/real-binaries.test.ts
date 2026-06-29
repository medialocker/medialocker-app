// Real-binary processor tests (P2.38).
//
// These exercise the ACTUAL sharp and ffmpeg/ffprobe binaries against a tiny
// fixture generated at runtime — no mocks. They are GUARDED with `it.skipIf` so a
// CI environment WITHOUT the binaries (sharp's native build absent, or ffmpeg not
// installed) stays green: a skipped test counts as a pass. When the binaries ARE
// present they verify the real image-resize path (mirrors thumbnail/variant sharp
// usage) and the real ffmpeg single-frame extraction path (mirrors poster/
// thumbnail/sprite ffmpeg usage) end-to-end on disk.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runFfmpeg } from '../../ffmpeg';

// sharp may fail to load on platforms without its prebuilt native binary.
// sharp is published with `export =`, so the module namespace IS the callable
// factory (interop default is the same function at runtime).
type Sharp = typeof import('sharp');
let sharp: Sharp | undefined;
try {
  const mod = (await import('sharp')) as unknown as { default?: Sharp } & Sharp;
  sharp = mod.default ?? mod;
} catch {
  sharp = undefined;
}
const hasSharp = sharp !== undefined;

// fluent-ffmpeg shells out to `ffmpeg`/`ffprobe`; detect them on PATH.
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

describe('real sharp image processing (thumbnail/variant path)', () => {
  it.skipIf(!hasSharp)(
    'resizes a generated PNG with the real sharp binary, bounding dimensions',
    async () => {
      const s = sharp!;
      // Generate a tiny solid 64x48 PNG entirely in-memory — no external fixture.
      const srcPng = await s({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: 10, g: 120, b: 200 },
        },
      })
        .png()
        .toBuffer();

      // Resize like the thumbnail processor (fit: inside, no enlargement) and
      // re-encode to JPEG, then verify the real output is a smaller valid image.
      const out = await s(srcPng)
        .resize(32, 32, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const meta = await s(out).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeLessThanOrEqual(32);
      expect(meta.height).toBeLessThanOrEqual(32);
      // Aspect ratio (64:48 = 4:3) is preserved under fit:inside.
      expect(meta.width).toBe(32);
      expect(meta.height).toBe(24);
      expect(out.length).toBeGreaterThan(0);
    },
  );
});

describe('real ffmpeg processing (poster/thumbnail/sprite path)', () => {
  it.skipIf(!hasFfmpeg || !hasFfprobe)(
    'generates a tiny test video and extracts a single frame via runFfmpeg',
    async () => {
      const ffmpegMod = (await import('fluent-ffmpeg')).default;
      const workDir = await mkdtemp(join(tmpdir(), 'ml-real-ffmpeg-'));
      const videoPath = join(workDir, 'test.mp4');
      const framePath = join(workDir, 'frame.jpg');

      try {
        // Synthesize a 1-second 32x32 test-pattern video using ffmpeg's lavfi
        // virtual input — no binary fixture committed to the repo.
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
        const vstat = await stat(videoPath);
        expect(vstat.size).toBeGreaterThan(0);

        // Extract a single poster frame through the SAME runFfmpeg used by the
        // poster/thumbnail processors (timeout + sandbox opts applied).
        await runFfmpeg(
          ffmpegMod(videoPath)
            .seekInput(0.1)
            .frames(1)
            .outputOptions(['-q:v', '2'])
            .output(framePath),
          { timeoutMs: 60_000, logCtx: { test: 'real-ffmpeg' } },
        );

        const frame = await readFile(framePath);
        expect(frame.length).toBeGreaterThan(0);
        // JPEG SOI marker confirms a real frame was written.
        expect(frame[0]).toBe(0xff);
        expect(frame[1]).toBe(0xd8);

        // If sharp is also present, confirm the extracted frame is a valid image.
        if (hasSharp) {
          const meta = await sharp!(frame).metadata();
          expect(meta.format).toBe('jpeg');
          expect(meta.width).toBeGreaterThan(0);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
