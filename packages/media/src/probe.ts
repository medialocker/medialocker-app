import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaKind } from './types';

export interface MediaProbeResult {
  kind: MediaKind;
  width?: number;
  height?: number;
  duration_ms?: number;
  codec?: string;
  frame_rate?: number;
  has_audio?: boolean;
  probe_json?: Record<string, unknown>;
}

const IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/bmp',
  'image/svg+xml',
];

const VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/ogg',
  'video/x-flv',
  'video/MP2T',
];

const AUDIO_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/aac',
  'audio/flac',
  'audio/webm',
  'audio/x-ms-wma',
  'audio/mp4',
];

const PDF_CONTENT_TYPES = ['application/pdf'];

const MODEL3D_CONTENT_TYPES = [
  'model/gltf+json',
  'model/gltf-binary',
  'model/vnd.usdz+zip',
];

const EXTENSION_KIND_MAP: Record<string, MediaKind> = {
  jpg: MediaKind.Image,
  jpeg: MediaKind.Image,
  png: MediaKind.Image,
  gif: MediaKind.Image,
  webp: MediaKind.Image,
  avif: MediaKind.Image,
  tiff: MediaKind.Image,
  tif: MediaKind.Image,
  bmp: MediaKind.Image,
  svg: MediaKind.Image,
  mp4: MediaKind.Video,
  mov: MediaKind.Video,
  avi: MediaKind.Video,
  mkv: MediaKind.Video,
  webm: MediaKind.Video,
  ogv: MediaKind.Video,
  flv: MediaKind.Video,
  ts: MediaKind.Video,
  m4v: MediaKind.Video,
  mp3: MediaKind.Audio,
  ogg: MediaKind.Audio,
  oga: MediaKind.Audio,
  wav: MediaKind.Audio,
  aac: MediaKind.Audio,
  flac: MediaKind.Audio,
  wma: MediaKind.Audio,
  m4a: MediaKind.Audio,
  pdf: MediaKind.Pdf,
  gltf: MediaKind.Model3d,
  glb: MediaKind.Model3d,
  usdz: MediaKind.Model3d,
};

export function getContentType(kind: MediaKind): string[] {
  switch (kind) {
    case MediaKind.Image:
      return [...IMAGE_CONTENT_TYPES];
    case MediaKind.Video:
      return [...VIDEO_CONTENT_TYPES];
    case MediaKind.Audio:
      return [...AUDIO_CONTENT_TYPES];
    case MediaKind.Pdf:
      return [...PDF_CONTENT_TYPES];
    case MediaKind.Model3d:
      return [...MODEL3D_CONTENT_TYPES];
    default:
      return [];
  }
}

export function classifyMedia(contentType: string, extension?: string): MediaKind {
  if (IMAGE_CONTENT_TYPES.includes(contentType)) return MediaKind.Image;
  if (VIDEO_CONTENT_TYPES.includes(contentType)) return MediaKind.Video;
  if (AUDIO_CONTENT_TYPES.includes(contentType)) return MediaKind.Audio;
  if (PDF_CONTENT_TYPES.includes(contentType)) return MediaKind.Pdf;
  if (contentType === 'model/gltf+json' || contentType === 'model/gltf-binary') {
    return MediaKind.Model3d;
  }
  if (extension === 'glb') return MediaKind.Model3d;
  if (extension === 'usdz') return MediaKind.Model3d;

  if (extension) {
    const ext = extension.toLowerCase().replace(/^\./, '');
    const kind = EXTENSION_KIND_MAP[ext];
    if (kind) return kind;
  }

  return MediaKind.Other;
}

async function probeImage(input: Buffer | string): Promise<Partial<MediaProbeResult>> {
  // sharp accepts a Buffer OR a file path, so a streamed-to-disk source works
  // without loading it into memory.
  const metadata = await sharp(input).metadata();
  return {
    kind: MediaKind.Image,
    width: metadata.width,
    height: metadata.height,
    codec: metadata.format,
    probe_json: {
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
      orientation: metadata.orientation,
      space: metadata.space,
      channels: metadata.channels,
      density: metadata.density,
    },
  };
}

