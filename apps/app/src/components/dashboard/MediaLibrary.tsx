"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutGrid, List, Download, Link, Upload, Trash2,
  MoreHorizontal, Play, FileText, Box, X,
  Volume2, Image as ImageIcon, Filter,
} from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn } from "./DashboardShell";
import { useInfiniteMedia, useDeleteMedia, useUpdateMedia, useThumbnail } from "@/hooks/useMedia";
import { useBuckets } from "@/hooks/useBuckets";
import { useCategories, useSetObjectCategories } from "@/hooks/useCategories";
import { apiClient } from "@/lib/api";
import { formatBytes, formatDurationLabel, kindFromMime } from "@/lib/format";

/** Worker-generated preview (image thumbnail / video poster), fetched with auth.
 *  Falls back to a type icon until the derivative exists. */
function MediaThumb({
  id,
  name,
  type,
  size = 28,
  brightness,
}: {
  id: string;
  name: string;
  type: string;
  size?: number;
  brightness?: boolean;
}) {
  const { data: url } = useThumbnail(id);
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        className="w-full h-full object-cover"
        style={brightness ? { filter: "brightness(0.85)" } : undefined}
      />
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center" style={{ background: "#1E1E28" }}>
      {type === "pdf"   ? <FileText size={size} style={{ color: "#FC8181", opacity: 0.6 }} />
        : type === "3d"    ? <Box      size={size} style={{ color: "#4ECDC4", opacity: 0.6 }} />
        : type === "audio" ? <Volume2  size={size} style={{ color: "#F59E0B", opacity: 0.6 }} />
        : type === "video" ? <Play     size={size} style={{ color: "#A89FF8", opacity: 0.6 }} />
        : <ImageIcon size={size} style={{ color: "#8080A0", opacity: 0.6 }} />}
    </div>
  );
}

type FileItem = {
  id: string;
  name: string;
  size: string;
  type: string;
  thumb: string | null;
  duration: string | null;
  tags: string[];
  categories: string[];
  keyName: string;
  bucketName: string;
  added: string;
  width?: number;
  height?: number;
  url?: string;
};

