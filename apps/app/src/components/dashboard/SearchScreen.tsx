"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Play, FileText, Box, Filter } from "lucide-react";
import { PageHeader } from "./DashboardShell";
import { useInfiniteSearch } from "@/hooks/useSearch";
import { useThumbnail } from "@/hooks/useMedia";
import { formatBytes, kindFromMime } from "@/lib/format";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

const TYPE_OPTS = ["Video", "Image", "Audio", "PDF", "3D"];
const SIZE_OPTS = ["< 10 MB", "10–100 MB", "100 MB–1 GB", "> 1 GB"];
const DATE_OPTS = ["Today", "This week", "This month", "This year"];

function matchesSize(bytes: number, label: string): boolean {
  const MB = 1e6, GB = 1e9;
  switch (label) {
    case "< 10 MB":      return bytes < 10 * MB;
    case "10–100 MB":    return bytes >= 10 * MB && bytes < 100 * MB;
    case "100 MB–1 GB":  return bytes >= 100 * MB && bytes < GB;
    case "> 1 GB":       return bytes >= GB;
    default:             return false;
  }
}

function matchesDate(iso: string, label: string): boolean {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  const ageDays = (Date.now() - t) / 86_400_000;
  switch (label) {
    case "Today":      return ageDays < 1;
    case "This week":  return ageDays < 7;
    case "This month": return ageDays < 31;
    case "This year":  return ageDays < 366;
    default:           return false;
  }
}

function highlight(text: string, query: string) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "rgba(109,94,246,0.3)", color: "#A89FF8", borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function SearchThumb({ id, type }: { id: string; type: string }) {
  const { data: url } = useThumbnail(id);
  if (url) {
    return <img src={url} alt="" className="w-full h-full object-cover" />;
  }
  return (
    <div className="w-full h-full flex items-center justify-center" style={{ background: "#1E1E28" }}>
      {type === "pdf" ? <FileText size={16} style={{ color: "#FC8181" }} />
        : type === "3d"  ? <Box size={16} style={{ color: "#4ECDC4" }} />
        : <Play size={16} style={{ color: "#A89FF8" }} />}
    </div>
  );
}

