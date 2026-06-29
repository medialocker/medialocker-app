"use client";

import { useRef, useEffect } from "react";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, Media } from "@/lib/api";

export function useMedia(
  bucketId: string,
  filters?: { limit?: number; offset?: number; page?: number; type?: string; kind?: string; search?: string },
) {
  return useQuery({
    queryKey: ["media", bucketId, filters],
    queryFn: () => apiClient.media.list(bucketId, filters),
    enabled: !!bucketId,
  });
}

/** Paginated media list for infinite scroll: fetches `limit` rows per page and
 *  exposes `fetchNextPage`/`hasNextPage` driven by the backend `total`. */
export function useInfiniteMedia(
  bucketId: string,
  filters?: { limit?: number; type?: string; kind?: string; search?: string },
) {
  const limit = filters?.limit ?? 50;
  return useInfiniteQuery({
    queryKey: ["media-infinite", bucketId, { ...filters, limit }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiClient.media.list(bucketId, { ...filters, limit, offset: pageParam as number }),
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.data.length, 0);
      const total = allPages[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
    enabled: !!bucketId,
  });
}

export function useMediaItem(id: string) {
  return useQuery({
    queryKey: ["media", id],
    queryFn: () => apiClient.media.get(id),
    enabled: !!id,
  });
}

/** Presigned GET URL for previewing/streaming an object's bytes. Bytes-direct
 *  (§7.4): resolves a short-lived presigned URL on Hetzner via POST /presign/download
 *  (the proxy attaches auth from the cookie session). The <MediaViewer src=...> then
 *  loads bytes straight from storage — they never transit our server. Presigning no
 *  longer requires an org API key, so this works for every logged-in user. */
export function useMediaUrl(id: string, enabled = true) {
  return useQuery({
    queryKey: ["media-url", id],
    queryFn: async () => {
      const { url } = await apiClient.media.presignDownload(id);
      return url;
    },
    enabled: !!id && enabled,
    // Re-resolve before the 1h presign TTL lapses.
    staleTime: 50 * 60 * 1000,
    retry: false,
  });
}

/** On-demand preview thumbnail (image thumb / video poster) as a presigned Hetzner
 *  URL. Resolves to null until the worker has produced a derivative. The returned
 *  URL is used directly as an <img src> (bytes-direct). */
export function useThumbnail(id: string, enabled = true) {
  return useQuery({
    queryKey: ["thumbnail", id],
    queryFn: () => apiClient.media.thumbnailUrl(id),
    enabled: !!id && enabled,
    staleTime: 30 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}

export function useDeleteMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.media.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
    },
  });
}

export function useUpdateMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Media> }) =>
      apiClient.media.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
    },
  });
}

// Files at/above this size use resumable S3 multipart (§14/§20#3); smaller files
// take the single-PUT fast path. 8 MiB parts are within S3's 5 MiB part minimum.
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;

/** Parse the UploadId out of an InitiateMultipartUploadResult XML response. */
function parseUploadId(xml: string): string {
  const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!m) throw new Error("Multipart init returned no UploadId");
  return m[1]!;
}

