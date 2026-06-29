"use client";

import { useState } from "react";
import { Plus, Copy, RotateCcw, ShieldOff, X, Eye, EyeOff, Check, AlertTriangle } from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn, StatusBadge } from "./DashboardShell";
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useRotateApiKey } from "@/hooks/useApiKeys";
import { useBuckets } from "@/hooks/useBuckets";

const SCOPE_FALLBACK = { bg: "rgba(255,255,255,0.06)", color: "#8080A0" };

function keyStatus(expiresAt?: string): "active" | "warning" | "error" {
  if (!expiresAt) return "active";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "error";
  if (ms < 14 * 86400000) return "warning";
  return "active";
}

const SCOPE_COLORS: Record<string, { bg: string; color: string }> = {
  read:   { bg: "rgba(52,211,153,0.1)",  color: "#34D399" },
  write:  { bg: "rgba(109,94,246,0.12)", color: "#A89FF8" },
  delete: { bg: "rgba(245,158,11,0.1)",  color: "#F59E0B" },
  admin:  { bg: "rgba(239,68,68,0.1)",   color: "#FC8181" },
};

export function ApiKeysScreen() {
  const { data: rawKeys = [], isLoading } = useApiKeys();
  const { data: buckets = [] } = useBuckets();
  const createApiKey = useCreateApiKey();
  const revokeApiKey = useRevokeApiKey();
  const rotateApiKey = useRotateApiKey();

  const [showCreate, setShowCreate] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState<{ label: string; keyId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  // Create form state
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [expiry, setExpiry] = useState("90");
  const [bucketId, setBucketId] = useState("");

  const keys = rawKeys.map((k) => ({
    id: k.id,
    label: k.name,
    keyId: k.prefix,
    scopes: k.scopes,
    bucket: k.bucketScope ?? null,
    expiry: k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never",
    lastUsed: k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never",
    status: keyStatus(k.expiresAt),
  }));

  function handleCreate() {
    const days = parseInt(expiry, 10) || 90;
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    createApiKey.mutate(
      { name: label || "New API Key", scopes, expiresAt, bucketId: bucketId || undefined },
      {
        onSuccess: (res) => {
          setNewKeyResult({ label: res.key.name, keyId: res.key.prefix, secret: res.secret });
          setShowCreate(false);
          setLabel(""); setScopes(["read"]); setExpiry("90"); setBucketId("");
        },
      },
    );
  }

  function handleRotate(id: string) {
    rotateApiKey.mutate(id, {
      onSuccess: (res) =>
        setNewKeyResult({ label: res.key.name, keyId: res.key.prefix, secret: res.secret }),
    });
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        breadcrumb={["my-studio"]}
        action={
          <PrimaryBtn icon={<Plus size={13} />} small onClick={() => setShowCreate(true)}>
            Create key
          </PrimaryBtn>
        }
      />

      <div className="p-5">
        {/* "Shown once" success dialog */}
        {newKeyResult && (
          <div
            className="mb-5 rounded-2xl p-5"
            style={{ background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.2)" }}
          >
            <div className="flex items-start gap-3 mb-4">
              <Check size={18} style={{ color: "#34D399", marginTop: 2, flexShrink: 0 }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: "#34D399" }}>Key created — save the secret now</p>
                <p className="text-xs mt-0.5" style={{ color: "#8080A0" }}>
                  This is the only time the secret access key will be shown. Copy it somewhere safe before closing.
                </p>
              </div>
              <button onClick={() => setNewKeyResult(null)} style={{ color: "#505068", marginLeft: "auto" }}>
                <X size={15} />
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              {[
                { label: "Access Key ID",     value: newKeyResult.keyId,   display: newKeyResult.keyId,  mono: true  },
                // `display` is what's rendered (masked unless revealed); `value` is
                // always the real secret so the copy button never copies the dots. (P2)
                { label: "Secret Access Key", value: newKeyResult.secret, display: showSecret ? newKeyResult.secret : "••••••••••••••••••••••••••••••••••••••••", mono: true },
              ].map(({ label: l, value, display, mono }) => (
                <div key={l} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px]" style={{ color: "#606080" }}>{l}</p>
                    <div className="flex gap-1">
                      {l.includes("Secret") && (
                        <button onClick={() => setShowSecret(!showSecret)} style={{ color: "#505068" }}>
                          {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      )}
                      <button onClick={() => copy(value)} style={{ color: "#505068" }}>
                        {copied ? <Check size={12} style={{ color: "#34D399" }} /> : <Copy size={12} />}
                      </button>
                    </div>
                  </div>
                  <p
                    className="text-[11px] break-all"
                    style={{ fontFamily: mono ? "var(--font-mono)" : undefined, color: "#EEEEF5" }}
                  >
                    {display}
                  </p>
                </div>
              ))}
            </div>

            {/* Snippet */}
            <div
              className="rounded-xl p-4 text-[11px] leading-6"
              style={{ background: "#0F0F14", fontFamily: "var(--font-mono)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <p style={{ color: "#505068" }}># aws cli</p>
              <p><span style={{ color: "#A78BFA" }}>export</span> <span style={{ color: "#4ECDC4" }}>AWS_ACCESS_KEY_ID</span>=<span style={{ color: "#34D399" }}>{newKeyResult.keyId}</span></p>
              <p><span style={{ color: "#A78BFA" }}>export</span> <span style={{ color: "#4ECDC4" }}>AWS_SECRET_ACCESS_KEY</span>=<span style={{ color: "#34D399" }}>{"<your-secret>"}</span></p>
              <p><span style={{ color: "#A78BFA" }}>aws s3 ls</span> --endpoint-url <span style={{ color: "#34D399" }}>https://s3.{process.env.NEXT_PUBLIC_BASE_DOMAIN || "medialocker.io"}</span></p>
            </div>
          </div>
        )}

        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "#15151C", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                {["Label", "Key ID", "Scopes", "Bucket", "Expires", "Last used", "Status", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-3" style={{ color: "#404058", fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k, i) => (
                <tr
                  key={k.id}
                  className="transition-colors"
                  style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  <td className="px-4 py-3 font-medium" style={{ color: "#EEEEF5" }}>{k.label}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono" style={{ color: "#8080A0" }}>
                        {k.keyId.slice(0, 4)}••••••
                      </span>
                      <button
                        onClick={() => copy(k.keyId)}
                        className="transition-colors"
                        style={{ color: "#404058" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#6D5EF6")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#404058")}
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => {
                        const c = SCOPE_COLORS[s] ?? SCOPE_FALLBACK;
                        return (
                          <span key={s} className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide" style={{ background: c.bg, color: c.color }}>
                            {s}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono" style={{ color: k.bucket ? "#8080A0" : "#404058" }}>
                    {k.bucket ?? <span style={{ color: "#303048" }}>all buckets</span>}
                  </td>
                  <td className="px-4 py-3" style={{ color: k.status === "warning" ? "#F59E0B" : k.status === "error" ? "#FC8181" : "#606080" }}>
                    {k.status === "warning" && <AlertTriangle size={11} className="inline mr-1" />}
                    {k.expiry}
                  </td>
                  <td className="px-4 py-3" style={{ color: "#606080" }}>{k.lastUsed}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={k.status === "error" ? "error" : k.status === "warning" ? "warning" : "active"} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => handleRotate(k.id)} className="p-1.5 rounded-lg" style={{ color: "#505068" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EEEEF5")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                        title="Rotate key">
                        <RotateCcw size={13} />
                      </button>
                      <button onClick={() => revokeApiKey.mutate(k.id)} className="p-1.5 rounded-lg" style={{ color: "#505068" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#FC8181")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
                        title="Revoke key">
                        <ShieldOff size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(isLoading || keys.length === 0) && (
            <div className="px-4 py-10 text-center text-xs" style={{ color: "#606080" }}>
              {isLoading ? "Loading keys…" : "No API keys yet. Create one to get started."}
            </div>
          )}
        </div>
      </div>

      {/* ── Create key dialog ─────────────────────── */}
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
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold" style={{ letterSpacing: "-0.02em" }}>Create API key</h2>
              <button onClick={() => setShowCreate(false)} style={{ color: "#505068" }}><X size={15} /></button>
            </div>

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Label</label>
                <input
                  autoFocus
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. CI/CD pipeline"
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                  style={{ background: "#1E1E28", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
                />
              </div>
              <div>
                <label className="block text-xs mb-2" style={{ color: "#606080" }}>Permissions</label>
                <div className="flex flex-wrap gap-2">
                  {(["read","write","delete","admin"] as const).map((s) => {
                    const on = scopes.includes(s);
                    const c = SCOPE_COLORS[s] ?? SCOPE_FALLBACK;
                    return (
                      <button
                        key={s}
                        onClick={() => setScopes((sc) => on ? sc.filter((x) => x !== s) : [...sc, s])}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all"
                        style={{
                          background: on ? c.bg : "rgba(255,255,255,0.04)",
                          color: on ? c.color : "#606080",
                          border: on ? `1px solid ${c.color}40` : "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {on && <Check size={10} />}{s}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>
                  Bucket scope
                </label>
                <select
                  value={bucketId}
                  onChange={(e) => setBucketId(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none"
                  style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", color: "#A89FF8" }}
                >
                  <option value="" style={{ background: "#15151C" }}>All buckets</option>
                  {buckets.map((b) => (
                    <option key={b.id} value={b.id} style={{ background: "#15151C" }}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>
                  Expires after <span style={{ color: "#A89FF8" }}>{expiry} days</span>
                </label>
                <input
                  type="range" min={1} max={365} value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="w-full"
                  style={{ accentColor: "#6D5EF6" }}
                />
                <div className="flex justify-between text-[10px] mt-1" style={{ color: "#404058" }}>
                  <span>1 day</span><span>90 days</span><span>1 year</span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end mt-5">
              <GhostBtn small onClick={() => setShowCreate(false)}>Cancel</GhostBtn>
              <PrimaryBtn small onClick={handleCreate}>Create key</PrimaryBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
