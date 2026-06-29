"use client";

import { useState } from "react";
import Link from "next/link";
import { useStoryboards, useCreateStoryboard, useDeleteStoryboard } from "@/hooks/useStoryboards";
import { Film, Plus, Trash2, Image as ImageIcon, ArrowRight } from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn } from "@/components/dashboard/DashboardShell";

export default function StoryboardsPage() {
  const { data: storyboards = [], isLoading } = useStoryboards();
  const createStoryboard = useCreateStoryboard();
  const deleteStoryboard = useDeleteStoryboard();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const handleCreate = async () => {
    if (!newName.trim() || createStoryboard.isPending) return;
    await createStoryboard.mutateAsync({ name: newName, description: newDesc });
    setNewName("");
    setNewDesc("");
    setShowCreate(false);
  };

  return (
    <div>
      <PageHeader
        title="Storyboards"
        breadcrumb={["my-studio"]}
        action={
          <PrimaryBtn icon={<Plus size={13} />} small onClick={() => setShowCreate(true)}>
            New storyboard
          </PrimaryBtn>
        }
      />

      <div className="p-5 max-w-4xl flex flex-col gap-5">
        {isLoading ? (
          <p className="text-sm py-10 text-center" style={{ color: "#8080A0" }}>Loading…</p>
        ) : storyboards.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-20">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#505068" }}
            >
              <Film size={20} />
            </div>
            <p className="text-sm font-medium mb-1" style={{ color: "#EEEEF5" }}>No storyboards yet</p>
            <p className="text-xs" style={{ color: "#606080" }}>Create one to organize clip sequences.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {storyboards.map((sb) => (
              <div
                key={sb.id}
                className="group rounded-2xl p-5 transition-all"
                style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "rgba(109,94,246,0.3)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.07)")}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(109,94,246,0.12)" }}>
                      <Film size={16} style={{ color: "#A89FF8" }} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate" style={{ color: "#EEEEF5" }}>{sb.name}</h3>
                      {sb.description && (
                        <p className="text-xs mt-0.5 truncate" style={{ color: "#606080" }}>{sb.description}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteStoryboard.mutate(sb.id)}
                    className="p-1.5 rounded-lg transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
                    style={{ color: "#505068" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#FC8181")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                    title="Delete storyboard"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs" style={{ color: "#606080" }}>
                    <span className="flex items-center gap-1">
                      <ImageIcon size={12} />{sb.clipCount} clips
                    </span>
                    <span>{new Date(sb.createdAt).toLocaleDateString()}</span>
                  </div>
                  <Link href={`/storyboards/${sb.id}`} className="flex items-center gap-1 text-xs" style={{ color: "#A89FF8" }}>
                    Open <ArrowRight size={12} />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowCreate(false)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-md"
            style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold mb-5" style={{ letterSpacing: "-0.02em" }}>New storyboard</h2>
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Name</label>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                  placeholder="e.g. Launch reel v1"
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                  style={{ background: "#1E1E28", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Description</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="A sequence for… (optional)"
                  rows={2}
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none resize-none"
                  style={{ background: "#1E1E28", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <GhostBtn small onClick={() => setShowCreate(false)}>Cancel</GhostBtn>
              <PrimaryBtn small onClick={handleCreate}>{createStoryboard.isPending ? "Creating…" : "Create"}</PrimaryBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
