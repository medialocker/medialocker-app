import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockSql } from '../../__tests__/helpers/mock-sql';

const {
  mock,
  infoSpy,
  warnSpy,
  errorSpy,
  s3SendSpy,
  rmSpy,
  probeFileSpy,
  queueAddSpy,
  refreshSearchIndexSpy,
} = vi.hoisted(() => ({
  mock: {} as MockSql,
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  s3SendSpy: vi.fn(),
  rmSpy: vi.fn(),
  probeFileSpy: vi.fn(),
  queueAddSpy: vi.fn(),
  refreshSearchIndexSpy: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const { createMockSql } = await import('../../__tests__/helpers/mock-sql');
  const m = createMockSql();
  (m.sql as Record<string, unknown>).json = vi.fn((v: unknown) => v);
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

vi.mock('node:fs/promises', () => ({ rm: rmSpy }));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: (...a: string[]) => a.join('/') };
});
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('@medialocker/media', () => ({
  probeFile: (...a: unknown[]) => probeFileSpy(...a),
  MediaKind: { Image: 'image', Video: 'video', Audio: 'audio', PDF: 'pdf', '3D': '3d', Other: 'other' },
}));
vi.mock('../../queues', () => ({
  thumbnailQueue: { add: (...a: unknown[]) => queueAddSpy(...a) },
  posterQueue: { add: (...a: unknown[]) => queueAddSpy(...a) },
  spriteQueue: { add: (...a: unknown[]) => queueAddSpy(...a) },
}));
vi.mock('../../search-index', () => ({
  refreshSearchIndex: (...a: unknown[]) => refreshSearchIndexSpy(...a),
}));

import { processProbeJob, type ProbeJobData } from '../probe';
import { MediaKind } from '@medialocker/media';
import { makeJob } from '../../__tests__/helpers/mock-sql';

beforeEach(() => {
  if (mock.reset) mock.reset();
  infoSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
  s3SendSpy.mockClear();
  rmSpy.mockClear();
  probeFileSpy.mockClear();
  queueAddSpy.mockClear();
  refreshSearchIndexSpy.mockClear();
  s3SendSpy.mockResolvedValue({ Body: { pipe: vi.fn() } });
  rmSpy.mockResolvedValue(undefined);
  queueAddSpy.mockResolvedValue(undefined);
  refreshSearchIndexSpy.mockResolvedValue(undefined);
});

const baseJobData: ProbeJobData = {
  objectId: 'obj-1',
  orgId: 'org-1',
  bucketId: 'bkt-1',
  minioBucket: 'ml-org-1',
  key: 'uploads/photo.jpg',
  contentType: 'image/jpeg',
  size: 102400,
};

describe('processProbeJob', () => {
  it('streams the source to a temp file and probes it', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Image,
      width: 1920,
      height: 1080,
      duration_ms: null,
      codec: 'jpeg',
      frame_rate: null,
      has_audio: false,
      probe_json: { format: { format_name: 'image2' } },
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'abc123' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    expect(probeFileSpy).toHaveBeenCalledTimes(1);
    const call = probeFileSpy.mock.calls[0] as unknown[];
    expect(call[0]).toContain('ml-probe-src-test-uuid');
    expect(call[1]).toBe('image/jpeg');
    expect(call[2]).toBe('jpg');
  });

  it('cleans up the temp file after probe', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Image,
      width: 100,
      height: 100,
      duration_ms: null,
      codec: 'jpeg',
      frame_rate: null,
      has_audio: null,
      probe_json: {},
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'abc' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    expect(rmSpy).toHaveBeenCalled();
    const cleanupCall = rmSpy.mock.calls[0] as unknown[];
    expect(cleanupCall[0]).toContain('ml-probe-src-test-uuid');
  });

  it('cleans up temp file even when probeFile throws', async () => {
    probeFileSpy.mockRejectedValue(new Error('corrupt file'));
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'abc' }]);

    await expect(processProbeJob(makeJob(baseJobData) as any)).rejects.toThrow('corrupt file');
    expect(rmSpy).toHaveBeenCalled();
  });

  it('upserts media_assets and writes an audit_log entry', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Video,
      width: 3840,
      height: 2160,
      duration_ms: 42000,
      codec: 'h264',
      frame_rate: 29.97,
      has_audio: true,
      probe_json: { streams: [] },
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'def456' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    const mediaUpsert = mock.queries?.find((q) => q.text.includes('INSERT INTO media_assets'));
    expect(mediaUpsert).toBeDefined();
    expect(mediaUpsert!.params[0]).toBe('obj-1');
    expect(mediaUpsert!.params[1]).toBe('video');
    expect(mediaUpsert!.params[2]).toBe(3840);
    expect(mediaUpsert!.params[3]).toBe(2160);

    const auditInsert = mock.queries?.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.params).toContain('org-1');
    expect(auditInsert!.text).toContain("media:probe");
  });

  it('enqueues thumbnail for image media with eTag-based deduplication jobId', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Image,
      width: 800,
      height: 600,
      duration_ms: null,
      codec: null,
      frame_rate: null,
      has_audio: null,
      probe_json: {},
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'img-etag' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    const thumbCall = queueAddSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'media:thumbnail',
    ) as unknown[] | undefined;
    expect(thumbCall).toBeDefined();
    expect(thumbCall![2]).toHaveProperty('jobId');
    expect((thumbCall![2] as Record<string, unknown>).jobId).toContain('img-etag');
  });

  it('enqueues thumbnail, poster, and sprite for video media', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Video,
      width: 1920,
      height: 1080,
      duration_ms: 30000,
      codec: 'h264',
      frame_rate: 30,
      has_audio: true,
      probe_json: {},
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'vid-etag' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    const thumbCall = queueAddSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'media:thumbnail',
    );
    const posterCall = queueAddSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'media:poster',
    );
    const spriteCall = queueAddSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'media:sprite',
    );
    expect(thumbCall).toBeDefined();
    expect(posterCall).toBeDefined();
    expect(spriteCall).toBeDefined();
  });

  it('refreshes the full-text search index after probe', async () => {
    probeFileSpy.mockResolvedValue({
      kind: MediaKind.Image,
      width: 100,
      height: 100,
      duration_ms: null,
      codec: null,
      frame_rate: null,
      has_audio: null,
      probe_json: {},
    });
    mock.onQuery?.('SELECT etag FROM objects', [{ etag: 'abc' }]);

    await processProbeJob(makeJob(baseJobData) as any);

    expect(refreshSearchIndexSpy).toHaveBeenCalledTimes(1);
    expect(refreshSearchIndexSpy).toHaveBeenCalledWith(mock.sql, 'obj-1');
  });

  it('throws and cleans up temp file when S3 download fails', async () => {
    s3SendSpy.mockRejectedValue(new Error('S3 error'));

    await expect(processProbeJob(makeJob(baseJobData) as any)).rejects.toThrow('S3 error');
    expect(rmSpy).toHaveBeenCalled();
  });
});