async function probeVideoAudio(
  input: Buffer | string,
  kind: MediaKind,
): Promise<Partial<MediaProbeResult>> {
  // ffprobe always reads from a file. If we were handed a path (streamed source),
  // probe it in place; otherwise spill the buffer to a temp file we own.
  let tmpPath: string;
  let ownTemp = false;
  if (typeof input === 'string') {
    tmpPath = input;
  } else {
    tmpPath = join(tmpdir(), `ml-probe-${randomUUID()}`);
    await writeFile(tmpPath, input);
    ownTemp = true;
  }

  try {
    return await new Promise((resolve) => {
      ffmpeg.ffprobe(tmpPath, (err, data) => {
        if (err) {
          // Degrade gracefully (don't fail the whole job for an unprobeable file)
          // but RECORD the failure in probe_json rather than swallowing it, so it
          // is visible for debugging instead of looking like a clean probe.
          resolve({ kind, probe_json: { probe_error: err.message } });
          return;
        }

        const videoStream = data.streams.find((s) => s.codec_type === 'video');
        const audioStream = data.streams.find((s) => s.codec_type === 'audio');

        const result: Partial<MediaProbeResult> = {
          kind,
          duration_ms: data.format.duration
            ? Math.round(data.format.duration * 1000)
            : undefined,
          codec: videoStream?.codec_name || audioStream?.codec_name || data.format.format_name,
          probe_json: {
            format: data.format,
            streams: data.streams.map((s) => ({
              codec_type: s.codec_type,
              codec_name: s.codec_name,
              width: s.width,
              height: s.height,
              r_frame_rate: s.r_frame_rate,
              avg_frame_rate: s.avg_frame_rate,
              channels: s.channels,
              sample_rate: s.sample_rate,
            })),
          },
        };

        if (videoStream) {
          result.width = videoStream.width;
          result.height = videoStream.height;
          result.frame_rate = parseFrameRate(
            videoStream.r_frame_rate || videoStream.avg_frame_rate,
          );
          result.has_audio = !!audioStream;
        }

        if (audioStream && !videoStream) {
          result.has_audio = true;
        }

        resolve(result);
      });
    });
  } finally {
    if (ownTemp) await unlink(tmpPath).catch(() => {});
  }
}

function parseFrameRate(rateStr?: string): number | undefined {
  if (!rateStr) return undefined;
  const parts = rateStr.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den !== 0 && !isNaN(num) && !isNaN(den)) {
      return Math.round((num / den) * 100) / 100;
    }
  }
  const num = parseFloat(rateStr);
  return isNaN(num) ? undefined : Math.round(num * 100) / 100;
}

async function probePdf(buffer: Buffer): Promise<Partial<MediaProbeResult>> {
  const content = buffer.toString('latin1');
  const pageMatches = content.match(/\/Type\s*\/Page[^s]/gi);
  const pageCount = pageMatches ? pageMatches.length : 0;

  return {
    kind: MediaKind.Pdf,
    probe_json: { pageCount: pageCount || undefined },
  };
}

export async function probeFile(
  input: Buffer | string,
  contentType: string,
  extension?: string,
): Promise<MediaProbeResult> {
  const kind = classifyMedia(contentType, extension);

  let result: Partial<MediaProbeResult>;

  switch (kind) {
    case MediaKind.Image:
      result = await probeImage(input);
      break;
    case MediaKind.Video:
    case MediaKind.Audio:
      result = await probeVideoAudio(input, kind);
      break;
    case MediaKind.Pdf:
      // probePdf inspects header bytes; read the file if we got a path.
      result = await probePdf(typeof input === 'string' ? await readFile(input) : input);
      break;
    default:
      result = { kind: MediaKind.Other };
      break;
  }

  return {
    kind: result.kind || kind,
    width: result.width,
    height: result.height,
    duration_ms: result.duration_ms,
    codec: result.codec,
    frame_rate: result.frame_rate,
    has_audio: result.has_audio,
    probe_json: result.probe_json,
  };
}
