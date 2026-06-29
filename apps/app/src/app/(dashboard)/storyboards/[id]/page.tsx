"use client";

import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Film, Plus, Trash2,
  Search, X, Check, ChevronUp, ChevronDown,
  ChevronRight, Play, Volume2, FileText, Box,
} from "lucide-react";
import {
  useStoryboard, useDeleteStoryboard, useAddClip, useRemoveClip, useReorderClips,
} from "@/hooks/useStoryboards";
import { useBuckets } from "@/hooks/useBuckets";
import { useInfiniteMedia, useThumbnail } from "@/hooks/useMedia";
import { useInfiniteSearch } from "@/hooks/useSearch";
import { mediaKind, extLabel } from "@/lib/format";

/* ─── Design tokens ─────────────────────────────────── */
const C = {
  panel: "#15151C",
  panelAlt: "#1E1E28",
  border: "rgba(255,255,255,0.07)",
  text: "#EEEEF5",
  muted2: "#606080",
  muted3: "#505068",
  muted4: "#404058",
  violet: "#6D5EF6",
  violetHov: "#5B4EE0",
  violetDim: "rgba(109,94,246,0.12)",
  violetBord: "rgba(109,94,246,0.25)",
  violetText: "#A89FF8",
  amber: "#F59E0B",
  red: "#FC8181",
  redDark: "#EF4444",
  teal: "#4ECDC4",
};

/* ─── Helpers ────────────────────────────────────────── */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function FileTypeIcon({ mimeType, size = 24 }: { mimeType: string; size?: number }) {
  const kind = mediaKind(mimeType);
  if (kind === "audio") return <Volume2 size={size} style={{ color: C.amber, opacity: 0.5 }} />;
  if (kind === "pdf") return <FileText size={size} style={{ color: C.red, opacity: 0.5 }} />;
  if (kind === "3d") return <Box size={size} style={{ color: C.teal, opacity: 0.5 }} />;
  return <Film size={size} style={{ color: C.muted4, opacity: 0.35 }} />;
}

