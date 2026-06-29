"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Tag, FolderTree, Layers, Film, Plus, ArrowRight, Trash2, CornerDownRight,
} from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn } from "./DashboardShell";
import { useSets, useCreateSet, useGenerateVariants } from "@/hooks/useSets";
import { useStoryboards } from "@/hooks/useStoryboards";
import { useTags, useCreateTag, useDeleteTag } from "@/hooks/useTags";
import { useCategories, useCreateCategory, useDeleteCategory } from "@/hooks/useCategories";
import type { Category } from "@/lib/api";

type OrgTab = "tags" | "categories" | "sets" | "storyboards";

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#505068" }}
      >
        {icon}
      </div>
      <p className="text-sm font-medium mb-1" style={{ color: "#EEEEF5" }}>{title}</p>
      <p className="text-xs max-w-sm" style={{ color: "#606080" }}>{body}</p>
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  background: "#15151C",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#EEEEF5",
};

function TagsManager() {
  const { data: tags = [], isLoading } = useTags();
  const createTag = useCreateTag();
  const deleteTag = useDeleteTag();
  const [name, setName] = useState("");

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createTag.mutate(trimmed, { onSuccess: () => setName("") });
  };

  return (
    <div className="max-w-xl">
      <div className="flex gap-2 mb-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New tag name…"
          className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
          style={INPUT_STYLE}
        />
        <PrimaryBtn icon={<Plus size={13} />} small onClick={add} disabled={createTag.isPending || !name.trim()}>
          Add tag
        </PrimaryBtn>
      </div>

      {isLoading ? (
        <p className="text-sm py-10 text-center" style={{ color: "#8080A0" }}>Loading tags…</p>
      ) : tags.length === 0 ? (
        <EmptyState icon={<Tag size={20} />} title="No tags yet" body="Create a tag above, then apply it to media from the Library detail panel." />
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
          {tags.map((t, i) => (
            <div
              key={t.id}
              className="flex items-center gap-3 px-4 py-2.5"
              style={{ background: "#15151C", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none" }}
            >
              <Tag size={13} style={{ color: "#A89FF8" }} />
              <span className="text-sm flex-1 truncate" style={{ color: "#EEEEF5" }}>{t.name}</span>
              <span className="text-xs font-mono" style={{ color: "#505068" }}>{t.objectCount} file{t.objectCount !== 1 ? "s" : ""}</span>
              <button
                onClick={() => deleteTag.mutate(t.id)}
                disabled={deleteTag.isPending}
                title="Delete tag"
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: "#606080" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#F87171")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#606080")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoriesManager() {
  const { data: categories = [], isLoading } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");

  // Flatten the tree (depth-first) for both the parent <select> and the listing.
  const flat: { cat: Category; depth: number }[] = [];
  const walk = (cats: Category[], depth: number) => {
    for (const cat of cats) {
      flat.push({ cat, depth });
      if (cat.children.length) walk(cat.children, depth + 1);
    }
  };
  walk(categories, 0);

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createCategory.mutate(
      { name: trimmed, parentId: parentId || undefined },
      { onSuccess: () => setName("") },
    );
  };

  return (
    <div className="max-w-xl">
      <div className="flex gap-2 mb-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New category name…"
          className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
          style={INPUT_STYLE}
        />
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="px-3 py-2 rounded-xl text-sm outline-none"
          style={INPUT_STYLE}
        >
          <option value="">Top level</option>
          {flat.map(({ cat, depth }) => (
            <option key={cat.id} value={cat.id}>{`${"— ".repeat(depth)}${cat.name}`}</option>
          ))}
        </select>
        <PrimaryBtn icon={<Plus size={13} />} small onClick={add} disabled={createCategory.isPending || !name.trim()}>
          Add
        </PrimaryBtn>
      </div>

      {isLoading ? (
        <p className="text-sm py-10 text-center" style={{ color: "#8080A0" }}>Loading categories…</p>
      ) : flat.length === 0 ? (
        <EmptyState icon={<FolderTree size={20} />} title="No categories yet" body="Create a category above. Nest categories by choosing a parent." />
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
          {flat.map(({ cat, depth }, i) => (
            <div
              key={cat.id}
              className="flex items-center gap-2 px-4 py-2.5"
              style={{ background: "#15151C", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none", paddingLeft: 16 + depth * 20 }}
            >
              {depth > 0 ? <CornerDownRight size={12} style={{ color: "#404058" }} /> : <FolderTree size={13} style={{ color: "#A89FF8" }} />}
              <span className="text-sm flex-1 truncate" style={{ color: "#EEEEF5" }}>{cat.name}</span>
              <span className="text-xs font-mono" style={{ color: "#505068" }}>{cat.objectCount} file{cat.objectCount !== 1 ? "s" : ""}</span>
              <button
                onClick={() => deleteCategory.mutate(cat.id)}
                disabled={deleteCategory.isPending}
                title="Delete category (children are moved to top level)"
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: "#606080" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#F87171")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#606080")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OrganizeScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<OrgTab>("sets");

  const { data: sets = [], isLoading: setsLoading } = useSets();
  const createSet = useCreateSet();
  const generateVariants = useGenerateVariants();
  const { data: storyboards = [], isLoading: sbLoading } = useStoryboards();

  const [showCreateSet, setShowCreateSet] = useState(false);
  const [newSetName, setNewSetName] = useState("");
  const [newSetDescription, setNewSetDescription] = useState("");
  const [setCreateError, setSetCreateError] = useState<string | null>(null);

  function handleCreateSet() {
    const trimmed = newSetName.trim();
    if (!trimmed) return;
    setSetCreateError(null);
    createSet.mutate(
      { name: trimmed, description: newSetDescription.trim() || undefined },
      {
        onSuccess: () => {
          setShowCreateSet(false);
          setNewSetName("");
          setNewSetDescription("");
        },
        onError: (err) => setSetCreateError((err as Error).message),
      },
    );
  }

  return (
    <div>
      <PageHeader
        title="Organize"
        breadcrumb={["my-studio"]}
        action={
          tab === "storyboards" ? (
            <PrimaryBtn icon={<Plus size={13} />} small onClick={() => router.push("/storyboards")}>New storyboard</PrimaryBtn>
          ) : tab === "sets" ? (
            <PrimaryBtn icon={<Plus size={13} />} small onClick={() => setShowCreateSet(true)}>New set</PrimaryBtn>
          ) : undefined
        }
      />

      {/* Tabs */}
      <div
        className="flex gap-1 px-6 py-3"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        {(["sets", "storyboards", "tags", "categories"] as OrgTab[]).map((t) => {
          const icons: Record<OrgTab, React.ReactNode> = {
            tags:        <Tag size={13} />,
            categories:  <FolderTree size={13} />,
            sets:        <Layers size={13} />,
            storyboards: <Film size={13} />,
          };
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all"
              style={{
                background: tab === t ? "rgba(109,94,246,0.15)" : "transparent",
                color: tab === t ? "#A89FF8" : "#606080",
                border: tab === t ? "1px solid rgba(109,94,246,0.25)" : "1px solid transparent",
              }}
            >
              {icons[t]}{t}
            </button>
          );
        })}
      </div>

      <div className="p-5 max-w-4xl">
        {/* ── Sets ──────────────────────────────────── */}
        {tab === "sets" && (
          setsLoading ? (
            <p className="text-sm py-10 text-center" style={{ color: "#8080A0" }}>Loading sets…</p>
          ) : sets.length === 0 ? (
            <EmptyState
              icon={<Layers size={20} />}
              title="No sets yet"
              body="Group a base asset with its rendered variants into a set, then generate aspect-ratio variants from it."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {sets.map((set) => (
                <div
                  key={set.id}
                  className="rounded-2xl p-5 flex items-center gap-3"
                  style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}
                >
                  {/* Body opens the set detail page; the action button stays a sibling
                      (a <button> nested inside an <a> is invalid). */}
                  <Link
                    href={`/sets/${set.id}`}
                    className="flex items-center gap-3 flex-1 min-w-0 transition-colors rounded-lg -m-1 p-1"
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(109,94,246,0.05)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <div className="w-16 h-9 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: "#1E1E28" }}>
                      <Layers size={16} style={{ color: "#505068" }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "#EEEEF5" }}>{set.name}</p>
                      <p className="text-xs truncate" style={{ color: "#606080" }}>
                        {set.variantCount} variant{set.variantCount !== 1 ? "s" : ""}
                        {set.description ? ` · ${set.description}` : ""}
                      </p>
                    </div>
                    <ArrowRight size={13} className="flex-shrink-0" style={{ color: "#404058" }} />
                  </Link>
                  <GhostBtn
                    icon={<Plus size={13} />}
                    small
                    onClick={() => generateVariants.mutate(set.id)}
                  >
                    Generate variants
                  </GhostBtn>
                </div>
              ))}
            </div>
          )
        )}

        {/* ── Storyboards ────────────────────────────── */}
        {tab === "storyboards" && (
          sbLoading ? (
            <p className="text-sm py-10 text-center" style={{ color: "#8080A0" }}>Loading storyboards…</p>
          ) : storyboards.length === 0 ? (
            <EmptyState
              icon={<Film size={20} />}
              title="No storyboards yet"
              body="Sequence clips into a storyboard to plan edits and review order."
            />
          ) : (
            <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
              {storyboards.map((sb, i) => (
                <Link
                  key={sb.id}
                  href={`/storyboards/${sb.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors"
                  style={{
                    background: "#15151C",
                    borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none",
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(109,94,246,0.05)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "#15151C")}
                >
                  <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={{ background: "rgba(109,94,246,0.15)", color: "#A89FF8" }}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color: "#EEEEF5" }}>{sb.name}</p>
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: "#606080" }}>{sb.description || "No description"}</p>
                  </div>
                  <span className="text-xs font-mono flex-shrink-0" style={{ color: "#505068" }}>{sb.clipCount} clips</span>
                  <ArrowRight size={13} style={{ color: "#404058" }} />
                </Link>
              ))}
            </div>
          )
        )}

        {/* ── Tags ───────────────────────────────────── */}
        {tab === "tags" && <TagsManager />}

        {/* ── Categories ─────────────────────────────── */}
        {tab === "categories" && <CategoriesManager />}
      </div>

      {/* ── Create set dialog ─────────────────────── */}
      {showCreateSet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => { setShowCreateSet(false); setNewSetName(""); setNewSetDescription(""); setSetCreateError(null); }}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-md relative"
            style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold mb-1" style={{ letterSpacing: "-0.02em" }}>Create set</h2>
            <p className="text-xs mb-5" style={{ color: "#8080A0" }}>
              A set groups a base asset with its rendered variants. You can add media to the set after creation.
            </p>

            <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Name</label>
            <input
              autoFocus
              value={newSetName}
              onChange={(e) => { setNewSetName(e.target.value); setSetCreateError(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleCreateSet()}
              placeholder="e.g. Hero assets v2"
              className="w-full px-3 py-2.5 rounded-xl text-sm outline-none mb-3"
              style={{
                background: "#1E1E28",
                border: setCreateError ? "1px solid rgba(239,68,68,0.5)" : "1px solid rgba(255,255,255,0.1)",
                color: "#EEEEF5",
              }}
            />

            <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Description (optional)</label>
            <input
              value={newSetDescription}
              onChange={(e) => setNewSetDescription(e.target.value)}
              placeholder="Brief description…"
              className="w-full px-3 py-2.5 rounded-xl text-sm outline-none mb-4"
              style={{
                background: "#1E1E28",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#EEEEF5",
              }}
            />

            {setCreateError && (
              <p className="text-xs mb-3" style={{ color: "#FC8181" }}>{setCreateError}</p>
            )}

            <div className="flex gap-2 justify-end">
              <GhostBtn small onClick={() => { setShowCreateSet(false); setNewSetName(""); setNewSetDescription(""); setSetCreateError(null); }}>Cancel</GhostBtn>
              <PrimaryBtn small onClick={handleCreateSet} disabled={createSet.isPending || !newSetName.trim()}>
                {createSet.isPending ? "Creating…" : "Create set"}
              </PrimaryBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
