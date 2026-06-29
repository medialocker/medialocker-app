// §2.6 — Control-plane calls go through the SAME-ORIGIN server proxy
// (app/api/proxy/[...path]) which reads the Supabase session from httpOnly
// cookies server-side and attaches the bearer token there. The browser never
// holds or sends the raw access token — cookies ride along automatically on a
// same-origin request. So this client carries NO token: it just calls
// `/api/proxy/<control-plane-path>`.
const API_BASE = "/api/proxy";

type RequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { headers = {}, ...rest } = options;

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    // Same-origin: the session httpOnly cookies are sent automatically and the
    // proxy converts them into the upstream Authorization header.
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

  if (!res.ok) {
    // The control plane returns `{ error: { code, message } }`; fall back gracefully.
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const message =
      body?.error?.message ?? body?.error ?? body?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/* ─────────────────────────────────────────────────────────────────────────
 * UI-facing types. The control-plane API speaks a different (snake_case,
 * normalized) dialect; this client is the single adapter that maps the real
 * backend responses (see apps/api/src/routes/*) into these shapes so the
 * dashboard components stay backend-agnostic.
 * ──────────────────────────────────────────────────────────────────────── */

export interface Media {
  id: string;
  key: string;
  filename: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number; // seconds
  tags: string[];
  categories: string[];
  bucketId: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl?: string;
  url?: string;
}

/** A media item as it appears inside a set — carries the set_item join id so it
 *  can be removed (the backend keys removal on the set_item id, not the object id). */
export type SetItem = Media & { setItemId: string };

export interface Bucket {
  id: string;
  name: string;
  objectCount: number;
  totalSize: number;
  orgId: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** Bucket name this key is restricted to, or null for all buckets. */
  bucketScope?: string | null;
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface Usage {
  usedStorage: number;
  allocatedStorage: number;
  egressThisMonth: number;
  apiCallsThisMonth: number;
  objectCount: number;
  history: { date: string; storageBytes: number; egressBytes: number; requests: number }[];
}

export interface Billing {
  plan: string;
  baseStorage: number;
  overageRate: number;
  autoCapacity: boolean;
  autoCapacityConfig: { increment: number; threshold: number; maxSpend: number };
  currentUsage: number;
  invoices: { id: string; date: string; amount: number; status: string; url: string }[];
  renewsAt?: string;
  nextInvoiceAmount?: number;
}

export interface Set {
  id: string;
  name: string;
  description: string;
  baseAssetId: string;
  variantCount: number;
  orgId: string;
  createdAt: string;
}

export interface Storyboard {
  id: string;
  name: string;
  description: string;
  clipCount: number;
  orgId: string;
  createdAt: string;
}

export interface Plan {
  tierKey: string;
  name: string;
  includedGb: number;
  perGbPriceCents: number;
  hasStripePrice: boolean;
}

export interface StoryboardClip {
  id: string;
  mediaId: string;
  order: number;
  media: Media;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
  objectCount: number;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  objectCount: number;
  children: Category[];
}

export interface SearchResult {
  media: Media[];
  total: number;
  facets: {
    tags: { key: string; count: number }[];
    categories: { key: string; count: number }[];
    sets: { key: string; count: number }[];
    storyboards: { key: string; count: number }[];
    types: { key: string; count: number }[];
  };
}

/* ─── API verbs ──────────────────────────────────────────────────────────── */

// No token threading here — see API_BASE above. The same-origin proxy injects
// the bearer server-side from the httpOnly cookie session. §2.6
function api() {
  return {
    get: <T>(path: string) => request<T>(path, { method: "GET" }),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
    put: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
    delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  };
}

/* ─── Transforms (backend row → UI shape) ───────────────────────────────── */

function basename(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/** Map an object/media row (from /media, /media/:id, search) to `Media`. */
function toMedia(r: any): Media {
  const tags: string[] = Array.isArray(r.tags)
    ? r.tags.map((t: any) => (typeof t === "string" ? t : t.name)).filter(Boolean)
    : [];
  const categories: string[] = Array.isArray(r.categories)
    ? r.categories.map((c: any) => (typeof c === "string" ? c : c.name)).filter(Boolean)
    : [];
  return {
    id: r.id,
    key: r.key,
    filename: r.key ? basename(r.key) : (r.filename ?? ""),
    size: num(r.size),
    mimeType: r.content_type ?? r.mimeType ?? "application/octet-stream",
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    duration: r.duration_ms != null ? num(r.duration_ms) / 1000 : undefined,
    tags,
    categories,
    bucketId: r.bucket_id ?? r.bucketId ?? "",
    orgId: r.org_id ?? "",
    createdAt: r.created_at ?? r.createdAt ?? "",
    updatedAt: r.updated_at ?? r.created_at ?? "",
    // Object bytes are served via on-demand presigned URLs (POST /presign/download);
    // thumbnails via the authed GET /media/:id/thumbnail endpoint (see useThumbnail /
    // MediaThumb). Both are fetched lazily by id, so neither is inlined on the row here.
    // TODO (G12): Populate `thumbnailUrl` from backend when the API returns a
    // `thumbnail_url` or `thumbnail_key` field alongside the media row, so the
    // library grid can render previews without an extra per-item fetch.
    thumbnailUrl: r.thumbnail_url ?? r.thumbnailUrl ?? undefined,
    url: undefined,
  };
}

/** A set_items join row → Media plus its set_item id. */
function toSetItem(r: any): SetItem {
  return {
    ...toMedia({
      id: r.object_id,
      key: r.object_key,
      content_type: r.content_type,
      size: r.size,
      width: r.width,
      height: r.height,
      bucket_name: r.bucket_name,
    }),
    setItemId: r.id,
  };
}

/** A storyboard_clips join row → StoryboardClip. */
function toClip(r: any): StoryboardClip {
  return {
    id: r.id,
    mediaId: r.object_id,
    order: num(r.position),
    media: toMedia({
      id: r.object_id,
      key: r.object_key,
      content_type: r.content_type,
    }),
  };
}

/* ─── Tag resolution (UI works in tag names; backend keys on tag ids) ────── */

async function ensureTagIds(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];

  // De-dupe case-insensitively up front, keeping the first-seen original casing.
  // This removes the per-name duplication that drove the old N+1 create loop and
  // prevents two identical names in the same call racing to create the tag.
  const uniqueByLower = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!uniqueByLower.has(lower)) uniqueByLower.set(lower, name);
  }
  if (uniqueByLower.size === 0) return [];

  const { tags } = await api().get<{ tags: { id: string; name: string }[] }>("/api/tags");
  const idByLower = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));

  // Only the names not already present need a create. Issue those creates
  // concurrently (the backend has no batch-upsert endpoint), and treat a 409
  // Conflict as "another writer created it" — re-resolve from the tag list
  // instead of failing, so concurrent taggers converge on the same id (P2.58).
  const missing = [...uniqueByLower].filter(([lower]) => !idByLower.has(lower));
  if (missing.length > 0) {
    const created = await Promise.all(
      missing.map(async ([lower, name]) => {
        try {
          const t = await api().post<{ id: string; name: string }>("/api/tags", { name });
          return [lower, t.id] as const;
        } catch (err) {
          if ((err as { status?: number }).status === 409) return null;
          throw err;
        }
      }),
    );
    for (const entry of created) {
      if (entry) idByLower.set(entry[0], entry[1]);
    }
    // If any creates 409'd (already existed), re-fetch once to resolve their ids.
    if (created.some((e) => e === null)) {
      const { tags: refreshed } = await api().get<{ tags: { id: string; name: string }[] }>("/api/tags");
      for (const t of refreshed) idByLower.set(t.name.toLowerCase(), t.id);
    }
  }

  const ids: string[] = [];
  for (const lower of uniqueByLower.keys()) {
    const id = idByLower.get(lower);
    if (id) ids.push(id);
  }
  return ids;
}