function ClipThumb({ id, mimeType, size = 14 }: { id: string; mimeType: string; size?: number }) {
  const { data: url } = useThumbnail(id);
  if (url) {
    return <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  }
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <FileTypeIcon mimeType={mimeType} size={size} />
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────── */
export default function StoryboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: sb, isLoading } = useStoryboard(id);
  const deleteStoryboard = useDeleteStoryboard();
  const addClip = useAddClip();
  const removeClip = useRemoveClip();
  const reorderClips = useReorderClips();

  const { data: buckets = [] } = useBuckets();
  const [bucketId, setBucketId] = useState("");
  const activeBucket = buckets.find((b) => b.id === bucketId) ?? buckets[0];

  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showBucketPicker, setShowBucketPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // A query runs an org-wide server search across ALL buckets (P2.59); with no
  // query we browse the selected bucket's objects, paginated.
  const debouncedQuery = useDebounced(searchQuery.trim(), 300);
  const searching = debouncedQuery.length > 0;

  const browse = useInfiniteMedia(activeBucket?.id ?? "");
  const search = useInfiniteSearch(debouncedQuery);

  const allMedia = useMemo(
    () =>
      searching
        ? (search.data?.pages.flatMap((p) => p.media) ?? [])
        : (browse.data?.pages.flatMap((p) => p.data) ?? []),
    [searching, search.data, browse.data],
  );
  const fetchNextPage = searching ? search.fetchNextPage : browse.fetchNextPage;
  const hasNextPage = searching ? search.hasNextPage : browse.hasNextPage;
  const isFetchingNextPage = searching ? search.isFetchingNextPage : browse.isFetchingNextPage;
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]); // media IDs
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hoveredClip, setHoveredClip] = useState<string | null>(null);

  useEffect(() => {
    if (!bucketId && buckets.length > 0) setBucketId(buckets[0]!.id);
  }, [bucketId, buckets]);

  const sortedClips = useMemo(
    () => [...(sb?.clips ?? [])].sort((a, b) => a.order - b.order),
    [sb],
  );

  // Storyboards may repeat clips, so the pool is the full library (not de-duped).
  // When searching, the server already matched the query across all buckets.
  const filteredPool = allMedia;

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400, color: C.muted2, fontSize: 14 }}>
        Loading…
      </div>
    );
  }

  if (!sb) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 12 }}>
        <Film size={40} style={{ color: C.muted4, opacity: 0.35 }} />
        <p style={{ fontSize: 14, color: C.muted2 }}>Storyboard not found.</p>
        <button onClick={() => router.push("/storyboards")} style={{ fontSize: 13, color: C.violet, background: "none", border: "none", cursor: "pointer" }}>
          ← Back to Storyboards
        </button>
      </div>
    );
  }

  async function handleAddClips() {
    const maxOrder = sortedClips.length > 0 ? Math.max(...sortedClips.map((c) => c.order)) : 0;
    await Promise.all(
      selectedToAdd.map((mediaId, i) =>
        addClip.mutateAsync({ storyboardId: id, mediaId, order: maxOrder + i + 1 }),
      ),
    );
    setSelectedToAdd([]);
    setShowAddPanel(false);
    setSearchQuery("");
  }

  async function handleDelete() {
    await deleteStoryboard.mutateAsync(id);
    router.push("/storyboards");
  }

  function moveClip(clipId: string, dir: "up" | "down") {
    const idx = sortedClips.findIndex((c) => c.id === clipId);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortedClips.length) return;
    const reordered = [...sortedClips];
    const tmp = reordered[idx]!;
    reordered[idx] = reordered[swapIdx]!;
    reordered[swapIdx] = tmp;
    reorderClips.mutate({ storyboardId: id, clipIds: reordered.map((c) => c.id) });
  }

  return (
    <div style={{ padding: "24px 28px 80px", maxWidth: 1060, margin: "0 auto", color: C.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Back */}
      <button
        onClick={() => router.push("/storyboards")}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted2, background: "none", border: "none", cursor: "pointer", marginBottom: 22, padding: 0, transition: "color 0.15s" }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = C.text)}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = C.muted2)}
      >
        <ArrowLeft size={14} />
        Back to Storyboards
      </button>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: confirmDelete ? 16 : 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: "rgba(109,94,246,0.13)", border: `1px solid ${C.violetBord}`, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
            <Film size={20} style={{ color: C.violet }} />
          </div>
          <div>
            <p style={{ fontSize: 11, color: C.muted4, marginBottom: 4, letterSpacing: "0.01em" }}>
              my-studio / Organize / Storyboards
            </p>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em", color: C.text, margin: 0, lineHeight: 1.3 }}>
              {sb.name}
            </h1>
            {sb.description && (
              <p style={{ fontSize: 13, color: C.muted2, marginTop: 4, lineHeight: 1.5 }}>{sb.description}</p>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 2 }}>
          <button
            onClick={() => { setShowAddPanel((v) => !v); setSelectedToAdd([]); setSearchQuery(""); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 12, fontSize: 13, fontWeight: 600, color: "#fff", background: showAddPanel ? C.violetHov : C.violet, border: "none", cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = C.violetHov)}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = showAddPanel ? C.violetHov : C.violet)}
          >
            <Plus size={14} />
            Add clips
          </button>

          <button
            onClick={() => setConfirmDelete(true)}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 12, color: C.red, background: "rgba(252,129,129,0.07)", border: "1px solid rgba(252,129,129,0.18)", cursor: "pointer", transition: "background 0.15s, border-color 0.15s" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(252,129,129,0.13)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(252,129,129,0.32)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(252,129,129,0.07)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(252,129,129,0.18)"; }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "14px 18px", borderRadius: 14, marginBottom: 20, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.28)" }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: C.red, marginBottom: 2 }}>Delete this storyboard? This can&apos;t be undone.</p>
            <p style={{ fontSize: 12, color: C.muted2 }}>
              “{sb.name}” will be removed. Media files in your library are not affected.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button onClick={() => setConfirmDelete(false)} disabled={deleteStoryboard.isPending} style={{ padding: "7px 14px", borderRadius: 10, fontSize: 13, fontWeight: 500, color: "#BBBBD0", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleteStoryboard.isPending} style={{ padding: "7px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#fff", background: C.redDark, border: "none", cursor: deleteStoryboard.isPending ? "default" : "pointer", opacity: deleteStoryboard.isPending ? 0.7 : 1 }}>
              {deleteStoryboard.isPending ? "Deleting…" : "Delete storyboard"}
            </button>
          </div>
        </div>
      )}

      {/* Add Clips panel */}
      {showAddPanel && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 12px", borderBottom: `1px solid ${C.border}` }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Add clips to storyboard</p>
              <button onClick={() => { setShowAddPanel(false); setSelectedToAdd([]); setSearchQuery(""); }} style={{ color: C.muted3, background: "none", border: "none", cursor: "pointer" }}>
                <X size={15} />
              </button>
            </div>

            <div style={{ padding: "12px 16px 0" }}>
              {buckets.length > 1 && (
                <div className="relative mb-2">
                  <button
                    onClick={() => setShowBucketPicker(!showBucketPicker)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: C.muted2 }}
                  >
                    <span>Bucket: <span style={{ color: C.violet }}>{activeBucket?.name ?? "All"}</span></span>
                    <button style={{ color: C.muted3, marginLeft: "auto", background: "none", border: "none", cursor: "pointer" }}>▾</button>
                  </button>
                  {showBucketPicker && (
                    <div
                      className="absolute z-20 w-full mt-1 rounded-xl py-1 overflow-hidden"
                      style={{ background: "#1A1A26", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}
                    >
                      {buckets.map((b) => (
                        <button
                          key={b.id}
                          onClick={() => { setBucketId(b.id); setShowBucketPicker(false); }}
                          className="w-full text-left px-3 py-1.5 text-xs font-mono transition-colors"
                          style={{ color: b.id === activeBucket?.id ? C.violetText : C.muted2 }}
                          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)")}
                          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                        >
                          {b.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: C.panelAlt, border: "1px solid rgba(255,255,255,0.09)" }}>
                <Search size={13} style={{ color: C.muted3, flexShrink: 0 }} />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search media to add…"
                  style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 13, color: C.text, fontFamily: "inherit" }}
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} style={{ color: C.muted3, background: "none", border: "none", cursor: "pointer" }}>
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            <div style={{ overflowY: "auto", maxHeight: 300, padding: "8px 8px 0" }}>
              {filteredPool.length === 0 ? (
                <div style={{ textAlign: "center", padding: "28px 0", color: C.muted3 }}>
                  <p style={{ fontSize: 13 }}>{activeBucket ? "No media found." : "No buckets yet."}</p>
                </div>
              ) : (
                filteredPool.map((item) => {
                  const sel = selectedToAdd.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelectedToAdd((s) => (sel ? s.filter((x) => x !== item.id) : [...s, item.id]))}
                      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "8px 10px", borderRadius: 10, marginBottom: 2, background: sel ? C.violetDim : "transparent", border: sel ? `1px solid ${C.violetBord}` : "1px solid transparent", cursor: "pointer", textAlign: "left", transition: "background 0.12s, border-color 0.12s" }}
                      onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                      onMouseLeave={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <div style={{ width: 48, height: 27, borderRadius: 6, flexShrink: 0, overflow: "hidden", background: C.panelAlt }}>
                        <ClipThumb id={item.id} mimeType={item.mimeType} size={14} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 500, color: sel ? C.violetText : C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {item.filename}
                        </p>
                        <p style={{ fontSize: 11, color: C.muted3, marginTop: 1 }}>{extLabel(item.mimeType)}</p>
                      </div>
                      {sel && (
                        <div style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, background: C.violet, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Check size={12} style={{ color: "#fff" }} />
                        </div>
                      )}
                    </button>
                  );
                })
              )}
              {hasNextPage && (
                <div style={{ textAlign: "center", padding: "8px 0 12px" }}>
                  <button
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                    style={{ fontSize: 12, color: C.violet, background: "none", border: "none", cursor: isFetchingNextPage ? "default" : "pointer", opacity: isFetchingNextPage ? 0.6 : 1, fontWeight: 500, padding: "4px 12px", borderRadius: 8 }}
                    onMouseEnter={(e) => { if (!isFetchingNextPage) (e.currentTarget as HTMLElement).style.background = C.violetDim; }}
                    onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = "none"}
                  >
                    {isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </div>

            {selectedToAdd.length > 0 && (
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <p style={{ fontSize: 12, color: C.muted2 }}>
                  {selectedToAdd.length} {selectedToAdd.length === 1 ? "clip" : "clips"} selected
                </p>
                <button
                  onClick={handleAddClips}
                  disabled={addClip.isPending}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#fff", background: C.violet, border: "none", cursor: addClip.isPending ? "default" : "pointer", opacity: addClip.isPending ? 0.7 : 1, transition: "background 0.15s" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = C.violetHov)}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = C.violet)}
                >
                  <Plus size={13} />
                  {addClip.isPending ? "Adding…" : `Add ${selectedToAdd.length} ${selectedToAdd.length === 1 ? "clip" : "clips"}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Timeline card */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.muted4 }}>Timeline</p>
          <p style={{ fontSize: 12, color: C.muted3 }}>{sortedClips.length} {sortedClips.length === 1 ? "clip" : "clips"}</p>
        </div>

        {sortedClips.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "72px 24px", gap: 12, textAlign: "center" }}>
            <Film size={44} style={{ color: C.muted4, opacity: 0.28 }} />
            <p style={{ fontSize: 14, fontWeight: 500, color: C.muted2, marginTop: 4 }}>No clips yet.</p>
            <p style={{ fontSize: 12, color: C.muted3 }}>
              Click <strong style={{ color: C.muted2 }}>Add clips</strong> above to build your storyboard.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto", overflowY: "visible", padding: "20px 20px 24px", display: "flex", alignItems: "flex-start", gap: 0, scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}>
            {sortedClips.map((clip, idx) => {
              const isFirst = idx === 0;
              const isLast = idx === sortedClips.length - 1;
              const hovered = hoveredClip === clip.id;
              const kind = mediaKind(clip.media.mimeType);

              return (
                <div key={clip.id} style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>
                  <div
                    style={{ width: 144, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}
                    onMouseEnter={() => setHoveredClip(clip.id)}
                    onMouseLeave={() => setHoveredClip(null)}
                  >
                    {/* Reorder controls */}
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={() => moveClip(clip.id, "up")}
                        disabled={isFirst || reorderClips.isPending}
                        style={{ width: 26, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: isFirst ? "transparent" : "rgba(255,255,255,0.04)", border: isFirst ? "1px solid transparent" : "1px solid rgba(255,255,255,0.08)", color: isFirst ? C.muted4 : C.muted2, cursor: isFirst ? "default" : "pointer", transition: "background 0.12s, color 0.12s", opacity: isFirst ? 0.35 : 1 }}
                        onMouseEnter={(e) => { if (!isFirst) (e.currentTarget as HTMLElement).style.color = C.text; }}
                        onMouseLeave={(e) => { if (!isFirst) (e.currentTarget as HTMLElement).style.color = C.muted2; }}
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => moveClip(clip.id, "down")}
                        disabled={isLast || reorderClips.isPending}
                        style={{ width: 26, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: isLast ? "transparent" : "rgba(255,255,255,0.04)", border: isLast ? "1px solid transparent" : "1px solid rgba(255,255,255,0.08)", color: isLast ? C.muted4 : C.muted2, cursor: isLast ? "default" : "pointer", transition: "background 0.12s, color 0.12s", opacity: isLast ? 0.35 : 1 }}
                        onMouseEnter={(e) => { if (!isLast) (e.currentTarget as HTMLElement).style.color = C.text; }}
                        onMouseLeave={(e) => { if (!isLast) (e.currentTarget as HTMLElement).style.color = C.muted2; }}
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>

                    {/* 16:9 thumbnail tile */}
                    <div
                      onClick={() => router.push(`/media/${clip.media.id}`)}
                      style={{ width: 128, aspectRatio: "16 / 9", borderRadius: 8, overflow: "hidden", cursor: "pointer", background: C.panelAlt, border: hovered ? `2px solid ${C.violet}` : "2px solid rgba(255,255,255,0.09)", transition: "border-color 0.15s", position: "relative", flexShrink: 0 }}
                    >
                      <ClipThumb id={clip.media.id} mimeType={clip.media.mimeType} size={22} />
                      {kind === "video" && (
                        <div style={{ position: "absolute", bottom: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Play size={8} fill="#EEEEF5" style={{ color: "#EEEEF5", marginLeft: 1 }} />
                        </div>
                      )}
                    </div>

                    {/* Filename + order index */}
                    <div style={{ width: 128, textAlign: "center" }}>
                      <p style={{ fontSize: 11, color: hovered ? C.text : C.muted2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.4, transition: "color 0.15s" }} title={clip.media.filename}>
                        {clip.media.filename}
                      </p>
                      <p style={{ fontSize: 10, color: C.muted4, marginTop: 1 }}>#{clip.order}</p>
                    </div>

                    {/* Remove */}
                    <button
                      onClick={() => removeClip.mutate({ storyboardId: id, clipId: clip.id })}
                      style={{ width: 26, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: hovered ? C.red : C.muted4, cursor: "pointer", opacity: hovered ? 1 : 0, transition: "opacity 0.15s, color 0.15s, border-color 0.15s", border: hovered ? "1px solid rgba(252,129,129,0.22)" : "1px solid transparent", background: hovered ? "rgba(252,129,129,0.08)" : "transparent" }}
                    >
                      <X size={11} />
                    </button>
                  </div>

                  {/* Connector */}
                  {!isLast && (
                    <div style={{ display: "flex", alignItems: "center", paddingTop: 64, width: 28, flexShrink: 0, justifyContent: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                        <div style={{ width: 10, height: 1, background: "rgba(255,255,255,0.1)" }} />
                        <ChevronRight size={12} style={{ color: C.muted4, flexShrink: 0, marginLeft: -1 }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
