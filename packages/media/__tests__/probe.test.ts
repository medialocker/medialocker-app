import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaKind } from '../src/types';

// --- mock sharp ---------------------------------------------------------
const sharpMetadata = vi.fn();
vi.mock('sharp', () => {
  return {
    default: (_buffer: Buffer) => ({
      metadata: sharpMetadata,
    }),
  };
});

// --- mock fluent-ffmpeg -------------------------------------------------
type FfprobeCb = (err: Error | null, data: unknown) => void;
const ffprobeImpl = vi.fn<(path: string, cb: FfprobeCb) => void>();
vi.mock('fluent-ffmpeg', () => {
  return {
    default: {
      ffprobe: (path: string, cb: FfprobeCb) => ffprobeImpl(path, cb),
    },
  };
});

// --- mock fs so temp file writes are no-ops -----------------------------
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// import AFTER mocks are registered
import { probeFile } from '../src/probe';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('probeFile — images', () => {
  it('maps sharp metadata into the media-asset shape', async () => {
    sharpMetadata.mockResolvedValue({
      width: 800,
      height: 600,
      format: 'jpeg',
      hasAlpha: false,
      orientation: 1,
      space: 'srgb',
      channels: 3,
      density: 72,
    });

    const result = await probeFile(Buffer.from('fake'), 'image/jpeg');

    expect(result.kind).toBe(MediaKind.Image);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.codec).toBe('jpeg');
    expect(result.duration_ms).toBeUndefined();
    expect(result.probe_json).toMatchObject({
      format: 'jpeg',
      hasAlpha: false,
      orientation: 1,
      space: 'srgb',
      channels: 3,
      density: 72,
    });
  });

  it('classifies by extension when content-type is generic', async () => {
    sharpMetadata.mockResolvedValue({ width: 10, height: 20, format: 'png' });
    const result = await probeFile(Buffer.from('fake'), 'application/octet-stream', 'png');
    expect(result.kind).toBe(MediaKind.Image);
    expect(result.width).toBe(10);
  });
});

describe('probeFile — video', () => {
  it('maps ffprobe video stream + format into the media-asset shape', async () => {
    ffprobeImpl.mockImplementation((_path, cb) => {
      cb(null, {
        format: { duration: 12.5, format_name: 'mov,mp4,m4a' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            r_frame_rate: '30000/1001',
            avg_frame_rate: '30000/1001',
          },
          {
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
          },
        ],
      });
    });

    const result = await probeFile(Buffer.from('fake'), 'video/mp4');

    expect(result.kind).toBe(MediaKind.Video);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.duration_ms).toBe(12500); // 12.5s -> ms
    expect(result.codec).toBe('h264'); // video stream wins
    expect(result.frame_rate).toBe(29.97); // 30000/1001 rounded to 2dp
    expect(result.has_audio).toBe(true);
    expect(result.probe_json).toBeDefined();
  });

  it('reports has_audio false when there is no audio stream', async () => {
    ffprobeImpl.mockImplementation((_path, cb) => {
      cb(null, {
        format: { duration: 5, format_name: 'matroska' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'vp9',
            width: 640,
            height: 480,
            r_frame_rate: '25/1',
          },
        ],
      });
    });

    const result = await probeFile(Buffer.from('fake'), 'video/webm');
    expect(result.has_audio).toBe(false);
    expect(result.frame_rate).toBe(25);
    expect(result.codec).toBe('vp9');
  });
});

describe('probeFile — audio', () => {
  it('maps an audio-only ffprobe result', async () => {
    ffprobeImpl.mockImplementation((_path, cb) => {
      cb(null, {
        format: { duration: 180.2, format_name: 'mp3' },
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'mp3',
            channels: 2,
            sample_rate: '44100',
          },
        ],
      });
    });

    const result = await probeFile(Buffer.from('fake'), 'audio/mpeg');

    expect(result.kind).toBe(MediaKind.Audio);
    expect(result.duration_ms).toBe(180200);
    expect(result.codec).toBe('mp3');
    expect(result.has_audio).toBe(true);
    // no video stream -> no width/height/frame_rate
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.frame_rate).toBeUndefined();
  });
});

describe('probeFile — unprobeable / error handling', () => {
  it('gracefully degrades when ffprobe errors but records the error', async () => {
    ffprobeImpl.mockImplementation((_path, cb) => {
      cb(new Error('ffprobe failed'), null);
    });

    const result = await probeFile(Buffer.from('fake'), 'video/mp4');
    expect(result.kind).toBe(MediaKind.Video);
    expect(result.width).toBeUndefined();
    expect(result.duration_ms).toBeUndefined();
    // The probe failure is recorded (not silently swallowed) for debugging.
    expect((result.probe_json as { probe_error?: string }).probe_error).toBe('ffprobe failed');
  });

  it('returns Other (no probing) for unknown content', async () => {
    const result = await probeFile(Buffer.from('fake'), 'application/x-unknown');
    expect(result.kind).toBe(MediaKind.Other);
    expect(result.width).toBeUndefined();
    expect(sharpMetadata).not.toHaveBeenCalled();
    expect(ffprobeImpl).not.toHaveBeenCalled();
  });

  it('omits duration_ms when ffprobe reports no duration', async () => {
    ffprobeImpl.mockImplementation((_path, cb) => {
      cb(null, {
        format: { format_name: 'mp4' },
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 2, height: 2, r_frame_rate: '0/0' }],
      });
    });
    const result = await probeFile(Buffer.from('fake'), 'video/mp4');
    expect(result.duration_ms).toBeUndefined();
    // 0/0 -> denominator 0 path -> falls through to parseFloat('0/0')=0
    expect(result.frame_rate).toBe(0);
  });
});

describe('probeFile — pdf', () => {
  it('counts pages from raw pdf content', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 /Type /Page x /Type /Page y');
    const result = await probeFile(pdfBytes, 'application/pdf');
    expect(result.kind).toBe(MediaKind.Pdf);
    expect(result.probe_json).toEqual({ pageCount: 2 });
  });

  it('reports undefined pageCount when no pages are found', async () => {
    const result = await probeFile(Buffer.from('not a real pdf'), 'application/pdf');
    expect(result.kind).toBe(MediaKind.Pdf);
    expect(result.probe_json).toEqual({ pageCount: undefined });
  });
});
