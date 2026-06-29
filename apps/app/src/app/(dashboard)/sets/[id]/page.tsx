"use client";

import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Layers, Plus, Wand2, Trash2,
  Search, X, Play, Volume2, FileText, Box, Check, Loader2, ChevronDown,
} from "lucide-react";
import { useSet, useDeleteSet, useAddSetItem, useRemoveSetItem, useGenerateVariants } from "@/hooks/useSets";
import { useBuckets } from "@/hooks/useBuckets";
import { useInfiniteMedia, useThumbnail } from "@/hooks/useMedia";
import { useInfiniteSearch } from "@/hooks/useSearch";
import { formatSize, mediaKind, extLabel } from "@/lib/format";

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

function FileIcon({ mimeType, size = 28 }: { mimeType: string; size?: number }) {
  const kind = mediaKind(mimeType);
  return kind === "audio" ? <Volume2 size={size} style={{ color: C.amber, opacity: 0.55 }} />
    : kind === "pdf" ? <FileText size={size} style={{ color: C.red, opacity: 0.55 }} />
    : kind === "3d" ? <Box size={size} style={{ color: C.teal, opacity: 0.55 }} />
    : <FileText size={size} style={{ color: C.muted4, opacity: 0.4 }} />;
}

function SetThumb({ id, mimeType, className }: { id: string; mimeType: string; className?: string }) {
  const { data: url } = useThumbnail(id);
  if (url) {
    return <img src={url} alt="" className={className} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  }
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <FileIcon mimeType={mimeType} size={22} />
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────── */
export default function SetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: set, isLoading } = useSet(id);
  const deleteSet = useDeleteSet();
  const addItem = useAddSetItem();
  const removeItem = useRemoveSetItem();
  const generateVariants = useGenerateVariants();

  const { data: buckets = [] } = useBuckets();
  const [bucketId, setBucketId] = useState("");
  const activeBucket = buckets.find((b) => b.id === bucketId) ?? buckets[0];

  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showBucketPicker, setShowBucketPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Two data sources for the "add items" pool:
  //  • a query → org-wide server search across ALL buckets (P2.59)
  //  • no query → browse the selected bucket's objects, paginated
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
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [targetAspect, setTargetAspect] = useState("");
  const [targetWidth, setTargetWidth] = useState("");
  const [targetHeight, setTargetHeight] = useState("");
  const [targetRole, setTargetRole] = useState("");

  useEffect(() => {
    if (!bucketId && buckets.length > 0) setBucketId(buckets[0]!.id);
  }, [bucketId, buckets]);

  const items = set?.items ?? [];
  const currentIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  // When searching, the server already matched the query across all buckets, so
  // only de-dupe against items already in the set. When browsing, also apply a
  // light client-side filename/ext filter on top of the bucket page.
  const filteredPool = useMemo(() => {
    const pool = allMedia.filter((m) => !currentIds.has(m.id));
    if (searching) return pool;
    return pool;
  }, [allMedia, currentIds, searching]);

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400, color: C.muted2, fontSize: 14 }}>
        Loading…
      </div>
    );
  }

  if (!set) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 12 }}>
        <Layers size={40} style={{ color: C.muted4, opacity: 0.4 }} />
        <p style={{ fontSize: 14, color: C.muted2 }}>Set not found.</p>
        <button onClick={() => router.push("/sets")} style={{ fontSize: 13, color: C.violet, background: "none", border: "none", cursor: "pointer" }}>
          ← Back to Sets
        </button>
      </div>
    );
  }

  async function handleAddItems() {
    const targets: Record<string, string | number> = {};
    if (targetAspect) targets.aspectRatio = targetAspect;
    if (targetWidth) targets.width = Number(targetWidth);
    if (targetHeight) targets.height = Number(targetHeight);
    if (targetRole) targets.role = targetRole;
    await Promise.all(
      selectedToAdd.map((mediaId) => addItem.mutateAsync({ setId: id, mediaId, targets: Object.keys(targets).length > 0 ? targets : undefined })),
    );
    setSelectedToAdd([]);
    setShowAddPanel(false);
    setSearchQuery("");
    setTargetAspect("");
    setTargetWidth("");
    setTargetHeight("");
    setTargetRole("");
  }

  async function handleDelete() {
    await deleteSet.mutateAsync(id);
    router.push("/sets");
  }

  function toggleAddSelection(mediaId: string) {
    setSelectedToAdd((s) => (s.includes(mediaId) ? s.filter((x) => x !== mediaId) : [...s, mediaId]));
  }

  const generating = generateVariants.isPending;

  return (
    <div style={{ padding: "24px 28px 80px", maxWidth: 1060, margin: "0 auto", color: C.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Back */}
      <button
        onClick={() => router.push("/sets")}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted2, background: "none", border: "none", cursor: "pointer", marginBottom: 22, padding: 0, transition: "color 0.15s" }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = C.text)}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = C.muted2)}
      >
        <ArrowLeft size={14} />
        Back to Sets
      </button>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: confirmDelete ? 16 : 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div
            style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: "rgba(109,94,246,0.13)", border: `1px solid ${C.violetBord}`,
              display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2,
            }}
          >
            <Layers size={20} style={{ color: C.violet }} />
          </div>

          <div>
            <p style={{ fontSize: 11, color: C.muted4, marginBottom: 4, letterSpacing: "0.01em" }}>
              my-studio / Organize / Sets
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em", color: C.text, margin: 0, lineHeight: 1.3 }}>
                {set.name}
              </h1>
              <span style={{ fontSize: 11, color: C.muted3, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>
                {set.variantCount} {set.variantCount === 1 ? "variant" : "variants"}
              </span>
            </div>
            {set.description && (
              <p style={{ fontSize: 13, color: C.muted2, marginTop: 4, lineHeight: 1.5 }}>{set.description}</p>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 2 }}>
          <button
            onClick={() => { setShowAddPanel((v) => !v); setSelectedToAdd([]); setSearchQuery(""); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 12, fontSize: 13, fontWeight: 600, color: "#fff", background: showAddPanel ? "#5B4EE0" : C.violet, border: "none", cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#5B4EE0")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = showAddPanel ? "#5B4EE0" : C.violet)}
          >
            <Plus size={14} />
            Add items
          </button>

          <button
            onClick={() => generateVariants.mutate(id)}
            disabled={generating}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 12, fontSize: 13, fontWeight: 500, color: generating ? C.muted3 : "#BBBBD0", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", cursor: generating ? "default" : "pointer", transition: "background 0.15s, color 0.15s", minWidth: 152, justifyContent: "center" }}
            onMouseEnter={(e) => { if (!generating) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.09)"; }}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)")}
          >
            {generating
              ? <><Loader2 size={14} style={{ animation: "ml-spin 1s linear infinite" }} />Generating…</>
              : <><Wand2 size={14} />Generate variants</>}
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

      <style>{`@keyframes ml-spin { to { transform: rotate(360deg); } }`}</style>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "14px 18px", borderRadius: 14, marginBottom: 20, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.28)" }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: C.red, marginBottom: 2 }}>Delete this set? This can&apos;t be undone.</p>
            <p style={{ fontSize: 12, color: C.muted2 }}>
              “{set.name}” and its {items.length} item {items.length === 1 ? "reference" : "references"} will be removed. Files in your library are not deleted.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button onClick={() => setConfirmDelete(false)} disabled={deleteSet.isPending} style={{ padding: "7px 14px", borderRadius: 10, fontSize: 13, fontWeight: 500, color: "#BBBBD0", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleteSet.isPending} style={{ padding: "7px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#fff", background: C.redDark, border: "none", cursor: deleteSet.isPending ? "default" : "pointer", opacity: deleteSet.isPending ? 0.7 : 1 }}>
              {deleteSet.isPending ? "Deleting…" : "Delete set"}
            </button>
          </div>
        </div>
      )}

      {/* Add Items panel */}
      {showAddPanel && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 12px", borderBottom: `1px solid ${C.border}` }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Add items to set</p>
              <button onClick={() => { setShowAddPanel(false); setSelectedToAdd([]); setSearchQuery(""); }} style={{ color: C.muted3, background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>
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
                    <ChevronDown size={10} style={{ marginLeft: "auto" }} />
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
                  <Search size={24} style={{ opacity: 0.35, display: "block", margin: "0 auto 8px" }} />
                  <p style={{ fontSize: 13 }}>{activeBucket ? "No media found." : "No buckets yet."}</p>
                </div>
              ) : (
                filteredPool.map((item) => {
                  const sel = selectedToAdd.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggleAddSelection(item.id)}
                      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "8px 10px", borderRadius: 10, marginBottom: 2, background: sel ? C.violetDim : "transparent", border: sel ? `1px solid ${C.violetBord}` : "1px solid transparent", cursor: "pointer", textAlign: "left", transition: "background 0.12s, border-color 0.12s" }}
                      onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                      onMouseLeave={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, overflow: "hidden", background: C.panelAlt }}>
                        <SetThumb id={item.id} mimeType={item.mimeType} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 500, color: sel ? C.violetText : C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {item.filename}
                        </p>
                        <p style={{ fontSize: 11, color: C.muted3, marginTop: 1 }}>
                          {formatSize(item.size)} · {extLabel(item.mimeType)}
                        </p>
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
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <p style={{ fontSize: 12, color: C.muted2 }}>
                    {selectedToAdd.length} {selectedToAdd.length === 1 ? "item" : "items"} selected
                  </p>
                  <select
                    value={targetAspect}
                    onChange={(e) => setTargetAspect(e.target.value)}
                    title="Target aspect ratio for generated variants"
                    style={{ fontSize: 12, padding: "5px 8px", borderRadius: 8, background: C.panelAlt, color: C.violet, border: `1px solid ${C.border}` }}
                  >
                    <option value="">Aspect: any</option>
                    {["16:9", "9:16", "4:3", "1:1", "3:2", "21:9"].map((r) => (
                      <option key={r} value={r} style={{ background: C.panelAlt }}>{r}</option>
                    ))}
                  </select>
                  <input
                    value={targetWidth}
                    onChange={(e) => setTargetWidth(e.target.value)}
                    placeholder="Width"
                    type="number"
                    style={{ width: 70, fontSize: 12, padding: "5px 8px", borderRadius: 8, background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`, outline: "none" }}
                  />
                  <input
                    value={targetHeight}
                    onChange={(e) => setTargetHeight(e.target.value)}
                    placeholder="Height"
                    type="number"
                    style={{ width: 70, fontSize: 12, padding: "5px 8px", borderRadius: 8, background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`, outline: "none" }}
                  />
                  <input
                    value={targetRole}
                    onChange={(e) => setTargetRole(e.target.value)}
                    placeholder="Role (e.g. hero, variant)"
                    style={{ width: 160, fontSize: 12, padding: "5px 8px", borderRadius: 8, background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`, outline: "none" }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    onClick={handleAddItems}
                    disabled={addItem.isPending}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#fff", background: C.violet, border: "none", cursor: addItem.isPending ? "default" : "pointer", opacity: addItem.isPending ? 0.7 : 1, transition: "background 0.15s" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = C.violetHov)}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = C.violet)}
                  >
                    <Plus size={13} />
                    {addItem.isPending ? "Adding…" : `Add ${selectedToAdd.length} ${selectedToAdd.length === 1 ? "item" : "items"}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Set Items grid */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.muted4 }}>Set Items</p>
          <p style={{ fontSize: 12, color: C.muted3 }}>{items.length} {items.length === 1 ? "file" : "files"}</p>
        </div>

        {items.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "72px 24px", gap: 12, textAlign: "center" }}>
            <Layers size={44} style={{ color: C.muted4, opacity: 0.3 }} />
            <p style={{ fontSize: 14, fontWeight: 500, color: C.muted2, marginTop: 4 }}>No items in this set yet.</p>
            <p style={{ fontSize: 12, color: C.muted3 }}>
              Click <strong style={{ color: C.muted2 }}>Add items</strong> above to add media from your library.
            </p>
          </div>
        ) : (
          <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
            {items.map((item) => {
              const hovered = hoveredItem === item.id;
              return (
                <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 6 }} onMouseEnter={() => setHoveredItem(item.id)} onMouseLeave={() => setHoveredItem(null)}>
                  <div
                    style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 12, overflow: "hidden", cursor: "pointer", background: C.panelAlt, border: hovered ? "1px solid rgba(255,255,255,0.13)" : `1px solid ${C.border}`, transition: "border-color 0.15s" }}
                    onClick={() => router.push(`/media/${item.id}`)}
                  >
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      <SetThumb id={item.id} mimeType={item.mimeType} />
                    </div>

                    {mediaKind(item.mimeType) === "video" && (
                      <div style={{ position: "absolute", bottom: 7, right: 7, width: 24, height: 24, borderRadius: "50%", background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Play size={10} fill="#EEEEF5" style={{ color: "#EEEEF5", marginLeft: 1 }} />
                      </div>
                    )}

                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem.mutate({ setId: id, itemId: item.setItemId }); }}
                      style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(11,11,15,0.72)", backdropFilter: "blur(4px)", border: "1px solid rgba(255,255,255,0.12)", color: hovered ? C.red : C.muted2, cursor: "pointer", opacity: hovered ? 1 : 0, transition: "opacity 0.15s, color 0.15s" }}
                    >
                      <X size={11} />
                    </button>
                  </div>

                  <p style={{ fontSize: 11, color: C.muted2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 1, lineHeight: 1.4 }} title={item.filename}>
                    {item.filename}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
