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

import { processThumbnailJob, ThumbnailJobSchema, type ThumbnailJobData } from '../thumbnail';
import { makeJob } from '../../__tests__/helpers/mock-sql';

const sharpMethods = {
  resize: vi.fn().mockReturnThis(),
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
  sharpMethods.resize = vi.fn().mockReturnThis();
  sharpMethods.jpeg = vi.fn().mockReturnThis();
  sharpMethods.metadata = vi.fn().mockResolvedValue({ width: 400, height: 300 });
  sharpMethods.toBuffer = vi.fn().mockResolvedValue(Buffer.from('fake-thumb'));

  s3SendSpy.mockResolvedValue({ Body: { pipe: vi.fn() } });
  rmSpy.mockResolvedValue(undefined);
  readFileSpy.mockResolvedValue(Buffer.from([0xff, 0xd8]));
  runFfmpegSpy.mockResolvedValue(undefined);
});

const thumbnailJobData: ThumbnailJobData = {
  objectId: 'obj-1',
  orgId: 'org-1',
  minioBucket: 'ml-org-1',
  key: 'uploads/photo.jpg',
  kind: 'image',
  width: 1920,
  height: 1080,
};

describe('ThumbnailJobSchema', () => {
  it('accepts valid image job data', () => {
    const result = ThumbnailJobSchema.safeParse(thumbnailJobData);
    expect(result.success).toBe(true);
  });

  it('accepts valid video job data with durationMs', () => {
    const result = ThumbnailJobSchema.safeParse({
      ...thumbnailJobData,
      kind: 'video',
      width: 3840,
      height: 2160,
      durationMs: 42000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid audio job data with optional fields omitted', () => {
    const result = ThumbnailJobSchema.safeParse({
      objectId: 'obj-2',
      orgId: 'org-2',
      minioBucket: 'ml-org-2',
      key: 'audio/song.mp3',
      kind: 'audio',
      width: undefined,
      height: undefined,
      durationMs: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = ThumbnailJobSchema.safeParse({ kind: 'image' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid kind type', () => {
    const result = ThumbnailJobSchema.safeParse({ ...thumbnailJobData, kind: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric width', () => {
    const result = ThumbnailJobSchema.safeParse({ ...thumbnailJobData, width: 'large' });
    expect(result.success).toBe(false);
  });
});

describe('processThumbnailJob', () => {
  it('generates an image thumbnail: downloads, resizes with sharp, uploads', async () => {
    const fakeThumb = Buffer.from('thumb-data');
    sharpMethods.metadata
      .mockResolvedValueOnce({ width: 1920, height: 1080 }) // source metadata
      .mockResolvedValueOnce({ width: 400, height: 225 });   // output metadata
    sharpMethods.toBuffer.mockResolvedValue(fakeThumb);

    await processThumbnailJob(makeJob(thumbnailJobData) as any);

    expect(s3SendSpy).toHaveBeenCalledTimes(2);

    expect(sharpDefaultSpy).toHaveBeenCalledWith('/tmp/ml-thumb-src-test-uuid');

    const putCall = s3SendSpy.mock.calls[1] as any[];
    expect(putCall[0].input.Key).toBe('org-1/obj-1/thumbnail');
    expect(putCall[0].input.ContentType).toBe('image/jpeg');

    const derivativeInsert = mock.queries?.find((q: any) => q.text.includes('INSERT INTO derivatives'));
    expect(derivativeInsert).toBeDefined();
    expect(derivativeInsert!.text).toContain("'thumbnail'");
  });

  it('generates a placeholder thumbnail for audio files', async () => {
    await processThumbnailJob(makeJob({ ...thumbnailJobData, kind: 'audio', width: undefined, height: undefined }) as any);

    expect(sharpDefaultSpy).toHaveBeenCalledWith({
      create: expect.objectContaining({
        width: 400,
        height: 400,
        background: { r: 30, g: 30, b: 40 },
      }),
    });

    const putCall = (s3SendSpy.mock.calls[0] as any[])[0];
    expect(putCall.input.Key).toBe('org-1/obj-1/thumbnail');
  });

  it('redirects non-image/video/audio to the generic (pdf/3d) placeholder path', async () => {
    await processThumbnailJob(makeJob({ ...thumbnailJobData, kind: 'pdf', width: undefined, height: undefined }) as any);

    expect(sharpDefaultSpy).toHaveBeenCalledWith({
      create: expect.objectContaining({
        width: 400,
        height: 400,
        background: { r: 60, g: 60, b: 70 },
      }),
    });
  });

  it('cleans up source temp file on success', async () => {
    await processThumbnailJob(makeJob(thumbnailJobData) as any);

    const cleanupCalls = rmSpy.mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(cleanupCalls.some((p) => p.includes('ml-thumb-src'))).toBe(true);
  });

  it('cleans up source temp file when sharp fails', async () => {
    sharpMethods.metadata.mockRejectedValue(new Error('corrupt image'));

    await expect(
      processThumbnailJob(makeJob(thumbnailJobData) as any),
    ).rejects.toThrow('corrupt image');
    expect(rmSpy).toHaveBeenCalled();
  });
});
