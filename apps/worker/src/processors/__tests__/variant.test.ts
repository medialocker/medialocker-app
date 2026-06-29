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
  unlinkSpy,
  statSpy,
  runFfmpegSpy,
  reserveCapacitySpy,
  releaseCapacitySpy,
  autoAddCapacitySpy,
  sharpDefaultSpy,
} = vi.hoisted(() => ({
  mock: {} as MockSql,
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  s3SendSpy: vi.fn(),
  rmSpy: vi.fn(),
  readFileSpy: vi.fn(),
  unlinkSpy: vi.fn(),
  statSpy: vi.fn(),
  runFfmpegSpy: vi.fn(),
  reserveCapacitySpy: vi.fn(),
  releaseCapacitySpy: vi.fn(),
  autoAddCapacitySpy: vi.fn(),
  sharpDefaultSpy: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const { createMockSql } = await import('../../__tests__/helpers/mock-sql');
  const m = createMockSql();
  Object.assign(mock, m);
  (m.sql as Record<string, unknown>).begin = vi.fn(
    async (fn: (tx: unknown) => Promise<void>) => {
      await fn(m.sql);
    },
  );
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

vi.mock('@medialocker/core', () => ({
  reserveCapacity: (...a: unknown[]) => reserveCapacitySpy(...a),
  releaseCapacity: (...a: unknown[]) => releaseCapacitySpy(...a),
}));

vi.mock('@medialocker/billing', () => ({
  autoAddCapacity: (...a: unknown[]) => autoAddCapacitySpy(...a),
}));

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn(() => ({
    size: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    audioCodec: vi.fn().mockReturnThis(),
    audioBitrate: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('sharp', () => ({ default: sharpDefaultSpy }));

vi.mock('node:fs/promises', () => ({
  rm: rmSpy,
  readFile: readFileSpy,
  unlink: unlinkSpy,
  stat: statSpy,
}));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: (...a: string[]) => a.join('/') };
});
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({ pipe: vi.fn(), on: vi.fn() })),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn(function (this: Record<string, unknown>) {
    this.done = vi.fn().mockResolvedValue(undefined);
    return this;
  }),
}));

import { processVariantJob, VariantJobSchema, type VariantJobData } from '../variant';
import { makeJob } from '../../__tests__/helpers/mock-sql';

const sharpMethods = {
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  png: vi.fn().mockReturnThis(),
  webp: vi.fn().mockReturnThis(),
  avif: vi.fn().mockReturnThis(),
  metadata: vi.fn<any>(),
  toFile: vi.fn<any>(),
};

beforeEach(() => {
  if (mock.reset) mock.reset();
  (mock.sql as Record<string, unknown>).begin = vi.fn(
    async (fn: (tx: unknown) => Promise<void>) => {
      await fn(mock.sql);
    },
  );
  infoSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
  s3SendSpy.mockClear();
  rmSpy.mockClear();
  readFileSpy.mockClear();
  unlinkSpy.mockClear();
  statSpy.mockClear();
  runFfmpegSpy.mockClear();
  reserveCapacitySpy.mockClear();
  releaseCapacitySpy.mockClear();
  autoAddCapacitySpy.mockClear();
  sharpDefaultSpy.mockClear();

  sharpDefaultSpy.mockReturnValue(sharpMethods);
  sharpMethods.resize = vi.fn().mockReturnThis();
  sharpMethods.jpeg = vi.fn().mockReturnThis();
  sharpMethods.png = vi.fn().mockReturnThis();
  sharpMethods.webp = vi.fn().mockReturnThis();
  sharpMethods.avif = vi.fn().mockReturnThis();
  sharpMethods.metadata = vi.fn().mockResolvedValue({ width: 800, height: 600 });
  sharpMethods.toFile = vi.fn().mockResolvedValue(undefined);

  statSpy.mockResolvedValue({ size: 4096 });

  s3SendSpy.mockResolvedValue({ Body: { pipe: vi.fn() } });
  rmSpy.mockResolvedValue(undefined);
  readFileSpy.mockResolvedValue(Buffer.from([0xff, 0xd8]));
  unlinkSpy.mockResolvedValue(undefined);
  runFfmpegSpy.mockResolvedValue(undefined);
  reserveCapacitySpy.mockResolvedValue({ success: true });
  releaseCapacitySpy.mockResolvedValue(undefined);
  autoAddCapacitySpy.mockResolvedValue({ added: false });
});

const imageVariantData: VariantJobData = {
  objectId: 'obj-1',
  orgId: 'org-1',
  setItemId: 'set-item-1',
  minioBucket: 'ml-org-1',
  key: 'uploads/photo.jpg',
  kind: 'image',
  targetWidth: 800,
  targetHeight: 600,
  aspectRatio: '4:3',
  format: 'jpeg',
};