/* ─── Client ─────────────────────────────────────────────────────────────── */

export const apiClient = {
  media: {
    list: async (
      bucketId: string,
      params?: {
        limit?: number; offset?: number; page?: number; type?: string; kind?: string; search?: string;
        tags?: string; categories?: string; sets?: string; storyboards?: string;
        sizeMin?: number; sizeMax?: number; dateFrom?: string; dateTo?: string;
      },
    ) => {
      const sp = new URLSearchParams();
      if (bucketId) sp.set("bucketId", bucketId);
      const limit = params?.limit ?? 50;
      sp.set("limit", String(limit));
      const offset = params?.offset ?? (params?.page ? (params.page - 1) * limit : 0);
      if (offset) sp.set("offset", String(offset));
      const kind = params?.kind ?? params?.type;
      if (kind && kind !== "all") sp.set("kind", kind.toLowerCase());
      if (params?.search) sp.set("search", params.search);
      if (params?.tags) sp.set("tags", params.tags);
      if (params?.categories) sp.set("categories", params.categories);
      if (params?.sets) sp.set("sets", params.sets);
      if (params?.storyboards) sp.set("storyboards", params.storyboards);
      if (params?.sizeMin !== undefined) sp.set("sizeMin", String(params.sizeMin));
      if (params?.sizeMax !== undefined) sp.set("sizeMax", String(params.sizeMax));
      if (params?.dateFrom) sp.set("dateFrom", params.dateFrom);
      if (params?.dateTo) sp.set("dateTo", params.dateTo);

      const res = await api().get<{
        items: any[]; total: number; limit: number; offset: number;
        facets?: {
          kinds?: Record<string, number>;
          tags?: Record<string, number>;
          categories?: Record<string, number>;
          sets?: Record<string, number>;
          storyboards?: Record<string, number>;
        };
      }>(
        `/api/media?${sp.toString()}`,
      );
      const data = res.items.map(toMedia);
      return { data, total: res.total, hasMore: res.offset + data.length < res.total, facets: res.facets };
    },
    get: async (id: string) => toMedia(await api().get<any>(`/api/media/${id}`)),
    delete: (id: string) => api().delete<{ status: string }>(`/api/media/${id}`).then(() => undefined),
    /** Only tags are persisted today (backend has no generic media PUT). */
    update: async (id: string, data: Partial<Media>) => {
      if (data.tags) {
        const tagIds = await ensureTagIds(data.tags);
        await api().put(`/api/objects/${id}/tags`, { tagIds });
      }
      return apiClient.media.get(id);
    },
    /** On-demand presigned GET URL for the object's bytes. The browser fetches the
     *  bytes straight from Hetzner storage with this URL — they never transit our
     *  server. Presigning no longer requires the org to own an API key (the session
     *  cookie via the proxy is sufficient), so this won't 409 NoApiKey. */
    presignDownload: (objectId: string, expiresIn = 3600) =>
      api().post<{ url: string; method: string; objectId: string; key: string; expiresIn: number }>(
        "/api/presign/download",
        { objectId, expiresIn },
      ),
    /** Single presigned PUT for the whole object (small-file fast path).
     *  §10.8 — `tags` are applied atomically at upload time: they are sent to the
     *  presign endpoint so the control plane includes `x-amz-tagging` in the
     *  SIGNED headers and returns it in `headers`, which the client echoes on the
     *  PUT. The gateway then applies the tags on the object in the same request —
     *  no race-prone post-upload list+update. */
    presignUpload: (
      bucketId: string,
      body: { key: string; contentType?: string; size?: number; tags?: string[] },
    ) =>
      api().post<{ url: string; method: string; key: string; headers: Record<string, string> }>(
        "/api/presign/upload",
        { bucketId, ...body },
      ),
    /** Multipart handshake (large files): create → part URLs → complete. Each
     *  returns a presigned S3 URL the browser calls directly (§14/§20#3). */
    presignCreateMultipart: (
      bucketId: string,
      body: { key: string; contentType?: string },
    ) =>
      api().post<{ url: string; method: string; key: string; bucket: string; headers: Record<string, string> }>(
        "/api/presign/create-multipart",
        { bucketId, ...body },
      ),
    presignUploadPart: (body: { bucketId: string; key: string; uploadId: string; partNumber: number }) =>
      api().post<{ url: string; method: string; uploadId: string; partNumber: number; key: string }>(
        "/api/presign/upload-part",
        body,
      ),
    /** §10.8 — `tags` ride on the COMPLETE call: the gateway honors x-amz-tagging
     *  on CompleteMultipartUpload and applies the tags atomically in the same txn
     *  that upserts the assembled object (the create/initiate request is too early
     *  — the object row doesn't exist yet). */
    presignCompleteMultipart: (body: { bucketId: string; key: string; uploadId: string; tags?: string[] }) =>
      api().post<{ url: string; method: string; uploadId: string; key: string; location: string; headers: Record<string, string> }>(
        "/api/presign/complete-upload",
        body,
      ),
    presignAbortMultipart: (body: { bucketId: string; key: string; uploadId: string }) =>
      api().post<{ url: string; method: string }>("/api/presign/abort-multipart", body),
    /** Resolve the object's preview derivative (image thumbnail / video poster) to
     *  a presigned GET URL on Hetzner. Bytes-direct (§7.4): the JSON endpoint is
     *  bearer-protected (the proxy attaches auth from the cookie session), and now
     *  returns `{ url }` — a short-lived presigned URL the browser uses directly as
     *  an `<img src>`. The derivative bytes never transit our server. Resolves to
     *  null until the worker has produced a derivative (404). §2.6 */
    thumbnailUrl: async (id: string): Promise<string | null> => {
      const res = await fetch(`${API_BASE}/api/media/${id}/thumbnail`, {
        credentials: "same-origin",
      });
      if (!res.ok) return null;
      const { url } = (await res.json()) as { url: string; expiresIn?: number };
      return url ?? null;
    },
  },

  buckets: {
    list: async () => {
      const { buckets } = await api().get<{ buckets: any[] }>("/api/buckets");
      return buckets.map(
        (b): Bucket => ({
          id: b.id,
          name: b.name,
          objectCount: num(b.objectCount ?? b.object_count),
          totalSize: num(b.totalSize ?? b.total_size),
          orgId: b.org_id ?? "",
          createdAt: b.created_at ?? b.createdAt ?? "",
        }),
      );
    },
    create: async (name: string) => {
      const b = await api().post<{ id: string; name: string }>("/api/buckets", { name });
      return { id: b.id, name: b.name, objectCount: 0, totalSize: 0, orgId: "", createdAt: new Date().toISOString() } as Bucket;
    },
    delete: (id: string) => api().delete<{ status: string }>(`/api/buckets/${id}`).then(() => undefined),
  },

  apiKeys: {
    list: async () => {
      const { keys } = await api().get<{ keys: any[] }>("/api/api-keys");
      return keys.map(
        (k): ApiKey => ({
          id: k.id,
          name: k.name ?? k.access_key_id,
          prefix: k.access_key_id,
          scopes: k.scopes ?? [],
          bucketScope: k.bucket_scope ?? null,
          expiresAt: k.expires_at ?? undefined,
          lastUsedAt: k.last_used_at ?? undefined,
          createdAt: k.created_at ?? "",
        }),
      );
    },
    create: async (body: { name: string; scopes: string[]; expiresAt?: string; bucketId?: string }) => {
      const res = await api().post<{ id: string; name?: string; accessKeyId: string; secret: string; scopes: string[]; expiresAt: string }>(
        "/api/api-keys",
        { name: body.name, scopes: body.scopes, ...(body.bucketId ? { bucketId: body.bucketId } : {}) },
      );
      const key: ApiKey = {
        id: res.id,
        name: res.name ?? body.name,
        prefix: res.accessKeyId,
        scopes: res.scopes,
        expiresAt: res.expiresAt,
        createdAt: new Date().toISOString(),
      };
      return { key, secret: res.secret };
    },
    revoke: (id: string) => api().delete<{ status: string }>(`/api/api-keys/${id}`).then(() => undefined),
    rotate: async (id: string) => {
      const res = await api().put<{ id?: string; name?: string; accessKeyId: string; secret: string }>(`/api/api-keys/${id}/rotate`);
      const key: ApiKey = {
        id: res.id ?? id,
        name: res.name ?? res.accessKeyId,
        prefix: res.accessKeyId,
        scopes: [],
        createdAt: new Date().toISOString(),
      };
      return { key, secret: res.secret };
    },
  },

  usage: {
    get: async (): Promise<Usage> => {
      const u = await api().get<any>("/api/usage");
      return {
        usedStorage: num(u.used),
        allocatedStorage: num(u.allocated),
        egressThisMonth: num(u.egress),
        apiCallsThisMonth: num(u.requests),
        objectCount: num(u.objectCount),
        history: [],
      };
    },
    history: async (): Promise<Usage["history"]> => {
      const { history } = await api().get<{ history: any[] }>("/api/usage/history");
      return history.map((h) => ({
        date: h.period,
        storageBytes: num(h.stored_bytes_max),
        egressBytes: num(h.egress_bytes),
        requests: num(h.request_count),
      }));
    },
    events: async (days = 30) => {
      const { events } = await api().get<{ events: { id: string; type: string; bytes: string; ts: string }[] }>(
        `/api/usage/events?days=${days}`,
      );
      return events.map((e) => ({
        id: e.id,
        type: e.type,
        bytes: num(e.bytes),
        ts: e.ts,
      }));
    },
  },

  billing: {
    get: async (): Promise<Billing> => {
      const usage = await api().get<any>("/api/usage");
      let sub: any = null;
      try {
        const r = await api().get<{ subscription: any }>("/api/billing/subscription");
        sub = r.subscription;
      } catch {
        /* no subscription yet */
      }
      // /usage now carries the real auto-capacity config (enabled + increment/
      // threshold/max-spend); maxSpend is surfaced in dollars for the UI.
      const ac = usage.autoCapacity ?? {};
      return {
        plan: sub?.plan_name ?? "—",
        baseStorage: sub ? num(sub.planIncludedGb) * 1e9 : num(usage.allocated),
        overageRate: sub ? num(sub.planPriceCents) / 100 : 0,
        currentUsage: num(usage.used),
        autoCapacity: Boolean(ac.enabled),
        autoCapacityConfig: {
          increment: num(ac.incrementGb) || 10,
          threshold: num(ac.thresholdPct) || 80,
          maxSpend: num(ac.maxMonthlySpendCents) / 100,
        },
        // TODO (G18): Populate invoices from a real /api/billing/invoices endpoint
        // or via Stripe customer portal. Currently returns an empty array, making
        // the invoice history table in BillingScreen non-functional.
        invoices: [],
        renewsAt: sub?.current_period_end ?? undefined,
      };
    },
    addCapacity: (gb: number) =>
      api().post<{ addedGb: number; newAllocatedGb: number }>("/api/billing/capacity/add", { gb }),
    updateAutoCapacity: (config: { enabled: boolean; increment: number; threshold: number; maxSpend: number }) =>
      api().put("/api/billing/capacity/auto", {
        enabled: config.enabled,
        incrementGb: config.increment,
        thresholdPct: config.threshold,
        maxMonthlySpendCents: Math.round(config.maxSpend * 100),
      }),
    /** Downgrade to a plan tier; the backend rejects (409 DowngradeBlocked) if the
     *  target plan holds less than current usage (§8 shrink guard). */
    downgrade: (tierKey: string) =>
      api().post<{ tierKey: string; planName: string; newAllocatedGb: number; message: string }>(
        "/api/billing/downgrade",
        { tierKey },
      ),
    portalSession: () => api().get<{ url: string }>("/api/billing/portal"),
    invoices: async (): Promise<Billing["invoices"]> => {
      const { invoices } = await api().get<{ invoices: { id: string; date: string; amount: number; status: string; url: string }[] }>(
        "/api/billing/invoices",
      );
      return invoices;
    },
    plans: async (): Promise<Plan[]> => {
      const { plans } = await api().get<{ plans: any[] }>("/api/plans");
      return plans.map((p) => ({
        tierKey: p.tierKey,
        name: p.name,
        includedGb: Number(p.includedGb),
        perGbPriceCents: Number(p.perGbPriceCents),
        hasStripePrice: Boolean(p.hasStripePrice),
      }));
    },
  },

  sets: {
    list: async () => {
      const { sets } = await api().get<{ sets: any[] }>("/api/sets");
      return sets.map(
        (s): Set => ({
          id: s.id,
          name: s.name,
          description: "",
          baseAssetId: s.baseObjectId ?? s.base_object_id ?? "",
          variantCount: num(s.itemCount ?? s.item_count),
          orgId: s.org_id ?? "",
          createdAt: s.created_at ?? "",
        }),
      );
    },
    create: (body: { name: string; description?: string; baseAssetId?: string }) =>
      api().post<{ id: string; name: string }>("/api/sets", {
        name: body.name,
        baseObjectId: body.baseAssetId,
      }),
    get: async (id: string): Promise<Set & { items: SetItem[] }> => {
      const r = await api().get<any>(`/api/sets/${id}`);
      const items = (r.items ?? []).map(toSetItem);
      return {
        id: r.id,
        name: r.name,
        description: "",
        baseAssetId: r.baseObjectId ?? r.base_object_id ?? "",
        variantCount: items.length,
        orgId: r.org_id ?? "",
        createdAt: r.created_at ?? "",
        items,
      };
    },
    delete: (id: string) => api().delete<{ status: string }>(`/api/sets/${id}`).then(() => undefined),
    addItem: (
      setId: string,
      mediaId: string,
      targets?: { aspectRatio?: string; width?: number; height?: number; role?: string },
    ) =>
      api().post(`/api/sets/${setId}/items`, { objectId: mediaId, ...(targets ?? {}) }),
    removeItem: (setId: string, itemId: string) =>
      api().delete(`/api/sets/${setId}/items/${itemId}`),
    generateVariants: (setId: string) =>
      api().post<{ status: string; message: string; setId: string }>(`/api/sets/${setId}/generate`),
  },

  storyboards: {
    list: async () => {
      const { storyboards } = await api().get<{ storyboards: any[] }>("/api/storyboards");
      return storyboards.map(
        (s): Storyboard => ({
          id: s.id,
          name: s.name,
          description: "",
          clipCount: num(s.clipCount ?? s.clip_count),
          orgId: s.org_id ?? "",
          createdAt: s.created_at ?? "",
        }),
      );
    },
    create: (body: { name: string; description?: string }) =>
      api().post<{ id: string; name: string }>("/api/storyboards", { name: body.name }),
    get: async (id: string): Promise<Storyboard & { clips: StoryboardClip[] }> => {
      const r = await api().get<any>(`/api/storyboards/${id}`);
      const clips = (r.clips ?? []).map(toClip);
      return {
        id: r.id,
        name: r.name,
        description: "",
        clipCount: clips.length,
        orgId: r.org_id ?? "",
        createdAt: r.created_at ?? "",
        clips,
      };
    },
    delete: (id: string) =>
      api().delete<{ status: string }>(`/api/storyboards/${id}`).then(() => undefined),
    addClip: (storyboardId: string, mediaId: string, order: number) =>
      api().post(`/api/storyboards/${storyboardId}/clips`, { objectId: mediaId, position: order }),
    removeClip: (storyboardId: string, clipId: string) =>
      api().delete(`/api/storyboards/${storyboardId}/clips/${clipId}`),
    /** One bulk call persists the whole new order atomically. */
    reorder: (storyboardId: string, clipIds: string[]) =>
      api().put(`/api/storyboards/${storyboardId}/clips/reorder`, { clipIds }),
  },

  tags: {
    list: async (): Promise<Tag[]> => {
      const { tags } = await api().get<{ tags: any[] }>("/api/tags");
      return tags.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        objectCount: num(t.objectCount ?? t.object_count),
      }));
    },
    create: (name: string) => api().post<{ id: string; name: string; slug: string }>("/api/tags", { name }),
    delete: (id: string) => api().delete<{ status: string }>(`/api/tags/${id}`).then(() => undefined),
  },

  categories: {
    list: async (): Promise<Category[]> => {
      const { categories } = await api().get<{ categories: any[] }>("/api/categories");
      const mapCat = (c: any): Category => ({
        id: c.id,
        name: c.name,
        parentId: c.parentId ?? c.parent_id ?? null,
        objectCount: num(c.objectCount ?? c.object_count),
        children: Array.isArray(c.children) ? c.children.map(mapCat) : [],
      });
      return categories.map(mapCat);
    },
    create: (name: string, parentId?: string) =>
      api().post<{ id: string; name: string; parentId: string | null }>("/api/categories", { name, parentId }),
    delete: (id: string) => api().delete<{ status: string }>(`/api/categories/${id}`).then(() => undefined),
    /** Replace the set of categories assigned to an object. */
    setForObject: (objectId: string, categoryIds: string[]) =>
      api().put(`/api/objects/${objectId}/categories`, { categoryIds }),
  },

  search: {
    query: async (q: string, filters?: Record<string, string>, page?: number): Promise<SearchResult> => {
      const sp = new URLSearchParams();
      sp.set("q", q);
      const PARAM_MAP: Record<string, string> = { type: "kind" };
      if (filters) {
        for (const [k, v] of Object.entries(filters)) {
          if (v) sp.set(PARAM_MAP[k] ?? k, v);
        }
      }
      const limit = 50;
      if (page && page > 1) sp.set("offset", String((page - 1) * limit));
      const res = await api().get<{
        items: any[];
        total: number;
        facets: {
          kinds?: Record<string, number>;
          tags?: Record<string, number>;
          categories?: Record<string, number>;
          sets?: Record<string, number>;
          storyboards?: Record<string, number>;
        };
      }>(`/api/search?${sp.toString()}`);
      const types = Object.entries(res.facets?.kinds ?? {}).map(([key, count]) => ({ key, count }));
      const tags = Object.entries(res.facets?.tags ?? {}).map(([key, count]) => ({ key, count }));
      const categories = Object.entries(res.facets?.categories ?? {}).map(([key, count]) => ({ key, count }));
      const sets = Object.entries(res.facets?.sets ?? {}).map(([key, count]) => ({ key, count }));
      const storyboards = Object.entries(res.facets?.storyboards ?? {}).map(([key, count]) => ({ key, count }));
      return { media: res.items.map(toMedia), total: res.total, facets: { tags, categories, sets, storyboards, types } };
    },
  },
};
