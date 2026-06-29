"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useUsage } from "@/hooks/useUsage";
import { useBuckets } from "@/hooks/useBuckets";
import { useMedia } from "@/hooks/useMedia";
import { PageHeader } from "@/components/dashboard/DashboardShell";
import {
  HardDrive, Image as ImageIcon, Download, Activity,
  Upload, Plus, Key, ArrowRight, FileText, Box, Volume2,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function kindFromMime(mime?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("model/")) return "3d";
  return "other";
}

export default function DashboardPage() {
  const { session } = useAuth();
  const { data: usage } = useUsage();
  const { data: buckets = [] } = useBuckets();
  const firstBucket = buckets[0];
  const { data: mediaPage } = useMedia(firstBucket?.id ?? "", {});
  const recent = (mediaPage?.data ?? []).slice(0, 5);

  const stats = [
    { label: "Storage used", value: usage ? formatBytes(usage.usedStorage) : "…", sub: usage ? `of ${formatBytes(usage.allocatedStorage)}` : "", icon: HardDrive, color: "#A89FF8", bg: "rgba(109,94,246,0.12)" },
    { label: "Objects",      value: usage ? usage.objectCount.toLocaleString() : "…", sub: "Total files", icon: ImageIcon, color: "#4ECDC4", bg: "rgba(78,205,196,0.12)" },
    { label: "Egress",       value: usage ? formatBytes(usage.egressThisMonth) : "…", sub: "This month · not billed", icon: Download, color: "#34D399", bg: "rgba(52,211,153,0.12)" },
    { label: "API calls",    value: usage ? usage.apiCallsThisMonth.toLocaleString() : "…", sub: "This month", icon: Activity, color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  ];

  const quickActions = [
    { href: "/upload",   label: "Upload files",  icon: Upload },
    { href: "/buckets",  label: "Create bucket", icon: Plus },
    { href: "/api-keys", label: "Create API key", icon: Key },
  ];

  return (
    <div>
      <PageHeader title="Overview" breadcrumb={["my-studio"]} />
      <div className="p-5 flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "#EEEEF5", letterSpacing: "-0.02em" }}>
            Welcome back{session?.user?.email ? `, ${session.user.email}` : ""}
          </h2>
          <p className="text-sm mt-0.5" style={{ color: "#8080A0" }}>
            Here&apos;s what&apos;s happening with your storage.
          </p>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl p-5" style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs" style={{ color: "#606080" }}>{s.label}</span>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: s.bg }}>
                  <s.icon size={15} style={{ color: s.color }} />
                </div>
              </div>
              <p className="text-2xl font-bold" style={{ color: "#EEEEF5", letterSpacing: "-0.03em" }}>{s.value}</p>
              <p className="text-xs mt-1" style={{ color: "#505068" }}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Recent uploads */}
          <div className="lg:col-span-2 rounded-2xl p-5" style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>Recent uploads</h3>
              <Link href="/media" className="text-xs" style={{ color: "#A89FF8" }}>View library →</Link>
            </div>
            {recent.length === 0 ? (
              <p className="text-sm" style={{ color: "#8080A0" }}>
                No uploads yet.{" "}
                <Link href="/upload" style={{ color: "#A89FF8" }}>Upload your first file</Link>.
              </p>
            ) : (
              <div className="flex flex-col">
                {recent.map((m, i) => {
                  const kind = kindFromMime(m.mimeType);
                  return (
                    <Link
                      key={m.id}
                      href="/media"
                      className="flex items-center gap-3 py-2.5"
                      style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none" }}
                    >
                      <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: "#1E1E28" }}>
                        {m.thumbnailUrl
                          ? <img src={m.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                          : kind === "pdf" ? <FileText size={15} style={{ color: "#FC8181" }} />
                          : kind === "3d"  ? <Box size={15} style={{ color: "#4ECDC4" }} />
                          : kind === "audio" ? <Volume2 size={15} style={{ color: "#F59E0B" }} />
                          : <ImageIcon size={15} style={{ color: "#8080A0" }} />}
                      </div>
                      <span className="flex-1 min-w-0 text-xs font-medium truncate" style={{ color: "#EEEEF5" }}>{m.filename}</span>
                      <span className="text-[11px] flex-shrink-0" style={{ color: "#505068" }}>{formatBytes(m.size)}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="rounded-2xl p-5" style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.07)" }}>
            <h3 className="text-sm font-semibold mb-4" style={{ color: "#EEEEF5", letterSpacing: "-0.01em" }}>Quick actions</h3>
            <div className="flex flex-col gap-2">
              {quickActions.map((a) => (
                <Link
                  key={a.label}
                  href={a.href}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "#BBBBD0" }}
                >
                  <a.icon size={15} style={{ color: "#A89FF8" }} />
                  {a.label}
                  <ArrowRight size={13} className="ml-auto" style={{ color: "#505068" }} />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
