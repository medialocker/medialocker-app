import { describe, it, expect } from 'vitest';
import { classifyMedia, getContentType } from '../src/probe';
import { MediaKind } from '../src/types';

describe('classifyMedia', () => {
  describe('by content-type', () => {
    it.each([
      ['image/jpeg', MediaKind.Image],
      ['image/png', MediaKind.Image],
      ['image/webp', MediaKind.Image],
      ['image/svg+xml', MediaKind.Image],
      ['video/mp4', MediaKind.Video],
      ['video/quicktime', MediaKind.Video],
      ['video/webm', MediaKind.Video],
      ['audio/mpeg', MediaKind.Audio],
      ['audio/wav', MediaKind.Audio],
      ['audio/flac', MediaKind.Audio],
      ['application/pdf', MediaKind.Pdf],
      ['model/gltf+json', MediaKind.Model3d],
      ['model/gltf-binary', MediaKind.Model3d],
    ])('classifies %s as %s', (contentType, expected) => {
      expect(classifyMedia(contentType)).toBe(expected);
    });

    it('prefers content-type over extension', () => {
      // content-type says image even though extension says video
      expect(classifyMedia('image/png', 'mp4')).toBe(MediaKind.Image);
    });
  });

  describe('by extension fallback', () => {
    it.each([
      ['jpg', MediaKind.Image],
      ['jpeg', MediaKind.Image],
      ['png', MediaKind.Image],
      ['gif', MediaKind.Image],
      ['webp', MediaKind.Image],
      ['avif', MediaKind.Image],
      ['tiff', MediaKind.Image],
      ['tif', MediaKind.Image],
      ['bmp', MediaKind.Image],
      ['svg', MediaKind.Image],
      ['mp4', MediaKind.Video],
      ['mov', MediaKind.Video],
      ['avi', MediaKind.Video],
      ['mkv', MediaKind.Video],
      ['webm', MediaKind.Video],
      ['ogv', MediaKind.Video],
      ['flv', MediaKind.Video],
      ['ts', MediaKind.Video],
      ['m4v', MediaKind.Video],
      ['mp3', MediaKind.Audio],
      ['ogg', MediaKind.Audio],
      ['oga', MediaKind.Audio],
      ['wav', MediaKind.Audio],
      ['aac', MediaKind.Audio],
      ['flac', MediaKind.Audio],
      ['wma', MediaKind.Audio],
      ['m4a', MediaKind.Audio],
      ['pdf', MediaKind.Pdf],
      ['gltf', MediaKind.Model3d],
      ['glb', MediaKind.Model3d],
      ['usdz', MediaKind.Model3d],
    ])('classifies extension .%s as %s when content-type is unknown', (ext, expected) => {
      expect(classifyMedia('application/octet-stream', ext)).toBe(expected);
    });

    it('normalizes uppercase extensions', () => {
      expect(classifyMedia('application/octet-stream', 'JPG')).toBe(MediaKind.Image);
    });

    it('strips a leading dot from the extension', () => {
      expect(classifyMedia('application/octet-stream', '.png')).toBe(MediaKind.Image);
    });

    it('classifies glb via the dedicated short-circuit', () => {
      // glb/usdz are handled before the extension map; verify they resolve
      expect(classifyMedia('application/octet-stream', 'glb')).toBe(MediaKind.Model3d);
      expect(classifyMedia('application/octet-stream', 'usdz')).toBe(MediaKind.Model3d);
    });
  });

  describe('unknown inputs', () => {
    it('returns Other for an unknown content-type with no extension', () => {
      expect(classifyMedia('application/octet-stream')).toBe(MediaKind.Other);
    });

    it('returns Other for an unknown content-type and unknown extension', () => {
      expect(classifyMedia('application/x-foo', 'xyz')).toBe(MediaKind.Other);
    });

    it('returns Other for an empty content-type and no extension', () => {
      expect(classifyMedia('')).toBe(MediaKind.Other);
    });
  });
});

describe('getContentType', () => {
  it('returns image content-types', () => {
    const types = getContentType(MediaKind.Image);
    expect(types).toContain('image/jpeg');
    expect(types).toContain('image/png');
    expect(types).toContain('image/svg+xml');
  });

  it('returns video content-types', () => {
    expect(getContentType(MediaKind.Video)).toContain('video/mp4');
  });

  it('returns audio content-types', () => {
    expect(getContentType(MediaKind.Audio)).toContain('audio/mpeg');
  });

  it('returns the pdf content-type', () => {
    expect(getContentType(MediaKind.Pdf)).toEqual(['application/pdf']);
  });

  it('returns model3d content-types', () => {
    const types = getContentType(MediaKind.Model3d);
    expect(types).toContain('model/gltf-binary');
    expect(types).toContain('model/vnd.usdz+zip');
  });

  it('returns an empty array for Other', () => {
    expect(getContentType(MediaKind.Other)).toEqual([]);
  });

  it('returns a fresh copy each call (not a shared mutable reference)', () => {
    const a = getContentType(MediaKind.Image);
    const b = getContentType(MediaKind.Image);
    expect(a).not.toBe(b);
    a.push('image/mutated');
    expect(getContentType(MediaKind.Image)).not.toContain('image/mutated');
  });
});
