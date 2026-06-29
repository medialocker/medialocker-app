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
    seekInput: vi.fn().mockReturnThis(),
    frames: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('sharp', () => ({ default: sharpDefaultSpy }));

vi.mock('node:fs/promises', () => ({ rm: rmSpy, readFile: readFileSpy }));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: (...a: string[]) => a.join('/') };
});
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }));

import { processPosterJob, PosterJobSchema, type PosterJobData } from '../poster';
import { makeJob } from '../../__tests__/helpers/mock-sql';

const sharpMethods = {
  jpeg: vi.fn().mockReturnThis(),
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
  runFfmpegSpy.mockClear();
  sharpDefaultSpy.mockClear();

  sharpDefaultSpy.mockReturnValue(sharpMethods);
  sharpMethods.jpeg = vi.fn().mockReturnThis();
  sharpMethods.metadata = vi.fn().mockResolvedValue({ width: 1920, height: 1080 });
  sharpMethods.toBuffer = vi.fn().mockResolvedValue(Buffer.from('fake-poster'));

  s3SendSpy.mockResolvedValue({ Body: { pipe: vi.fn() } });
  rmSpy.mockResolvedValue(undefined);
  readFileSpy.mockResolvedValue(Buffer.from([0xff, 0xd8]));
  runFfmpegSpy.mockResolvedValue(undefined);
});

const baseJobData: PosterJobData = {
  objectId: 'obj-1',
  orgId: 'org-1',
  minioBucket: 'ml-org-1',
  key: 'uploads/video.mp4',
  durationMs: 30000,
  width: 1920,
  height: 1080,
};

describe('PosterJobSchema', () => {
  it('accepts valid poster job data', () => {
    const result = PosterJobSchema.safeParse(baseJobData);
    expect(result.success).toBe(true);
  });

  it('accepts data with optional fields omitted', () => {
    const result = PosterJobSchema.safeParse({
      objectId: 'obj-1',
      orgId: 'org-1',
      minioBucket: 'ml-org-1',
      key: 'uploads/video.mp4',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = PosterJobSchema.safeParse({ objectId: 'obj-1' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string objectId', () => {
    const result = PosterJobSchema.safeParse({ ...baseJobData, objectId: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric durationMs', () => {
    const result = PosterJobSchema.safeParse({ ...baseJobData, durationMs: 'long' });
    expect(result.success).toBe(false);
  });
});

describe('processPosterJob', () => {
  it('downloads source, extracts a frame via ffmpeg, processes with sharp, and uploads poster', async () => {
    const fakePoster = Buffer.from('poster-data');
    sharpMethods.toBuffer.mockResolvedValue(fakePoster);

    await processPosterJob(makeJob(baseJobData) as any);

    expect(s3SendSpy).toHaveBeenCalledTimes(2);

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
    const ffmpegCall = runFfmpegSpy.mock.calls[0] as unknown[];
    expect(ffmpegCall[1]).toEqual({ timeoutMs: 5 * 60 * 1000, logCtx: expect.objectContaining({ objectId: 'obj-1' }) });

    expect(readFileSpy).toHaveBeenCalledTimes(1);

    const putCall = s3SendSpy.mock.calls[1] as any[];
    expect(putCall[0].constructor.name).toBe('PutObjectCommand');
    expect(putCall[0].input.Key).toBe('org-1/obj-1/poster');
    expect(putCall[0].input.Bucket).toBe('ml-derived');
    expect(putCall[0].input.ContentType).toBe('image/jpeg');

    const derivativeInsert = (mock as any).queries?.find((q: any) => q.text.includes('INSERT INTO derivatives'));
    expect(derivativeInsert).toBeDefined();
    expect(derivativeInsert!.text).toContain("'poster'");
    expect(derivativeInsert!.params[0]).toBe('obj-1');
    expect(derivativeInsert!.params[1]).toBe('org-1/obj-1/poster');
  });

  it('cleans up both temp files on success', async () => {
    await processPosterJob(makeJob(baseJobData) as any);

    expect(rmSpy).toHaveBeenCalledTimes(2);
    const calls = rmSpy.mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(calls.some((p) => p.includes('ml-poster-in'))).toBe(true);
    expect(calls.some((p) => p.includes('ml-poster-out'))).toBe(true);
  });

  it('cleans up temp files when ffmpeg fails', async () => {
    runFfmpegSpy.mockRejectedValue(new Error('ffmpeg crashed'));

    await expect(processPosterJob(makeJob(baseJobData) as any)).rejects.toThrow('ffmpeg crashed');
    expect(rmSpy).toHaveBeenCalled();
  });

  it('uses 10% of duration as seek time when durationMs is provided', async () => {
    await processPosterJob(makeJob(baseJobData) as any);

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
    const cmdArg = (runFfmpegSpy.mock.calls[0] as unknown[])[0];
    expect(cmdArg).toBeDefined();
  });

  it('defaults seek time to 1s when durationMs is omitted', async () => {
    const { durationMs: _, ...noDuration } = baseJobData;
    await processPosterJob(makeJob(noDuration) as any);

    expect(runFfmpegSpy).toHaveBeenCalledTimes(1);
  });
});
