"use client";

import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "./DashboardShell";
import { useUsage, useUsageHistory } from "@/hooks/useUsage";

const ttStyle: React.CSSProperties = {
  background: "#1A1A26",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  color: "#EEEEF5",
  fontSize: 11,
  padding: "6px 10px",
};

const GB = 1_000_000_000;
const TB = 1_000_000_000_000;

function shortDate(d: string): string {
  const date = new Date(d);
  return isNaN(date.getTime()) ? d : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function UsageScreen() {
  const { data } = useUsage();
  const { data: historyData } = useUsageHistory();

  const usedGB = Math.round((data?.usedStorage ?? 0) / GB);
  const totalGB = Math.max(1, Math.round((data?.allocatedStorage ?? 0) / GB));
  const pct = Math.round((usedGB / totalGB) * 100);

  const egressTB = (data?.egressThisMonth ?? 0) / TB;
  const storedTB = usedGB / 1000;
  const egressRatio = storedTB > 0 ? egressTB / storedTB : 0;
  const egressWarning = egressRatio > 5;

  const history = historyData ?? [];
  const STORAGE_DATA = history.map((h) => ({ month: shortDate(h.date), gb: Math.round(h.storageBytes / GB) }));
  const EGRESS_DATA = history.map((h) => ({ month: shortDate(h.date), tb: +(h.egressBytes / TB).toFixed(2) }));
  const REQUESTS_DATA = history.map((h) => ({ day: shortDate(h.date), k: Math.round(h.requests / 1000) }));

  return (
    <div>
      <PageHeader title="Usage" breadcrumb={["my-studio"]} />
      <div className="p-5 flex flex-col gap-5">

        {/* Egress fair-use warning */}
        {egressWarning && (
          <div
            className="flex items-start gap-3 px-4 py-3.5 rounded-2xl"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }}
          >
            <AlertTriangle size={16} style={{ color: "#F59E0B", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p className="text-sm font-medium" style={{ color: "#F59E0B" }}>High egress-to-storage ratio</p>
              <p className="text-xs mt-0.5" style={{ color: "#8080A0" }}>
                Your egress this month ({egressTB.toFixed(1)} TB) is {egressRatio.toFixed(1)}× your stored data ({storedTB.toFixed(2)} TB). Egress is never charged, but ratios above 5× may trigger a fair-use review.
              </p>
            </div>
          </div>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {[
            { label: "Storage used",   value: `${usedGB} GB`,                                   sub: `of ${(totalGB / 1000).toFixed(0)} TB · ${pct}%`, pct, color: "#6D5EF6" },
            { label: "Egress (month)", value: `${egressTB.toFixed(1)} TB`,                       sub: "not billed",          pct: null, color: "#34D399" },
            { label: "API calls",      value: (data?.apiCallsThisMonth ?? 0).toLocaleString(),  sub: "GET + PUT + DELETE",   pct: null, color: "#A78BFA" },
            { label: "Objects stored", value: (data?.objectCount ?? 0).toLocaleString(),        sub: "across your buckets", pct: null, color: "#4ECDC4" },
          ].map(({ label, value, sub, pct: p, color }) => (
            <div
              key={label}
              className="rounded-2xl p-5"
              style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <p className="text-xs mb-2" style={{ color: "#606080" }}>{label}</p>
              <p className="text-2xl font-bold mb-1" style={{ color: "#EEEEF5", letterSpacing: "-0.03em" }}>{value}</p>
              <p className="text-xs" style={{ color: "#505068" }}>{sub}</p>
              {p !== null && (
                <div className="mt-3">
                  <svg width="56" height="56" viewBox="0 0 56 56" style={{ transform: "rotate(-90deg)" }}>
                    <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
                    <circle
                      cx="28" cy="28" r="22" fill="none" stroke={color} strokeWidth="5"
                      strokeDasharray={`${2 * Math.PI * 22 * p / 100} ${2 * Math.PI * 22 * (1 - p / 100)}`}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid md:grid-cols-2 gap-4">
          <ChartCard title="Storage growth (GB)" sub="Last 6 months">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={STORAGE_DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6D5EF6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6D5EF6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={ttStyle} cursor={{ stroke: "rgba(109,94,246,0.3)" }} />
                <Area type="monotone" dataKey="gb" stroke="#6D5EF6" strokeWidth={2} fill="url(#sg)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Egress (TB)" sub="Last 6 months — not billed">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={EGRESS_DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#34D399" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#34D399" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={ttStyle} cursor={{ stroke: "rgba(52,211,153,0.3)" }} />
                <Area type="monotone" dataKey="tb" stroke="#34D399" strokeWidth={2} fill="url(#eg)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title="Requests this week (thousands)" sub="GET + PUT + DELETE">
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={REQUESTS_DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#404058", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={ttStyle} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
              <Bar dataKey="k" fill="#6D5EF6" radius={[4, 4, 0, 0]} opacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

      </div>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="mb-4">
        <p className="text-sm font-medium" style={{ color: "#EEEEF5" }}>{title}</p>
        <p className="text-xs" style={{ color: "#505068" }}>{sub}</p>
      </div>
      {children}
    </div>
  );
}
