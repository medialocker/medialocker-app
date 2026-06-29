// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockSql } from '../../__tests__/helpers/mock-sql';

const {
  mock,
  infoSpy,
  warnSpy,
  errorSpy,
  s3SendSpy,
  rmSpy,
  readFileSpy,
  accessSpy,
  mkdirSpy,
  runFfmpegSpy,
  sharpDefaultSpy,
} = vi.hoisted(() => ({
  mock: {} as MockSql,
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  s3SendSpy: vi.fn(),
  rmSpy: vi.fn(),
  readFileSpy: vi.fn(),
  accessSpy: vi.fn(),
  mkdirSpy: vi.fn(),
  runFfmpegSpy: vi.fn(),
  sharpDefaultSpy: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const { createMockSql } = await import('../../__tests__/helpers/mock-sql');
  const m = createMockSql();
  Object.assign(mock, m);
  return { getDb: () => mock.sql };
});

vi.mock('../../logger', () => ({
  logger: {
    info: (...a: unknown[]) => infoSpy(...a),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
    debug: vi.fn(),
  },
}));

vi.mock('../../s3', () => ({
  getS3: () => ({ send: s3SendSpy }),
  refreshS3Client: vi.fn().mockResolvedValue(undefined),
  streamObjectToFile: vi.fn().mockResolvedValue(undefined),
  DERIVED_BUCKET: 'ml-derived',
}));

vi.mock('../../ffmpeg', () => ({
  runFfmpeg: (...a: unknown[]) => runFfmpegSpy(...a),
}));

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn(() => ({
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('sharp', () => ({ default: sharpDefaultSpy }));

vi.mock('node:fs/promises', () => ({
  rm: rmSpy,
  readFile: readFileSpy,
  access: accessSpy,
  mkdir: mkdirSpy,
}));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: (...a: string[]) => a.join('/') };
});
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }));

import { processSpriteJob, SpriteJobSchema, type SpriteJobData } from '../sprite';
import { makeJob } from '../../__tests__/helpers/mock-sql';

const sharpMethods = {
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  composite: vi.fn().mockReturnThis(),
  metadata: vi.fn<any>(),
  toBuffer: vi.fn<any>(),
};

beforeEach(() => {
  if (mock.reset) mock.reset();
  infoSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
  s3SendSpy.mockClear();
  rmSpy.mockClear();
  readFileSpy.mockClear();
  accessSpy.mockClear();
  mkdirSpy.mockClear();
  runFfmpegSpy.mockClear();
  sharpDefaultSpy.mockClear();

  sharpDefaultSpy.mockReturnValue(sharpMethods);
  sharpMethods.resize = vi.fn().mockReturnThis();
  sharpMethods.jpeg = vi.fn().mockReturnThis();
  sharpMethods.composite = vi.fn().mockReturnThis();
  sharpMethods.metadata = vi.fn().mockResolvedValue({ width: 160, height: 90 });
  sharpMethods.toBuffer = vi.fn().mockResolvedValue(Buffer.from('fake-sprite'));

  s3SendSpy.mockResolvedValue({ Body: { pipe: vi.fn() } });
  rmSpy.mockResolvedValue(undefined);
  readFileSpy.mockResolvedValue(Buffer.from([0xff, 0xd8]));
  mkdirSpy.mockResolvedValue(undefined);
  runFfmpegSpy.mockResolvedValue(undefined);

  let accessCount = 0;
  accessSpy.mockImplementation(async () => {
    accessCount++;
    if (accessCount <= 2) return undefined;
    throw new Error('ENOENT');
  });
});

const baseJobData: SpriteJobData = {
  objectId: 'obj-1',
  orgId: 'org-1',
  minioBucket: 'ml-org-1',
  key: 'uploads/video.mp4',
  durationMs: 30000,
  width: 1920,
  height: 1080,
};