/** Flatten the hierarchical category tree to a flat {id, name} list. */
function flattenCategories(tree: { id: string; name: string; children?: any[] }[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const walk = (nodes: { id: string; name: string; children?: any[] }[]) => {
    for (const n of nodes) {
      out.push({ id: n.id, name: n.name });
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

const TYPE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  video: { bg: "rgba(109,94,246,0.12)", color: "#A89FF8", border: "rgba(109,94,246,0.25)" },
  image: { bg: "rgba(52,211,153,0.10)", color: "#34D399", border: "rgba(52,211,153,0.2)" },
  audio: { bg: "rgba(245,158,11,0.10)", color: "#F59E0B", border: "rgba(245,158,11,0.2)" },
  pdf:   { bg: "rgba(239,68,68,0.10)",  color: "#FC8181", border: "rgba(239,68,68,0.2)"  },
  "3d":  { bg: "rgba(78,205,196,0.10)", color: "#4ECDC4", border: "rgba(78,205,196,0.2)" },
};

function TypeChip({ type }: { type: string }) {
  const c = TYPE_COLORS[type] ?? { bg: "rgba(255,255,255,0.06)", color: "#8080A0", border: "rgba(255,255,255,0.1)" };
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
      style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}` }}
    >
      {type}
    </span>
  );
}

const FILTER_TYPES = ["All", "Video", "Image", "Audio", "PDF", "3D"];

export function MediaLibrary() {
  const router = useRouter();
  const { data: buckets = [] } = useBuckets();
  const [bucketId, setBucketId] = useState<string>("");
  const activeBucket = buckets.find((b) => b.id === bucketId) ?? buckets[0];
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteMedia(
    activeBucket?.id ?? "",
    {},
  );
  const deleteMedia = useDeleteMedia();
  const updateMedia = useUpdateMedia();
  const { data: categoryTree = [] } = useCategories();
  const setObjectCategories = useSetObjectCategories();
  const allCategories = flattenCategories(categoryTree as any);
  const [tagDraft, setTagDraft] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeType, setActiveType] = useState("All");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [drawerFile, setDrawerFile] = useState<FileItem | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sentinel observed at the bottom of the scroll area to load the next page.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const files: FileItem[] = (data?.pages.flatMap((p) => p.data) ?? []).map((it) => ({
    id: String(it.id),
    name: it.filename,
    size: formatBytes(it.size),
    type: kindFromMime(it.mimeType),
    thumb: it.thumbnailUrl ?? null,
    duration: formatDurationLabel(it.duration),
    tags: it.tags ?? [],
    categories: it.categories ?? [],
    keyName: it.key,
    bucketName: activeBucket?.name ?? "",
    added: it.createdAt ? new Date(it.createdAt).toLocaleDateString() : "—",
    width: it.width,
    height: it.height,
    url: it.url,
  }));

  // Tags shown in the rail are the ones that actually appear in this bucket.
  const tagsInLibrary = Array.from(new Set(files.flatMap((f) => f.tags))).sort();

  const filtered = files.filter((f) => {
    const typeOk = activeType === "All" || f.type === activeType.toLowerCase();
    const tagOk = activeTags.length === 0 || activeTags.every((t) => f.tags.includes(t));
    return typeOk && tagOk;
  });

  function toggleSelect(id: string) {
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  }

  function toggleTag(t: string) {
    setActiveTags((a) => a.includes(t) ? a.filter((x) => x !== t) : [...a, t]);
  }

  function handleDelete(id: string) {
    deleteMedia.mutate(id, {
      onSuccess: () => {
        setSelected((s) => s.filter((x) => x !== id));
        setDrawerFile((d) => (d?.id === id ? null : d));
        setMenuOpen(null);
      },
    });
  }

  function handleBulkDelete() {
    selected.forEach((id) => deleteMedia.mutate(id));
    setSelected([]);
  }

  async function download(f: FileItem) {
    setActionError(null);
    // Bytes-direct (§7.4): the presigned GET URL points straight at Hetzner storage,
    // so opening it downloads the bytes without proxying them through our server
    // (which would double-bill egress). Presigning no longer needs an org API key.
    try {
      const { url } = await apiClient.media.presignDownload(f.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("presignDownload failed", err);
      setActionError(`Couldn't download "${f.name}".`);
    }
  }

  async function copyUrl(f: FileItem) {
    setActionError(null);
    // Copy the presigned (shareable, time-limited) URL to the clipboard.
    try {
      const { url } = await apiClient.media.presignDownload(f.id);
      await navigator.clipboard.writeText(url);
      setCopiedId(f.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("copyUrl failed", err);
      setActionError("Couldn't copy the URL to your clipboard.");
    }
  }

  function applyTags(f: FileItem, nextTags: string[]) {
    updateMedia.mutate({ id: f.id, data: { tags: nextTags } });
    // Optimistically reflect in the open drawer until the list refetches.
    setDrawerFile((d) => (d && d.id === f.id ? { ...d, tags: nextTags } : d));
  }

  function addTag(f: FileItem) {
    const t = tagDraft.trim();
    if (!t || f.tags.includes(t)) { setTagDraft(""); return; }
    applyTags(f, [...f.tags, t]);
    setTagDraft("");
  }

  function toggleCategory(f: FileItem, name: string) {
    const nextNames = f.categories.includes(name)
      ? f.categories.filter((c) => c !== name)
      : [...f.categories, name];
    const ids = allCategories.filter((c) => nextNames.includes(c.name)).map((c) => c.id);
    setObjectCategories.mutate({ objectId: f.id, categoryIds: ids });
    setDrawerFile((d) => (d && d.id === f.id ? { ...d, categories: nextNames } : d));
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Filter rail ──────────────────────────────── */}
      <aside
        className={`hidden lg:flex flex-col flex-shrink-0 overflow-y-auto`}
        style={{ width: 200, borderRight: "1px solid rgba(255,255,255,0.06)", padding: "16px 12px" }}
      >
        {buckets.length > 0 && (
          <>
            <p className="text-[10px] uppercase tracking-widest mb-2 px-1" style={{ color: "#404058" }}>
              Bucket
            </p>
            <select
              value={activeBucket?.id ?? ""}
              onChange={(e) => { setBucketId(e.target.value); setSelected([]); setActiveTags([]); }}
              className="w-full mb-4 px-2.5 py-1.5 rounded-lg text-xs outline-none font-mono"
              style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", color: "#A89FF8" }}
            >
              {buckets.map((b) => (
                <option key={b.id} value={b.id} style={{ background: "#15151C" }}>{b.name}</option>
              ))}
            </select>
          </>
        )}
        <p className="text-[10px] uppercase tracking-widest mb-3 px-1" style={{ color: "#404058" }}>
          Type
        </p>
        {FILTER_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setActiveType(t)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg mb-0.5 text-xs transition-colors text-left"
            style={{
              background: activeType === t ? "rgba(109,94,246,0.12)" : "transparent",
              color: activeType === t ? "#A89FF8" : "#606080",
            }}
          >
            {t}
          </button>
        ))}
        <div className="my-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }} />
        <p className="text-[10px] uppercase tracking-widest mb-3 px-1" style={{ color: "#404058" }}>
          Tags
        </p>
        {tagsInLibrary.length === 0 && (
          <p className="px-3 text-xs" style={{ color: "#404058" }}>No tags yet</p>
        )}
        {tagsInLibrary.map((t) => {
          const on = activeTags.includes(t);
          return (
            <button
              key={t}
              onClick={() => toggleTag(t)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg mb-0.5 text-xs transition-colors text-left"
              style={{
                background: on ? "rgba(109,94,246,0.1)" : "transparent",
                color: on ? "#A89FF8" : "#606080",
              }}
            >
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ background: on ? "#6D5EF6" : "rgba(255,255,255,0.12)" }}
              />
              {t}
            </button>
          );
        })}
      </aside>

      {/* ── Main content ─────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader
          title="Library"
          breadcrumb={["my-studio"]}
          action={
            <div className="flex items-center gap-2">
              {/* Mobile filter toggle */}
              <GhostBtn
                icon={<Filter size={14} />}
                onClick={() => setFilterOpen(!filterOpen)}
                small
              >
                <span className="lg:hidden">Filter</span>
              </GhostBtn>
              <div className="flex items-center rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
                {(["grid", "list"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setViewMode(m)}
                    className="p-2 transition-colors"
                    style={{
                      background: viewMode === m ? "rgba(109,94,246,0.15)" : "transparent",
                      color: viewMode === m ? "#A89FF8" : "#505068",
                    }}
                  >
                    {m === "grid" ? <LayoutGrid size={14} /> : <List size={14} />}
                  </button>
                ))}
              </div>
              <PrimaryBtn icon={<Upload size={13} />} small onClick={() => router.push("/upload")}>Upload</PrimaryBtn>
            </div>
          }
        />

        {/* Action error banner (download / copy failures) */}
        {actionError && (
          <div
            className="flex items-center gap-2 px-6 py-2 text-xs"
            style={{ background: "rgba(239,68,68,0.08)", borderBottom: "1px solid rgba(239,68,68,0.2)", color: "#FC8181" }}
          >
            <span className="flex-1">{actionError}</span>
            <button onClick={() => setActionError(null)} style={{ color: "#FC8181" }}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* Bulk toolbar */}
        {selected.length > 0 && (
          <div
            className="flex items-center gap-2 px-6 py-2"
            style={{ background: "rgba(109,94,246,0.08)", borderBottom: "1px solid rgba(109,94,246,0.15)" }}
          >
            <span className="text-xs" style={{ color: "#A89FF8" }}>
              {selected.length} selected
            </span>
            <button
              onClick={handleBulkDelete}
              disabled={deleteMedia.isPending}
              className="ml-auto text-xs px-3 py-1 rounded-lg disabled:opacity-50"
              style={{ background: "rgba(239,68,68,0.1)", color: "#FC8181" }}
            >
              Delete{selected.length > 1 ? ` ${selected.length}` : ""}
            </button>
            <button onClick={() => setSelected([])} className="ml-1" style={{ color: "#505068" }}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="text-center py-20 text-sm" style={{ color: "#8080A0" }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-sm" style={{ color: "#8080A0" }}>
              No media yet. Upload your first file to get started.
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {filtered.map((f) => {
                const sel = selected.includes(f.id);
                return (
                  <div
                    key={f.id}
                    className="group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-150"
                    style={{
                      background: "#15151C",
                      border: sel ? "1px solid rgba(109,94,246,0.5)" : "1px solid rgba(255,255,255,0.07)",
                      boxShadow: sel ? "0 0 0 2px rgba(109,94,246,0.2)" : "none",
                    }}
                    onClick={() => setDrawerFile(f)}
                  >
                    {/* Checkbox */}
                    <div
                      className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); toggleSelect(f.id); }}
                    >
                      <div
                        className="w-5 h-5 rounded-md flex items-center justify-center"
                        style={{
                          background: sel ? "#6D5EF6" : "rgba(0,0,0,0.6)",
                          border: sel ? "none" : "1px solid rgba(255,255,255,0.3)",
                        }}
                      >
                        {sel && <span className="text-white text-[10px]">✓</span>}
                      </div>
                    </div>

                    {/* Thumbnail */}
                    <div className="relative" style={{ aspectRatio: "16/10" }}>
                      <MediaThumb id={f.id} name={f.name} type={f.type} brightness />

                      {f.type === "video" && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.55)" }}>
                            <Play size={12} fill="white" className="text-white ml-0.5" />
                          </div>
                        </div>
                      )}
                      {f.duration && (
                        <span
                          className="absolute bottom-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded font-mono"
                          style={{ background: "rgba(0,0,0,0.7)", color: "#EEEEF5" }}
                        >
                          {f.duration}
                        </span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-2.5">
                      <p className="text-xs font-medium truncate mb-1" style={{ color: "#EEEEF5" }}>{f.name}</p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <TypeChip type={f.type} />
                          <span className="text-[10px]" style={{ color: "#505068" }}>{f.size}</span>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg"
                          style={{ color: "#606080" }}
                          onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === f.id ? null : f.id); }}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </div>
                      {/* Tags */}
                      {f.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {f.tags.slice(0,2).map((t) => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(109,94,246,0.1)", color: "#8080A0" }}>
                              {t}
                            </span>
                          ))}
                          {f.tags.length > 2 && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: "#505068" }}>+{f.tags.length - 2}</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Context menu */}
                    {menuOpen === f.id && (
                      <div
                        className="absolute bottom-10 right-2 z-20 rounded-xl py-1 min-w-[140px]"
                        style={{ background: "#1A1A26", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}
                      >
                        {[
                          { icon: <Download size={12} />, label: "Download", action: () => download(f), disabled: false },
                          { icon: <Link size={12} />, label: copiedId === f.id ? "Copied!" : "Copy URL", action: () => copyUrl(f), disabled: false },
                          { icon: <Trash2 size={12} />, label: "Delete", action: () => handleDelete(f.id), danger: true },
                        ].map(({ icon, label, action, danger, disabled }) => (
                          <button
                            key={label}
                            disabled={disabled}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left disabled:opacity-40"
                            style={{ color: danger ? "#FC8181" : "#BBBBD0" }}
                            onClick={(e) => { e.stopPropagation(); setMenuOpen(null); action(); }}
                            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)")}
                            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                          >
                            {icon}{label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* List view */
            <div
              className="rounded-2xl overflow-hidden"
              style={{ border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#15151C" }}>
                    <th className="text-left px-4 py-3" style={{ color: "#404058", fontWeight: 500 }}>Name</th>
                    <th className="text-left px-4 py-3 hidden sm:table-cell" style={{ color: "#404058", fontWeight: 500 }}>Type</th>
                    <th className="text-left px-4 py-3 hidden md:table-cell" style={{ color: "#404058", fontWeight: 500 }}>Size</th>
                    <th className="text-left px-4 py-3 hidden lg:table-cell" style={{ color: "#404058", fontWeight: 500 }}>Tags</th>
                    <th className="px-4 py-3" style={{ color: "#404058", fontWeight: 500 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f, i) => (
                    <tr
                      key={f.id}
                      className="cursor-pointer transition-colors"
                      style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                      onClick={() => setDrawerFile(f)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: "#1E1E28" }}>
                            <MediaThumb id={f.id} name={f.name} type={f.type} size={14} />
                          </div>
                          <span className="font-medium truncate max-w-[160px]" style={{ color: "#EEEEF5" }}>{f.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell"><TypeChip type={f.type} /></td>
                      <td className="px-4 py-3 hidden md:table-cell" style={{ color: "#606080" }}>{f.size}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="flex gap-1 flex-wrap">
                          {f.tags.slice(0,3).map((t) => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(109,94,246,0.1)", color: "#8080A0" }}>{t}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button className="p-1.5 rounded-lg transition-colors disabled:opacity-40" style={{ color: "#505068" }}
                            title="Download"
                            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EEEEF5")}
                            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                            onClick={(e) => { e.stopPropagation(); download(f); }}>
                            <Download size={13} />
                          </button>
                          <button className="p-1.5 rounded-lg transition-colors" style={{ color: "#505068" }}
                            title="Delete"
                            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#FC8181")}
                            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                            onClick={(e) => { e.stopPropagation(); handleDelete(f.id); }}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Infinite-scroll sentinel: loads the next page when scrolled near. */}
          {hasNextPage && (
            <div ref={loadMoreRef} className="py-6 text-center text-xs" style={{ color: "#505068" }}>
              {isFetchingNextPage ? "Loading more…" : ""}
            </div>
          )}
        </div>
      </div>

      {/* ── Detail Drawer ─────────────────────────────── */}
      {drawerFile && (
        <aside
          className="flex flex-col flex-shrink-0 overflow-y-auto"
          style={{
            width: 320,
            borderLeft: "1px solid rgba(255,255,255,0.07)",
            background: "#0F0F14",
          }}
        >
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <span className="text-xs font-medium" style={{ color: "#EEEEF5" }}>Details</span>
            <button onClick={() => setDrawerFile(null)} style={{ color: "#505068" }}>
              <X size={15} />
            </button>
          </div>

          {/* Preview */}
          <div className="p-3">
            {drawerFile.thumb ? (
              <div className="rounded-xl overflow-hidden relative" style={{ aspectRatio: "16/9" }}>
                <img src={drawerFile.thumb} alt="" className="w-full h-full object-cover" />
                {drawerFile.type === "video" && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
                      <Play size={18} fill="white" className="ml-1 text-white" />
                    </div>
                    {drawerFile.duration && (
                      <span
                        className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded font-mono"
                        style={{ background: "rgba(0,0,0,0.7)", color: "#EEEEF5" }}
                      >
                        {drawerFile.duration}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl overflow-hidden relative" style={{ aspectRatio: "16/9" }}>
                <MediaThumb id={drawerFile.id} name={drawerFile.name} type={drawerFile.type} size={36} />
                {drawerFile.type === "video" && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
                      <Play size={18} fill="white" className="ml-1 text-white" />
                    </div>
                    {drawerFile.duration && (
                      <span
                        className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded font-mono"
                        style={{ background: "rgba(0,0,0,0.7)", color: "#EEEEF5" }}
                      >
                        {drawerFile.duration}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Metadata */}
          <div className="px-4 pb-4 flex flex-col gap-4">
            <div>
              <p className="text-sm font-medium mb-0.5" style={{ color: "#EEEEF5" }}>{drawerFile.name}</p>
              <TypeChip type={drawerFile.type} />
            </div>

            <table className="w-full text-xs">
              <tbody>
                {([
                  ["Size",    drawerFile.size],
                  ["Bucket",  drawerFile.bucketName || "—"],
                  ["Key",     drawerFile.keyName || drawerFile.name],
                  ["Added",   drawerFile.added],
                  ...(drawerFile.duration ? [["Duration", drawerFile.duration]] : []),
                  ...(drawerFile.width && drawerFile.height
                    ? [["Dimensions", `${drawerFile.width} × ${drawerFile.height}`]]
                    : []),
                ] as [string, string][]).map(([k, v]) => (
                  <tr key={k}>
                    <td className="py-1 pr-3" style={{ color: "#404058" }}>{k}</td>
                    <td className="py-1 font-mono" style={{ color: "#8080A0", wordBreak: "break-all" }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Tags */}
            <div>
              <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: "#404058" }}>Tags</p>
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                {drawerFile.tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(109,94,246,0.12)", color: "#A89FF8", border: "1px solid rgba(109,94,246,0.2)" }}>
                    {t}
                    <button
                      onClick={() => applyTags(drawerFile, drawerFile.tags.filter((x) => x !== t))}
                      title="Remove tag"
                      style={{ display: "flex" }}
                    >
                      <X size={9} />
                    </button>
                  </span>
                ))}
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addTag(drawerFile); }}
                  onBlur={() => addTag(drawerFile)}
                  placeholder="+ Add tag"
                  className="text-xs px-2 py-0.5 rounded-full outline-none"
                  style={{ background: "rgba(255,255,255,0.05)", color: "#A89FF8", border: "1px solid rgba(255,255,255,0.08)", width: 90 }}
                />
              </div>
            </div>

            {/* Categories */}
            {allCategories.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: "#404058" }}>Categories</p>
                <div className="flex flex-wrap gap-1.5">
                  {allCategories.map((c) => {
                    const on = drawerFile.categories.includes(c.name);
                    return (
                      <button
                        key={c.id}
                        onClick={() => toggleCategory(drawerFile, c.name)}
                        className="text-xs px-2 py-0.5 rounded-full transition-colors"
                        style={{
                          background: on ? "rgba(78,205,196,0.14)" : "rgba(255,255,255,0.04)",
                          color: on ? "#4ECDC4" : "#606080",
                          border: on ? "1px solid rgba(78,205,196,0.3)" : "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => download(drawerFile)}
                className="flex items-center gap-2 w-full text-xs px-3 py-2 rounded-xl transition-colors disabled:opacity-40"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "#BBBBD0" }}
              >
                <Download size={12} /> Download
              </button>
              <button
                onClick={() => copyUrl(drawerFile)}
                className="flex items-center gap-2 w-full text-xs px-3 py-2 rounded-xl transition-colors disabled:opacity-40"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "#BBBBD0" }}
              >
                <Link size={12} /> {copiedId === drawerFile.id ? "Copied!" : "Copy presigned URL"}
              </button>
              <button
                onClick={() => handleDelete(drawerFile.id)}
                className="flex items-center gap-2 w-full text-xs px-3 py-2 rounded-xl transition-colors"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#FC8181" }}
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
