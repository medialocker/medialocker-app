"use client";

import { useState } from "react";
import { Database, Plus, Trash2, Settings, ExternalLink, AlertTriangle, X, Check } from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn } from "./DashboardShell";
import { useBuckets, useCreateBucket, useDeleteBucket } from "@/hooks/useBuckets";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function validateBucketName(name: string): string | null {
  if (name.length < 3)  return "Name must be at least 3 characters";
  if (name.length > 63) return "Name must be 63 characters or fewer";
  if (!/^[a-z0-9]/.test(name))  return "Must start with a lowercase letter or number";
  if (!/^[a-z0-9-]+$/.test(name)) return "Only lowercase letters, numbers, and hyphens allowed";
  if (/--/.test(name))  return "Cannot contain consecutive hyphens";
  if (/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(name)) return "Cannot be formatted as an IP address";
  return null;
}

export function BucketsScreen() {
  const { data: rawBuckets = [], isLoading } = useBuckets();
  const createBucket = useCreateBucket();
  const deleteBucket = useDeleteBucket();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const buckets = rawBuckets.map((b) => ({
    id: b.id,
    name: b.name,
    objects: b.objectCount,
    size: formatBytes(b.totalSize),
    versioning: false,
    created: new Date(b.createdAt).toLocaleDateString(),
  }));

  function handleCreate() {
    const err = validateBucketName(newName);
    if (err) { setNameError(err); return; }
    createBucket.mutate(newName, {
      onSuccess: () => { setNewName(""); setShowCreate(false); setNameError(null); },
      onError: (e) => setNameError(e instanceof Error ? e.message : "Failed to create bucket"),
    });
  }

  function handleDelete(name: string) {
    const target = buckets.find((b) => b.name === name);
    if (target) deleteBucket.mutate(target.id);
    setDeleteTarget(null);
  }

  const deleteTargetData = buckets.find((b) => b.name === deleteTarget);
  const deleteIsEmpty = deleteTargetData?.objects === 0;

  return (
    <div>
      <PageHeader
        title="Buckets"
        breadcrumb={["my-studio"]}
        action={
          <PrimaryBtn icon={<Plus size={13} />} small onClick={() => setShowCreate(true)}>
            Create bucket
          </PrimaryBtn>
        }
      />

      <div className="p-5">
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "#15151C", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                {["Bucket", "Objects", "Size", "Versioning", "Created", ""].map((h) => (
                  <th
                    key={h}
                    className="text-left px-5 py-3"
                    style={{ color: "#404058", fontWeight: 500 }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr
                  key={b.name}
                  className="transition-colors"
                  style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Database size={13} style={{ color: "#6D5EF6", flexShrink: 0 }} />
                      <div>
                        <p className="font-medium" style={{ color: "#EEEEF5" }}>{b.name}</p>
                        <p className="text-[10px] font-mono" style={{ color: "#404058" }}>
                          {b.name}.s3.{process.env.NEXT_PUBLIC_BASE_DOMAIN || "medialocker.io"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3" style={{ color: "#8080A0" }}>
                    {b.objects.toLocaleString()}
                  </td>
                  <td className="px-5 py-3" style={{ color: "#8080A0" }}>{b.size}</td>
                  <td className="px-5 py-3">
                    {b.versioning ? (
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full" style={{ background: "rgba(52,211,153,0.1)", color: "#34D399", border: "1px solid rgba(52,211,153,0.2)" }}>
                        <Check size={9} />On
                      </span>
                    ) : (
                      <span className="text-[11px]" style={{ color: "#404058" }}>Off</span>
                    )}
                  </td>
                  <td className="px-5 py-3" style={{ color: "#606080" }}>{b.created}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button className="p-1.5 rounded-lg transition-colors" style={{ color: "#505068" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EEEEF5")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                        title="Open in library">
                        <ExternalLink size={13} />
                      </button>
                      <button className="p-1.5 rounded-lg transition-colors" style={{ color: "#505068" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EEEEF5")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                        title="Settings">
                        <Settings size={13} />
                      </button>
                      <button
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: "#505068" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#FC8181")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                        title="Delete"
                        onClick={() => setDeleteTarget(b.name)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(isLoading || buckets.length === 0) && (
            <div className="px-5 py-10 text-center text-xs" style={{ color: "#606080" }}>
              {isLoading ? "Loading buckets…" : "No buckets yet. Create your first bucket."}
            </div>
          )}
        </div>
      </div>

      {/* ── Create bucket dialog ──────────────────── */}
      {showCreate && (
        <Dialog onClose={() => { setShowCreate(false); setNewName(""); setNameError(null); }}>
          <h2 className="text-base font-bold mb-1" style={{ letterSpacing: "-0.02em" }}>Create bucket</h2>
          <p className="text-xs mb-5" style={{ color: "#8080A0" }}>
            Bucket names must be globally unique, DNS-safe, and 3–63 characters.
          </p>
          <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Bucket name</label>
          <input
            autoFocus
            value={newName}
            onChange={(e) => { setNewName(e.target.value.toLowerCase()); setNameError(validateBucketName(e.target.value.toLowerCase())); }}
            placeholder="e.g. my-project-assets"
            className="w-full px-3 py-2.5 rounded-xl text-sm font-mono outline-none mb-1"
            style={{
              background: "#1E1E28",
              border: nameError ? "1px solid rgba(239,68,68,0.5)" : "1px solid rgba(255,255,255,0.1)",
              color: "#EEEEF5",
            }}
          />
          {nameError
            ? <p className="text-xs mb-1" style={{ color: "#FC8181" }}>{nameError}</p>
            : newName && <p className="text-xs mb-1" style={{ color: "#34D399" }}>✓ Name is valid</p>
          }
          {newName && (
            <p className="text-[11px] mb-5 font-mono" style={{ color: "#404058" }}>
              Endpoint: <span style={{ color: "#A89FF8" }}>{newName}.s3.{process.env.NEXT_PUBLIC_BASE_DOMAIN || "medialocker.io"}</span>
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <GhostBtn small onClick={() => { setShowCreate(false); setNewName(""); setNameError(null); }}>Cancel</GhostBtn>
            <PrimaryBtn small onClick={handleCreate}>Create bucket</PrimaryBtn>
          </div>
        </Dialog>
      )}

      {/* ── Delete confirm dialog ──────────────────── */}
      {deleteTarget && (
        <Dialog onClose={() => setDeleteTarget(null)}>
          {!deleteIsEmpty ? (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <AlertTriangle size={18} style={{ color: "#EF4444" }} />
                </div>
                <div>
                  <h2 className="text-base font-bold" style={{ letterSpacing: "-0.02em" }}>Bucket not empty</h2>
                  <p className="text-xs" style={{ color: "#8080A0" }}>Cannot delete a non-empty bucket</p>
                </div>
              </div>
              <p className="text-sm mb-5" style={{ color: "#8080A0" }}>
                <span style={{ color: "#EEEEF5", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>{deleteTarget}</span>
                {" "}contains <strong style={{ color: "#EEEEF5" }}>{deleteTargetData?.objects.toLocaleString()} objects</strong>.
                Delete all objects in the library first, then retry.
              </p>
              <div className="flex justify-end">
                <GhostBtn small onClick={() => setDeleteTarget(null)}>Got it</GhostBtn>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-bold mb-3" style={{ letterSpacing: "-0.02em" }}>Delete bucket?</h2>
              <p className="text-sm mb-5" style={{ color: "#8080A0" }}>
                This will permanently delete <span style={{ color: "#EEEEF5", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>{deleteTarget}</span>. This cannot be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <GhostBtn small onClick={() => setDeleteTarget(null)}>Cancel</GhostBtn>
                <button
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold"
                  style={{ background: "rgba(239,68,68,0.15)", color: "#FC8181", border: "1px solid rgba(239,68,68,0.25)" }}
                  onClick={() => handleDelete(deleteTarget!)}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-md relative"
        style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4"
          style={{ color: "#505068" }}
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}