/** Build the CompleteMultipartUpload XML body from collected part ETags. */
function buildCompleteXml(parts: { partNumber: number; etag: string }[]): string {
  const body = parts
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join("");
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

export function useMultipartUpload(bucketId: string) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const multipartInfoRef = useRef<{ key: string; uploadId: string; bucketId: string } | null>(null);
  const pendingInitRef = useRef<Promise<string> | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const pending = pendingInitRef.current;
      if (pending) {
        pending
          .then((uploadId) => {
            const info = multipartInfoRef.current;
            if (info?.key && info?.bucketId) {
              apiClient.media
                .presignAbortMultipart({ bucketId: info.bucketId, key: info.key, uploadId })
                .then(({ url }) => fetch(url, { method: "DELETE", keepalive: true }))
                .catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        const info = multipartInfoRef.current;
        if (info?.uploadId) {
          apiClient.media
            .presignAbortMultipart({ bucketId: info.bucketId, key: info.key, uploadId: info.uploadId })
            .then(({ url }) => fetch(url, { method: "DELETE", keepalive: true }))
            .catch(() => {});
        }
      }
    };
  }, []);

  return Object.assign(
    useMutation({
      mutationFn: async (
        input:
          | File
          | { file: File; tags?: string[]; onProgress?: (pct: number) => void; signal?: AbortSignal },
      ) => {
      const file = input instanceof File ? input : input.file;
      const tags = input instanceof File ? [] : (input.tags ?? []);
      const onProgress = input instanceof File ? undefined : input.onProgress;
      // A caller-supplied signal lets the UI cancel THIS specific upload
      // (UploadScreen owns one AbortController per file/upload id, P2.52).
      const externalSignal = input instanceof File ? undefined : input.signal;
      const key = file.name.replace(/[^a-zA-Z0-9._\-\/]/g, "_").replace(/^[/]+|[/]+$/g, "").replace(/\/{2,}/g, "/") || "untitled";

      if (file.size < MULTIPART_THRESHOLD) {
        const { url, headers } = await apiClient.media.presignUpload(bucketId, {
          key,
          contentType: file.type,
          size: file.size,
          tags,
        });
        const putRes = await fetch(url, { method: "PUT", body: file, headers: headers ?? {}, signal: externalSignal });
        if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);
        onProgress?.(100);
      } else {
        let uploadId: string | undefined;
        try {
          const initPromise = (async () => {
            const created = await apiClient.media.presignCreateMultipart(bucketId, {
              key,
              contentType: file.type,
            });
            const initRes = await fetch(created.url, {
              method: "POST",
              headers: created.headers ?? {},
            });
            if (!initRes.ok) throw new Error(`Multipart init failed (HTTP ${initRes.status})`);
            const uploadId = parseUploadId(await initRes.text());
            multipartInfoRef.current = { key, uploadId, bucketId };
            return uploadId;
          })();
          pendingInitRef.current = initPromise;
          uploadId = await initPromise;
          pendingInitRef.current = null;

          const partCount = Math.ceil(file.size / PART_SIZE);
          const parts: { partNumber: number; etag: string }[] = new Array(partCount);
          const PART_CONCURRENCY = 4;
          const abort = new AbortController();
          abortRef.current = abort;
          // Bridge the caller's per-file signal into our internal controller so
          // cancelling that one upload aborts only its in-flight part requests
          // (P2.52). Also abort if the caller's signal is already tripped.
          if (externalSignal) {
            if (externalSignal.aborted) abort.abort();
            else externalSignal.addEventListener("abort", () => abort.abort(), { once: true });
          }
          let nextIndex = 0;
          let completed = 0;

          // Per-part retry with exponential backoff (F6).
          const MAX_RETRIES = 3;
          const RETRY_BASE_MS = 500;

          const uploadPart = async (i: number): Promise<void> => {
            const partNumber = i + 1;
            const blob = file.slice(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, file.size));
            const { url } = await apiClient.media.presignUploadPart({ bucketId, key, uploadId: uploadId!, partNumber });

            let lastErr: unknown;
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              try {
                const partRes = await fetch(url, { method: "PUT", body: blob, signal: abort.signal });
                if (partRes.ok) {
                  // S3 returns the part's ETag header; CompleteMultipartUpload
                  // REQUIRES it. A missing/empty ETag (e.g. CORS not exposing the
                  // header, or a proxy stripping it) would otherwise silently
                  // produce an invalid Complete body — surface it as an error and
                  // retry rather than completing with a blank <ETag/> (P2.53).
                  const etag = (partRes.headers.get("ETag") ?? partRes.headers.get("etag") ?? "").trim();
                  if (!etag) {
                    lastErr = new Error(
                      `Part ${partNumber} returned no ETag — cannot complete upload (check S3 CORS ExposeHeaders: ETag)`,
                    );
                  } else {
                    parts[i] = { partNumber, etag };
                    completed++;
                    onProgress?.(Math.round((completed / partCount) * 100));
                    return;
                  }
                } else {
                  lastErr = new Error(`Part ${partNumber} failed (HTTP ${partRes.status})`);
                }
              } catch (err) {
                if ((err as Error).name === "AbortError") throw err;
                lastErr = err;
              }
              if (attempt < MAX_RETRIES) {
                await new Promise((r) => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
              }
            }
            abort.abort();
            throw lastErr;
          };

          const uploadWorker = async (): Promise<void> => {
            for (;;) {
              const i = nextIndex++;
              if (i >= partCount) return;
              await uploadPart(i);
            }
          };

          try {
            await Promise.all(
              Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, () => uploadWorker()),
            );
          } catch (err) {
            abort.abort();
            throw err;
          } finally {
            if (abortRef.current === abort) abortRef.current = null;
          }

          // Final guard before assembling the Complete body: every part must
          // have a non-empty ETag, else S3 rejects (or worse, silently corrupts)
          // the CompleteMultipartUpload (P2.53).
          const missing = parts.findIndex((p) => !p || !p.etag);
          if (missing !== -1) {
            throw new Error(`Missing ETag for part ${missing + 1} — upload cannot be completed`);
          }

          const complete = await apiClient.media.presignCompleteMultipart({ bucketId, key, uploadId, tags });
          const completeRes = await fetch(complete.url, {
            method: "POST",
            headers: complete.headers ?? { "Content-Type": "application/xml" },
            body: buildCompleteXml(parts),
          });
          if (!completeRes.ok) throw new Error(`Multipart complete failed (HTTP ${completeRes.status})`);
          multipartInfoRef.current = null;
        } catch (err) {
          pendingInitRef.current = null;
          if (uploadId) {
            try {
              const abortUrl = await apiClient.media.presignAbortMultipart({ bucketId, key, uploadId });
              await fetch(abortUrl.url, { method: "DELETE", keepalive: true });
            } catch { /* best-effort abort cleanup */ }
          }
          throw err;
        }
      }

      return { key };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
    },
  }),
  { abort: () => abortRef.current?.abort() },
);
}