describe('VariantJobSchema', () => {
  it('accepts valid image variant job data', () => {
    const result = VariantJobSchema.safeParse(imageVariantData);
    expect(result.success).toBe(true);
  });

  it('accepts data with format omitted', () => {
    const { format: _, ...noFormat } = imageVariantData;
    const result = VariantJobSchema.safeParse(noFormat);
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = VariantJobSchema.safeParse({ objectId: 'obj-1' });
    expect(result.success).toBe(false);
  });

  it('rejects zero targetWidth', () => {
    const result = VariantJobSchema.safeParse({ ...imageVariantData, targetWidth: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric target dimensions', () => {
    const result = VariantJobSchema.safeParse({ ...imageVariantData, targetWidth: 'large' });
    expect(result.success).toBe(false);
  });
});

describe('processVariantJob', () => {
  it('processes an image variant: downloads, resizes with sharp, reserves capacity, uploads', async () => {
    const fakeVariant = Buffer.from('variant-data');
    sharpMethods.toFile.mockResolvedValue(undefined);

    await processVariantJob(makeJob(imageVariantData) as any);

    expect(reserveCapacitySpy).toHaveBeenCalledTimes(1);
    expect(reserveCapacitySpy.mock.calls[0]?.[1]).toBe('org-1');

    // GetObject is called once; the upload now uses Upload from @aws-sdk/lib-storage (not PutObjectCommand via s3.send)
    expect(s3SendSpy).toHaveBeenCalledTimes(1);
    expect(s3SendSpy.mock.calls[0]?.[0].input.Key).toBe('uploads/photo.jpg');

    const derivativeInsert = mock.queries?.find(
      (q: any) => q.text.includes('INSERT INTO derivatives'),
    );
    expect(derivativeInsert).toBeDefined();
    expect(derivativeInsert!.text).toContain("'variant'");

    const usageEvent = mock.queries?.find((q: any) => q.text.includes('INSERT INTO usage_events'));
    expect(usageEvent).toBeDefined();

    const setItemUpdate = mock.queries?.find((q: any) => q.text.includes('UPDATE set_items'));
    expect(setItemUpdate).toBeDefined();
    expect(setItemUpdate!.params[2]).toBe('4:3');
  });

  it('cleans up source temp file on success', async () => {
    await processVariantJob(makeJob(imageVariantData) as any);

    const cleanupCalls = rmSpy.mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(cleanupCalls.some((p) => p.includes('ml-var-src'))).toBe(true);
  });

  it('cleans up source temp file when processing fails', async () => {
    sharpMethods.toFile.mockRejectedValue(new Error('sharp error'));

    await expect(
      processVariantJob(makeJob(imageVariantData) as any),
    ).rejects.toThrow('sharp error');
    expect(rmSpy).toHaveBeenCalled();
  });

  it('throws when quota is exceeded and auto-add fails', async () => {
    reserveCapacitySpy.mockResolvedValue({ success: false });
    autoAddCapacitySpy.mockResolvedValue({ added: false });

    await expect(processVariantJob(makeJob(imageVariantData) as any)).rejects.toThrow(
      'InsufficientStorage',
    );
  });

  it('rolls back the orphaned derivative + reservation when upload fails on the final attempt (P2.34)', async () => {
    // Force the Upload to fail so the post-reservation upload throws. makeJob has
    // no retry opts, so attempts defaults to 1 → this IS the final attempt.
    const { Upload } = await import('@aws-sdk/lib-storage');
    (Upload as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
      this: Record<string, unknown>,
    ) {
      this.done = vi.fn().mockRejectedValue(new Error('minio upload failed'));
      return this;
    });
    // The rollback DELETE ... RETURNING must report the recorded billable bytes so
    // releaseCapacity is invoked.
    mock.onMatch((q) =>
      q.text.includes('DELETE FROM derivatives') && q.text.includes('RETURNING')
        ? [{ bytes: '4096', billable: true }]
        : undefined,
    );

    await expect(processVariantJob(makeJob(imageVariantData) as any)).rejects.toThrow(
      'minio upload failed',
    );

    // Orphaned derivative deleted + reservation released + compensating event.
    const del = mock.queries?.find((q: any) => q.text.includes('DELETE FROM derivatives'));
    expect(del).toBeDefined();
    expect(releaseCapacitySpy).toHaveBeenCalled();
    // Best-effort DeleteObject against the derived bucket to drop any partial object.
    const deleteObjectCall = s3SendSpy.mock.calls.find(
      (c: any[]) => c[0]?.input?.Key === 'org-1/obj-1/variant/4:3',
    );
    expect(deleteObjectCall).toBeDefined();
  });

  it('retries after auto-add capacity succeeds', async () => {
    reserveCapacitySpy
      .mockResolvedValueOnce({ success: false }) // first attempt fails
      .mockResolvedValueOnce({ success: true }); // retry succeeds
    autoAddCapacitySpy.mockResolvedValue({ added: true });

    await processVariantJob(makeJob(imageVariantData) as any);

    expect(autoAddCapacitySpy).toHaveBeenCalledTimes(1);
    expect(reserveCapacitySpy).toHaveBeenCalledTimes(2);
    expect(s3SendSpy).toHaveBeenCalledTimes(1); // GetObject only; upload uses Upload
  });
});