describe('SpriteJobSchema', () => {
  it('accepts valid sprite job data', () => {
    const result = SpriteJobSchema.safeParse(baseJobData);
    expect(result.success).toBe(true);
  });

  it('accepts data with optional fields omitted', () => {
    const result = SpriteJobSchema.safeParse({
      objectId: 'obj-1',
      orgId: 'org-1',
      minioBucket: 'ml-org-1',
      key: 'uploads/video.mp4',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = SpriteJobSchema.safeParse({ objectId: 'obj-1' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string objectId', () => {
    const result = SpriteJobSchema.safeParse({ ...baseJobData, objectId: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric durationMs', () => {
    const result = SpriteJobSchema.safeParse({ ...baseJobData, durationMs: 'abc' });
    expect(result.success).toBe(false);
  });
});

describe('processSpriteJob', () => {
  it('downloads source, extracts frames via ffmpeg, composites sprite, and uploads', async () => {
    const fakeSprite = Buffer.from('sprite-data');
    const fakeFrame = Buffer.from('frame-data');
    sharpMethods.toBuffer
      .mockResolvedValueOnce(fakeFrame)   // frame 1
      .mockResolvedValueOnce(fakeFrame)   // frame 2
      .mockResolvedValue(fakeSprite);     // composite

    await processSpriteJob(makeJob(baseJobData) as any);

    expect(s3SendSpy).toHaveBeenCalledTimes(2);

    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/ml-sprite-test-uuid', { recursive: true });

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
    const ffmpegCall = runFfmpegSpy.mock.calls[0] as unknown[];
    expect(ffmpegCall[1]).toEqual({
      timeoutMs: 30 * 60 * 1000,
      logCtx: expect.objectContaining({ objectId: 'obj-1' }),
    });

    // Frames are now resized directly from their on-disk path (no readFile
    // buffering) — sharp is invoked with the frame file path. (P2.39)
    expect(sharpDefaultSpy).toHaveBeenCalledWith('/tmp/ml-sprite-test-uuid/frame-001.jpg');
    expect(sharpDefaultSpy).toHaveBeenCalledWith('/tmp/ml-sprite-test-uuid/frame-002.jpg');

    expect(sharpDefaultSpy).toHaveBeenCalledWith({ create: expect.objectContaining({ width: 320, height: 90 }) });

    const putCall = s3SendSpy.mock.calls[1] as any[];
    expect(putCall[0].input.Key).toBe('org-1/obj-1/sprite');
    expect(putCall[0].input.Bucket).toBe('ml-derived');
    expect(putCall[0].input.ContentType).toBe('image/jpeg');

    const derivativeInsert = mock.queries?.find((q: any) => q.text.includes('INSERT INTO derivatives'));
    expect(derivativeInsert).toBeDefined();
    expect(derivativeInsert!.text).toContain("'sprite'");
    expect(derivativeInsert!.params[0]).toBe('obj-1');
    expect(derivativeInsert!.params[1]).toBe('org-1/obj-1/sprite');
  });

  it('cleans up the full working directory on success', async () => {
    await processSpriteJob(makeJob(baseJobData) as any);

    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(rmSpy).toHaveBeenCalledWith('/tmp/ml-sprite-test-uuid', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up working directory when ffmpeg fails', async () => {
    runFfmpegSpy.mockRejectedValue(new Error('ffmpeg crashed'));

    await expect(processSpriteJob(makeJob(baseJobData) as any)).rejects.toThrow('ffmpeg crashed');
    expect(rmSpy).toHaveBeenCalledWith('/tmp/ml-sprite-test-uuid', {
      recursive: true,
      force: true,
    });
  });

  it('throws when ffmpeg produces no sprite frames', async () => {
    accessSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(processSpriteJob(makeJob(baseJobData) as any)).rejects.toThrow(
      'ffmpeg produced no sprite frames',
    );
    expect(rmSpy).toHaveBeenCalled();
  });

  it('uses computed fps based on durationMs', async () => {
    await processSpriteJob(makeJob(baseJobData) as any);

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to 10s duration when durationMs is omitted', async () => {
    const { durationMs: _, ...noDuration } = baseJobData;
    await processSpriteJob(makeJob(noDuration) as any);

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
  });
});
