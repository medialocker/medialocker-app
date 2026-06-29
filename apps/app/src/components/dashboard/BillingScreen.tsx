"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, ArrowUp, ArrowDown, AlertTriangle, X, Plus, Minus, Check } from "lucide-react";
import { PageHeader, PrimaryBtn, GhostBtn } from "./DashboardShell";
import {
  useBilling, useAddCapacity, useUpdateAutoCapacity, useDowngrade, usePortalSession, useBillingInvoices, usePlans,
} from "@/hooks/useBilling";
import { useUsageHistory } from "@/hooks/useUsage";

const GB = 1_000_000_000;

export function BillingScreen() {
  const router = useRouter();
  const { data } = useBilling();
  const { data: invoicesData } = useBillingInvoices();
  const { data: plans = [] } = usePlans();
  const addCapacity = useAddCapacity();
  const updateAutoCapacity = useUpdateAutoCapacity();
  const downgrade = useDowngrade();
  const portalSession = usePortalSession();
  const { data: historyData } = useUsageHistory();

  const [addGB, setAddGB]       = useState(100);
  const [autoCapacity, setAuto] = useState(true);
  const [autoGB, setAutoGB]     = useState(100);
  const [threshold, setThreshold] = useState(80);
  const [spendCap, setSpendCap] = useState("50");
  const [showDowngrade, setShowDowngrade] = useState(false);
  const [showUpgrade, setShowUpgrade]     = useState(false);
  const [downgradeTier, setDowngradeTier] = useState("");
  const [downgradeError, setDowngradeError] = useState<string | null>(null);
  const [downgradeOk, setDowngradeOk] = useState<string | null>(null);

  function submitDowngrade() {
    setDowngradeError(null);
    setDowngradeOk(null);
    downgrade.mutate(downgradeTier, {
      onSuccess: (res) => setDowngradeOk(res.message),
      onError: (err) => setDowngradeError((err as Error).message),
    });
  }

  const upgradePlan = useMemo(() => {
    if (!data || !plans.length) return null;
    const currentIncludedGb = Math.round((data.baseStorage ?? 0) / GB);
    const sorted = [...plans].sort((a, b) => a.includedGb - b.includedGb);
    return sorted.find((p) => p.includedGb > currentIncludedGb) ?? null;
  }, [data, plans, GB]);

  useEffect(() => {
    if (!downgradeTier) setDowngradeTier("starter");
  }, []);

  // Seed auto-capacity controls from the server once billing loads.
  useEffect(() => {
    if (!data) return;
    setAuto(data.autoCapacity);
    setAutoGB(data.autoCapacityConfig.increment);
    setThreshold(data.autoCapacityConfig.threshold);
    setSpendCap(String(data.autoCapacityConfig.maxSpend));
  }, [data]);

  const rate     = data?.overageRate ?? 0.022;
  const usedGB   = Math.round((data?.currentUsage ?? 0) / GB);
  const totalGB  = Math.max(1, Math.round((data?.baseStorage ?? 0) / GB));
  const planName = data?.plan ?? "—";
  const invoices = invoicesData ?? [];
  const history = (historyData ?? []).map((h) => ({
    date: new Date(h.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    storageGB: Math.round(h.storageBytes / GB),
    egressGB: Math.round(h.egressBytes / GB),
    requests: h.requests.toLocaleString(),
  }));
  const pct      = Math.min(100, Math.round((usedGB / totalGB) * 100));
  const addCost  = (addGB * rate).toFixed(2);
  // Real proration: charge for the days left in the actual Stripe billing period.
  // `data.renewsAt` is the subscription's current_period_end; Stripe monthly
  // periods are calendar-month aligned, so the period START is exactly one
  // calendar month earlier (not a fixed 30 days, which drifts in Feb / 31-day
  // months). Falls back to the current calendar month when there's no sub.
  const now = new Date();
  const periodEnd = data?.renewsAt ? new Date(data.renewsAt) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const periodStart = (() => {
    if (!data?.renewsAt) return new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(data.renewsAt);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    return start;
  })();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysInPeriod = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / MS_PER_DAY));
  const daysRemaining = Math.max(0, Math.round((periodEnd.getTime() - now.getTime()) / MS_PER_DAY));
  const proratedCost = ((addGB * rate) * (daysRemaining / daysInPeriod)).toFixed(2);
  const renewsLabel = data?.renewsAt
    ? new Date(data.renewsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  // Decimal TB for display (1 TB = 1000 GB), consistent everywhere on this screen.
  const totalTB = (totalGB / 1000).toFixed(totalGB >= 1000 ? 1 : 2);

  function persistAuto(next: Partial<{ enabled: boolean; increment: number; threshold: number; maxSpend: number }>) {
    updateAutoCapacity.mutate({
      enabled: next.enabled ?? autoCapacity,
      increment: next.increment ?? autoGB,
      threshold: next.threshold ?? threshold,
      maxSpend: next.maxSpend ?? (Number(spendCap) || 0),
    });
  }

  function openPortal() {
    portalSession.mutate(undefined, {
      onSuccess: (res) => { if (res.url) window.location.href = res.url; },
    });
  }

  return (
    <div>
      <PageHeader title="Billing & Capacity" breadcrumb={["my-studio"]} />
      <div className="p-5 max-w-4xl flex flex-col gap-5">

        {/* Current plan */}
        <div
          className="rounded-2xl p-5"
          style={{ background: "#15151C", border: "1px solid rgba(109,94,246,0.2)" }}
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "rgba(109,94,246,0.15)" }}>
                  <CreditCard size={15} style={{ color: "#6D5EF6" }} />
                </div>
                <div>
                  <p className="text-sm font-bold" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>{planName}</p>
                  <p className="text-xs" style={{ color: "#8080A0" }}>{totalTB} TB included</p>
                </div>
              </div>
              {(renewsLabel || data?.nextInvoiceAmount != null) && (
                <p className="text-xs" style={{ color: "#606080" }}>
                  {renewsLabel && <>Renews <span style={{ color: "#EEEEF5" }}>{renewsLabel}</span></>}
                  {renewsLabel && data?.nextInvoiceAmount != null && " · "}
                  {data?.nextInvoiceAmount != null && <>Next invoice ~${data.nextInvoiceAmount.toFixed(2)}</>}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <GhostBtn small icon={<ArrowDown size={12} />} onClick={() => setShowDowngrade(true)}>Downgrade</GhostBtn>
              <PrimaryBtn small icon={<ArrowUp size={12} />} onClick={() => setShowUpgrade(true)}>
                {upgradePlan ? `Upgrade to ${upgradePlan.name}` : "Upgrade"}
              </PrimaryBtn>
            </div>
          </div>
        </div>

        {/* Capacity panel */}
        <div
          className="rounded-2xl p-5"
          style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <p className="text-sm font-semibold mb-4" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>Storage capacity</p>

          {/* Meter */}
          <div className="mb-4">
            <div className="flex justify-between text-xs mb-1.5">
              <span style={{ color: "#8080A0" }}>{usedGB} GB used</span>
              <span style={{ color: "#505068" }}>{totalTB} TB total</span>
            </div>
            <div className="w-full h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: pct > 85 ? "#F59E0B" : "linear-gradient(90deg, #6D5EF6, #A78BFA)" }}
              />
            </div>
            <div className="flex justify-between text-xs mt-1">
              <span style={{ color: "#505068" }}>{pct}% used</span>
              <span style={{ color: "#505068" }}>{Math.max(0, totalGB - usedGB)} GB free</span>
            </div>
          </div>

          {/* Add capacity */}
          <div
            className="rounded-xl p-4 mb-4"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
          >
            <p className="text-xs font-medium mb-3" style={{ color: "#EEEEF5" }}>Add capacity</p>
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={() => setAddGB(Math.max(50, addGB - 50))}
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
                style={{ background: "rgba(255,255,255,0.06)", color: "#EEEEF5" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)")}
              >
                <Minus size={13} />
              </button>
              <div className="flex-1">
                <input
                  type="range" min={50} max={2000} step={50} value={addGB}
                  onChange={(e) => setAddGB(Number(e.target.value))}
                  className="w-full"
                  style={{ accentColor: "#6D5EF6" }}
                />
              </div>
              <button
                onClick={() => setAddGB(Math.min(2000, addGB + 50))}
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
                style={{ background: "rgba(255,255,255,0.06)", color: "#EEEEF5" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)")}
              >
                <Plus size={13} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs" style={{ color: "#8080A0" }}>
                  <span className="font-semibold" style={{ color: "#EEEEF5" }}>{addGB} GB</span>{" "}
                  × ${rate.toFixed(3)} = <span style={{ color: "#A89FF8" }}>${addCost} / mo</span>
                </p>
                <p className="text-[10px]" style={{ color: "#505068" }}>
                  Prorated for {daysRemaining} days remaining in billing period: ~${proratedCost} now
                </p>
              </div>
              <PrimaryBtn small onClick={() => addCapacity.mutate(addGB)}>Add {addGB} GB</PrimaryBtn>
            </div>
          </div>

          {/* Auto-capacity */}
          <div
            className="rounded-xl p-4"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium" style={{ color: "#EEEEF5" }}>Auto-capacity</p>
              <button
                onClick={() => { const v = !autoCapacity; setAuto(v); persistAuto({ enabled: v }); }}
                className="relative w-10 h-5 rounded-full transition-all duration-200"
                style={{ background: autoCapacity ? "#6D5EF6" : "rgba(255,255,255,0.1)" }}
              >
                <span
                  className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200"
                  style={{ left: autoCapacity ? "calc(100% - 18px)" : 2 }}
                />
              </button>
            </div>
            {autoCapacity && (
              <div className="flex flex-col gap-3">
                <FieldRow label="Auto-add increment">
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={50} max={500} step={50} value={autoGB}
                      onChange={(e) => setAutoGB(Number(e.target.value))}
                      onMouseUp={() => persistAuto({ increment: autoGB })}
                      className="w-24"
                      style={{ accentColor: "#6D5EF6" }}
                    />
                    <span className="text-xs w-14" style={{ color: "#A89FF8" }}>{autoGB} GB</span>
                  </div>
                </FieldRow>
                <FieldRow label={`Trigger at ${threshold}% usage`}>
                  <input
                    type="range" min={50} max={95} step={5} value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    onMouseUp={() => persistAuto({ threshold })}
                    className="w-24"
                    style={{ accentColor: "#6D5EF6" }}
                  />
                </FieldRow>
                <FieldRow label="Max monthly spend cap">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: "#505068" }}>$</span>
                    <input
                      type="number"
                      value={spendCap}
                      onChange={(e) => setSpendCap(e.target.value)}
                      onBlur={() => persistAuto({ maxSpend: Number(spendCap) || 0 })}
                      className="w-20 px-2 py-1 rounded-lg text-xs outline-none font-mono"
                      style={{ background: "#1E1E28", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
                    />
                    <span className="text-[10px]" style={{ color: "#404058" }}>0 = no cap</span>
                  </div>
                </FieldRow>
                <p className="text-[10px]" style={{ color: "#505068" }}>
                  When the cap is reached, uploads pause instead of billing further. You'll get a notification.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Usage history */}
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div
            className="px-5 py-3 flex items-center justify-between"
            style={{ background: "#15151C", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-sm font-semibold" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>Usage history</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <th className="px-5 py-2 text-left" style={{ color: "#505068", fontWeight: 500 }}>Date</th>
                <th className="px-5 py-2 text-left" style={{ color: "#505068", fontWeight: 500 }}>Storage (GB)</th>
                <th className="px-5 py-2 text-left" style={{ color: "#505068", fontWeight: 500 }}>Egress (GB)</th>
                <th className="px-5 py-2 text-right" style={{ color: "#505068", fontWeight: 500 }}>Requests</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-6 text-center" style={{ color: "#505068" }}>No usage history yet</td>
                </tr>
              )}
              {history.map((h, i) => (
                <tr
                  key={h.date}
                  className="transition-colors"
                  style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  <td className="px-5 py-3" style={{ color: "#EEEEF5" }}>{h.date}</td>
                  <td className="px-5 py-3 font-mono" style={{ color: "#8080A0" }}>{h.storageGB.toLocaleString()}</td>
                  <td className="px-5 py-3 font-mono" style={{ color: "#8080A0" }}>{h.egressGB.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-mono" style={{ color: "#8080A0" }}>{h.requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Invoice history */}
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div
            className="px-5 py-3 flex items-center justify-between"
            style={{ background: "#15151C", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-sm font-semibold" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>Invoice history</p>
          </div>
          <table className="w-full text-xs">
            <tbody>
              {invoices.map((inv, i) => (
                <tr
                  key={inv.id}
                  className="transition-colors"
                  style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  <td className="px-5 py-3" style={{ color: "#EEEEF5" }}>{inv.date}</td>
                  <td className="px-5 py-3" style={{ color: "#8080A0" }}>{planName}</td>
                  <td className="px-5 py-3 text-right font-mono" style={{ color: "#EEEEF5" }}>${inv.amount.toFixed(2)}</td>
                  <td className="px-5 py-3 text-right">
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full" style={{ background: "rgba(52,211,153,0.1)", color: "#34D399", border: "1px solid rgba(52,211,153,0.2)" }}>
                      <Check size={9} /> {inv.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>

      {/* Downgrade guard dialog */}
      {showDowngrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowDowngrade(false)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-md"
            style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.2)" }}>
                <ArrowDown size={18} style={{ color: "#F59E0B" }} />
              </div>
              <h2 className="text-base font-bold" style={{ letterSpacing: "-0.02em" }}>Downgrade plan</h2>
            </div>

            {downgradeOk ? (
              <>
                <p className="text-sm mb-5 flex items-start gap-2" style={{ color: "#34D399" }}>
                  <Check size={15} className="mt-0.5 flex-shrink-0" /> {downgradeOk}
                </p>
                <div className="flex justify-end">
                  <PrimaryBtn small onClick={() => { setShowDowngrade(false); setDowngradeOk(null); }}>Done</PrimaryBtn>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm mb-3" style={{ color: "#8080A0" }}>
                  You're using <strong style={{ color: "#EEEEF5" }}>{usedGB} GB</strong>. Pick a target tier —
                  we'll block the change if it holds less than your current usage.
                </p>
                <select
                  value={downgradeTier}
                  onChange={(e) => { setDowngradeTier(e.target.value); setDowngradeError(null); }}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none mb-3"
                  style={{ background: "#1E1E28", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
                >
                  {plans.map((p) => (
                    <option key={p.tierKey} value={p.tierKey}>{`${p.name} — ${p.includedGb} GB included`}</option>
                  ))}
                </select>

                {downgradeError && (
                  <p className="text-xs mb-3 flex items-start gap-1.5" style={{ color: "#F59E0B" }}>
                    <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /> {downgradeError}
                  </p>
                )}
                <p className="text-xs mb-5" style={{ color: "#505068" }}>
                  Your files are safe — nothing is deleted. If blocked, free up space in the library first.
                </p>
                <div className="flex gap-2 justify-end">
                  <GhostBtn small onClick={() => router.push("/media")}>Go to library →</GhostBtn>
                  <PrimaryBtn small disabled={downgrade.isPending} onClick={submitDowngrade}>
                    {downgrade.isPending ? "Downgrading…" : "Downgrade"}
              </PrimaryBtn>
              <GhostBtn small onClick={openPortal}>Manage in Stripe →</GhostBtn>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Upgrade dialog */}
      {showUpgrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowUpgrade(false)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-sm"
            style={{ background: "#15151C", border: "1px solid rgba(109,94,246,0.25)", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setShowUpgrade(false)} className="absolute top-4 right-4" style={{ color: "#505068" }}>
              <X size={15} />
            </button>
            <h2 className="text-base font-bold mb-1" style={{ letterSpacing: "-0.02em" }}>Upgrade to {upgradePlan?.name ?? "next tier"}</h2>
            <p className="text-xs mb-4" style={{ color: "#8080A0" }}>
              {upgradePlan
                ? `${upgradePlan.includedGb >= 1000 ? (upgradePlan.includedGb / 1000).toFixed(upgradePlan.includedGb >= 1000 ? 1 : 0) + " TB" : upgradePlan.includedGb + " GB"} storage · $${(upgradePlan.perGbPriceCents / 100).toFixed(2)} / GB overage · Prorated for remaining billing period`
                : "Prorated for remaining billing period"}
            </p>
            {(
              upgradePlan
                ? [
                    `${upgradePlan.includedGb >= 1000 ? (upgradePlan.includedGb / 1000).toFixed(upgradePlan.includedGb >= 1000 ? 1 : 0) + " TB" : upgradePlan.includedGb + " GB"} included storage`,
                    ...(upgradePlan.includedGb >= 1000 ? ["Unlimited team members", "Custom endpoints + Terraform", "SLA + dedicated support"] : ["Bring your own API keys"]),
                  ]
                : ["More storage included", "Bring your own API keys"]
            ).map((f) => (
              <p key={f} className="flex items-center gap-2 text-xs mb-2" style={{ color: "#BBBBD0" }}>
                <Check size={12} style={{ color: "#34D399" }} />{f}
              </p>
            ))}
            <div className="flex gap-2 mt-5">
              <GhostBtn small onClick={() => setShowUpgrade(false)}>Cancel</GhostBtn>
              <PrimaryBtn small onClick={() => { setShowUpgrade(false); openPortal(); }}>Upgrade now →</PrimaryBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs" style={{ color: "#8080A0" }}>{label}</span>
      {children}
    </div>
  );
}
