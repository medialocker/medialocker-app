/**
 * Shared formatting / media-classification helpers.
 *
 * These were previously copy-pasted across MediaLibrary, SearchScreen, the
 * media detail page, and the set/storyboard pages. Consolidated here (P3.10) so
 * the behavior stays consistent everywhere. Components import the variants they
 * need; the small wording differences (e.g. "0 B" floors) are normalized here.
 */

/** Human byte size using binary (1024) units: e.g. `1.5 GB`. Floors at "0 B". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Human byte size using decimal (1000) units: e.g. `1.50 GB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return Math.round(bytes / 1e3) + " KB";
}

/** mm:ss duration label, or null for missing/non-positive durations. */
export function formatDurationLabel(secs?: number): string | null {
  if (!secs || secs <= 0) return null;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** mm:ss for a known-present duration. */
export function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type MediaKind = "image" | "video" | "audio" | "pdf" | "3d" | "other";

/** Broad classification used for grid icons / filters. Returns "other" for
 *  unknown mimes (libraries that want a default bucket). */
export function kindFromMime(mime: string | undefined | null): MediaKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("model/")) return "3d";
  return "other";
}

/** Like {@link kindFromMime} but folds unknown types into "3d" (the
 *  set/storyboard pages treat anything non-standard as a 3D/binary asset). */
export function mediaKind(mime: string): Exclude<MediaKind, "other"> {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "3d";
}

const EXT_LABELS: Record<string, string> = {
  "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WEBP",
  "video/mp4": "MP4", "video/quicktime": "MOV", "video/webm": "WEBM",
  "audio/wav": "WAV", "audio/mpeg": "MP3", "audio/aac": "AAC",
  "application/pdf": "PDF", "model/gltf-binary": "GLB",
};

/** Short uppercase extension label for a mime type. */
export function extLabel(mime: string): string {
  return EXT_LABELS[mime] ?? mime.split("/")[1]?.toUpperCase() ?? "FILE";
}