export function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  const debouncedQuery = useDebounced(query, 300);

  // Hold facet option lists from the previous render in refs so we can
  // compute serverFilters before the useInfiniteSearch call (avoiding a
  // circular dependency between hook input and output).
  const prevTagOpts = useRef<string[]>([]);
  const prevCategoryOpts = useRef<string[]>([]);
  const prevSetOpts = useRef<string[]>([]);
  const prevStoryboardOpts = useRef<string[]>([]);
  const prevTypeOpts = useRef<string[]>([]);

  // Push Type + Tag + Category + Set facets to the server (kind / tags /
  // categories / sets params) so filtering spans the whole result set.
  // Size/Date stay client-side (they're derived buckets). §10.2
  const serverFilters: Record<string, string> = (() => {
    const filters: Record<string, string> = {};
    const selectedType = activeFilters.find((f) => prevTypeOpts.current.includes(f));
    if (selectedType) filters.type = selectedType.toLowerCase();
    const selectedTags = activeFilters.filter((f) => prevTagOpts.current.includes(f));
    if (selectedTags.length) filters.tags = selectedTags.join(",");
    const selectedCategories = activeFilters.filter((f) => prevCategoryOpts.current.includes(f));
    if (selectedCategories.length) filters.categories = selectedCategories.join(",");
    const selectedSets = activeFilters.filter((f) => prevSetOpts.current.includes(f));
    if (selectedSets.length) filters.sets = selectedSets.join(",");
    const selectedStoryboards = activeFilters.filter((f) => prevStoryboardOpts.current.includes(f));
    if (selectedStoryboards.length) filters.storyboards = selectedStoryboards.join(",");
    return filters;
  })();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteSearch(debouncedQuery, serverFilters);

  // Derive current facet option lists (with counts) from the latest API response.
  const facetsFirstPage = data?.pages?.[0]?.facets;
  const apiTypeOpts = facetsFirstPage?.types ?? [];
  const typeOpts = apiTypeOpts.length > 0 ? apiTypeOpts : TYPE_OPTS.map((t) => ({ key: t, count: 0 }));
  const tagOpts = facetsFirstPage?.tags ?? [];
  const categoryOpts = facetsFirstPage?.categories ?? [];
  const setOpts = facetsFirstPage?.sets ?? [];
  const storyboardOpts = facetsFirstPage?.storyboards ?? [];

  // Store keys for the next render cycle so serverFilters can resolve.
  prevTypeOpts.current = typeOpts.map((t) => t.key);
  prevTagOpts.current = tagOpts.map((t) => t.key);
  prevCategoryOpts.current = categoryOpts.map((c) => c.key);
  prevSetOpts.current = setOpts.map((s) => s.key);
  prevStoryboardOpts.current = storyboardOpts.map((s) => s.key);

  function toggleFilter(f: string) {
    setActiveFilters((a) => a.includes(f) ? a.filter((x) => x !== f) : [...a, f]);
  }

  const allMedia = data?.pages.flatMap((p) => p.media) ?? [];
  const dataTotal = data?.pages[0]?.total ?? 0;
  const allResults = allMedia.map((m) => ({
    id: m.id,
    name: m.filename,
    size: formatBytes(m.size),
    sizeBytes: m.size,
    createdAt: m.createdAt,
    type: kindFromMime(m.mimeType),
    tags: m.tags ?? [],
    thumb: m.thumbnailUrl as string | undefined,
  }));

  // IntersectionObserver for infinite scroll
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) fetchNextPage(); },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, fetchNextPage]);

  // A result passes when, for every facet group that has a selection, it matches
  // at least one selected option in that group (AND across groups, OR within).
  function passesFilters(r: (typeof allResults)[number]): boolean {
    // Type + Tags are already applied server-side (serverFilters); only Size and
    // Date are filtered client-side here.
    const sel = (opts: string[]) => activeFilters.filter((f) => opts.includes(f));
    const sizeSel = sel(SIZE_OPTS);
    const dateSel = sel(DATE_OPTS);
    if (sizeSel.length && !sizeSel.some((f) => matchesSize(r.sizeBytes, f))) return false;
    if (dateSel.length && !dateSel.some((f) => matchesDate(r.createdAt, f))) return false;
    return true;
  }

  const results = allResults.filter(passesFilters);

  const FACETS = [
    { group: "Type", options: typeOpts },
    { group: "Tags", options: tagOpts },
    { group: "Categories", options: categoryOpts },
    { group: "Sets", options: setOpts },
    { group: "Storyboards", options: storyboardOpts },
    { group: "Size", options: SIZE_OPTS.map((s) => ({ key: s, count: 0 })) },
    { group: "Date", options: DATE_OPTS.map((d) => ({ key: d, count: 0 })) },
  ];

  return (
    <div className="flex h-full overflow-hidden">
      {/* Filter rail */}
      <aside
        className="hidden lg:flex flex-col flex-shrink-0 overflow-y-auto py-4"
        style={{ width: 200, borderRight: "1px solid rgba(255,255,255,0.06)", paddingLeft: 12, paddingRight: 12 }}
      >
        {FACETS.filter((f) => f.options.length > 0).map((facet) => (
          <div key={facet.group} className="mb-5">
            <p className="text-[10px] uppercase tracking-widest mb-2 px-1" style={{ color: "#404058" }}>
              {facet.group}
            </p>
            {facet.options.map((opt) => {
              const on = activeFilters.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  onClick={() => toggleFilter(opt.key)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 rounded-lg mb-0.5 text-xs text-left transition-colors"
                  style={{
                    background: on ? "rgba(109,94,246,0.1)" : "transparent",
                    color: on ? "#A89FF8" : "#606080",
                  }}
                >
                  <span
                    className="w-2 h-2 rounded-sm flex-shrink-0"
                    style={{ background: on ? "#6D5EF6" : "rgba(255,255,255,0.12)" }}
                  />
                  <span className="flex-1 truncate">{opt.key}</span>
                  {opt.count > 0 && (
                    <span className="text-[9px] opacity-50" style={{ color: "#505068" }}>
                      {opt.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Results */}
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader title="Search" breadcrumb={["my-studio"]} />

        <div className="px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          {/* Search bar */}
          <div
            className="flex items-center gap-2 px-4 py-3 rounded-2xl mb-3"
            style={{ background: "#15151C", border: "1px solid rgba(109,94,246,0.3)" }}
          >
            <Search size={15} style={{ color: "#6D5EF6", flexShrink: 0 }} />
            <input
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: "#EEEEF5" }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files, tags, metadata…"
              autoFocus
            />
            {query && (
              <button onClick={() => setQuery("")} style={{ color: "#505068" }}>
                <X size={14} />
              </button>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "#404058" }}>⌘K</span>
          </div>

          {/* Active filter pills */}
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {activeFilters.map((f) => (
                <span
                  key={f}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full cursor-pointer"
                  style={{ background: "rgba(109,94,246,0.12)", color: "#A89FF8", border: "1px solid rgba(109,94,246,0.2)" }}
                  onClick={() => toggleFilter(f)}
                >
                  <Filter size={10} />{f}<X size={10} />
                </span>
              ))}
              <button
                onClick={() => setActiveFilters([])}
                className="text-xs px-2 py-1 rounded-full"
                style={{ color: "#505068" }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {query && results.length > 0 && (
            <p className="text-xs mb-4" style={{ color: "#505068" }}>
              {results.length} of {dataTotal} result{dataTotal !== 1 ? "s" : ""} for{" "}
              <span style={{ color: "#A89FF8" }}>"{query}"</span>
            </p>
          )}

          {results.length === 0 && query && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Search size={32} style={{ color: "#303048", marginBottom: 16 }} />
              <p className="text-sm font-medium mb-2" style={{ color: "#EEEEF5" }}>No results for "{query}"</p>
              <p className="text-xs" style={{ color: "#505068" }}>Try a different query or clear your filters</p>
            </div>
          )}

          {!query && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Search size={32} style={{ color: "#303048", marginBottom: 16 }} />
              <p className="text-sm font-medium mb-2" style={{ color: "#EEEEF5" }}>Search your entire library</p>
              <p className="text-xs" style={{ color: "#505068" }}>Filenames, tags, codecs, metadata, bucket paths</p>
            </div>
          )}

          <div
            className="rounded-2xl overflow-hidden"
            style={{ border: results.length > 0 ? "1px solid rgba(255,255,255,0.07)" : "none" }}
          >
            {results.map((r, i) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                className="flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors"
                style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none", background: "#15151C" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(109,94,246,0.05)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "#15151C")}
                onClick={() => router.push(`/media/${r.id}`)}
                onKeyDown={(e) => { if (e.key === "Enter") router.push(`/media/${r.id}`); }}
              >
                {/* Thumb */}
                <div className="w-14 h-9 rounded-lg overflow-hidden flex-shrink-0 relative">
                  <SearchThumb id={r.id} type={r.type} />
                  {r.type === "video" && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Play size={10} fill="white" style={{ color: "white" }} />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium mb-0.5" style={{ color: "#EEEEF5" }}>
                    {highlight(r.name, query)}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[9px] px-1.5 py-0.5 rounded-full"
                        style={{ background: "rgba(109,94,246,0.1)", color: "#8080A0" }}
                      >
                        {highlight(t, query)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-4 flex-shrink-0">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
                    style={{ background: "rgba(109,94,246,0.1)", color: "#A89FF8", border: "1px solid rgba(109,94,246,0.2)" }}
                  >
                    {r.type}
                  </span>
                  <span className="text-xs hidden sm:block" style={{ color: "#505068" }}>{r.size}</span>
                </div>
              </div>
            ))}
            <div ref={sentinelRef} />
          </div>
          {isFetchingNextPage && (
            <p className="text-xs text-center py-3" style={{ color: "#505068" }}>Loading more results…</p>
          )}
        </div>
      </div>
    </div>
  );
}
