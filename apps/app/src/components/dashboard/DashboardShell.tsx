"use client";

import { useState, useEffect, useRef } from "react";
import {
  LayoutGrid, Upload, Tag, Search,
  Database, Key, BarChart2, CreditCard, ChevronDown,
  LogOut, Menu, ChevronsLeft, ChevronsRight,
} from "lucide-react";
import { LogoMark } from "@medialocker/ui";

export type DashboardScreen =
  | "library" | "upload" | "organize" | "search"
  | "buckets" | "apikeys" | "usage" | "billing";

interface DashboardShellProps {
  screen: DashboardScreen;
  onNavigate: (s: DashboardScreen) => void;
  onExit: () => void;
  /** Sign the user out and return them to the login screen. */
  onSignOut?: () => void;
  /** Real storage figures for the top-bar meter, in bytes. */
  usedBytes?: number;
  totalBytes?: number;
  /** Signed-in user's email — drives the avatar initial and workspace label. */
  userEmail?: string;
  children: React.ReactNode;
}

const GB = 1_000_000_000;

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { id: "library",  icon: LayoutGrid,  label: "Library"   },
      { id: "upload",   icon: Upload,       label: "Upload"    },
    ],
  },
  {
    label: "Organize",
    items: [
      { id: "organize", icon: Tag,          label: "Organize"  },
      { id: "search",   icon: Search,       label: "Search"    },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { id: "buckets",  icon: Database,     label: "Buckets"   },
      { id: "apikeys",  icon: Key,          label: "API Keys"  },
    ],
  },
  {
    label: "Account",
    items: [
      { id: "usage",    icon: BarChart2,    label: "Usage"     },
      { id: "billing",  icon: CreditCard,   label: "Billing"   },
    ],
  },
];

export function DashboardShell({ screen, onNavigate, onExit, onSignOut, usedBytes, totalBytes, userEmail, children }: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl-K jumps to Search — the affordance advertised in the top bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onNavigate("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNavigate]);

  // Close the account menu on outside click.
  useEffect(() => {
    if (!accountOpen) return;
    const onClick = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [accountOpen]);

  const usedGB = Math.round((usedBytes ?? 0) / GB);
  const totalGB = Math.max(1, Math.round((totalBytes ?? 0) / GB));
  const hasMeter = (totalBytes ?? 0) > 0;
  const pct = Math.min(100, Math.round((usedGB / totalGB) * 100));

  // Derive display identity from the signed-in email until a dedicated org/profile
  // endpoint exists. No fabricated alternate workspaces.
  const workspace = userEmail ? userEmail.split("@")[0] : "workspace";
  const initial = (userEmail?.[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#0B0B0F", color: "#EEEEF5" }}>

      {/* ── Mobile overlay ───────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Sidebar ─────────────────────────────────── */}
      <aside
        className={`
          fixed md:relative z-50 md:z-auto flex flex-col h-full flex-shrink-0
          transition-all duration-200 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
        style={{
          width: collapsed ? 60 : 220,
          background: "#0F0F14",
          borderRight: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {/* Logo + collapse */}
        <div
          className="flex items-center justify-between px-3 h-14 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div className="flex items-center gap-2 overflow-hidden">
            <LogoMark size={26} />
            {!collapsed && (
              <span style={{ fontWeight: 700, fontSize: "0.95rem", letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
                MediaLocker
              </span>
            )}
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden md:flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
            style={{ color: "#505068" }}
          >
            {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
          </button>
        </div>

        {/* Workspace label */}
        {!collapsed && (
          <div className="px-3 py-2">
            <div
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.07)",
                color: "#EEEEF5",
              }}
            >
              <span
                className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                style={{ background: "#6D5EF6", color: "#fff" }}
              >
                {initial}
              </span>
              <span className="truncate">{workspace}</span>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi} className="mb-3">
              {group.label && !collapsed && (
                <p
                  className="px-3 mb-1 text-[10px] uppercase tracking-widest"
                  style={{ color: "#404058" }}
                >
                  {group.label}
                </p>
              )}
              {group.items.map(({ id, icon: Icon, label }) => {
                const active = screen === id;
                return (
                  <button
                    key={id}
                    onClick={() => { onNavigate(id as DashboardScreen); setMobileOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl mb-0.5 text-xs font-medium transition-all duration-150 ${collapsed ? "justify-center" : ""}`}
                    style={{
                      background: active ? "rgba(109,94,246,0.15)" : "transparent",
                      color: active ? "#A89FF8" : "#606080",
                      border: active ? "1px solid rgba(109,94,246,0.2)" : "1px solid transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (!active) (e.currentTarget as HTMLElement).style.color = "#EEEEF5";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) (e.currentTarget as HTMLElement).style.color = "#606080";
                    }}
                    title={collapsed ? label : undefined}
                  >
                    <Icon size={15} style={{ flexShrink: 0 }} />
                    {!collapsed && label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Bottom */}
        <div
          className="px-2 py-3 flex flex-col gap-1"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <button
            onClick={onExit}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-colors ${collapsed ? "justify-center" : ""}`}
            style={{ color: "#505068" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EEEEF5")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
            title={collapsed ? "Exit to site" : undefined}
          >
            <LogOut size={14} />
            {!collapsed && "Exit dashboard"}
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Top bar */}
        <header
          className="flex items-center gap-3 px-4 h-14 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "#0F0F14" }}
        >
          {/* Mobile hamburger */}
          <button
            className="md:hidden flex items-center justify-center w-8 h-8 rounded-lg"
            style={{ color: "#606080" }}
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={18} />
          </button>

          {/* Global search */}
          <div
            className="flex-1 max-w-md flex items-center gap-2 px-3 py-1.5 rounded-xl cursor-text"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
            onClick={() => onNavigate("search")}
          >
            <Search size={13} style={{ color: "#505068", flexShrink: 0 }} />
            <span className="text-xs" style={{ color: "#404058" }}>
              Search files, buckets, tags…
            </span>
            <span
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: "rgba(255,255,255,0.05)", color: "#404058" }}
            >
              ⌘K
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Storage mini-meter */}
            {hasMeter && (
              <div
                className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                <div
                  className="w-20 h-1.5 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.08)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: pct > 85 ? "#F59E0B" : "#6D5EF6",
                    }}
                  />
                </div>
                <span style={{ color: "#8080A0" }}>
                  {usedGB} GB{" "}
                  <span style={{ color: "#404058" }}>
                    / {totalGB >= 1000 ? `${(totalGB / 1000).toFixed(1)} TB` : `${totalGB} GB`}
                  </span>
                </span>
              </div>
            )}

            {/* Account menu */}
            <div className="relative" ref={accountRef}>
              <button
                onClick={() => setAccountOpen((o) => !o)}
                className="flex items-center gap-2 px-2 py-1 rounded-xl transition-colors"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
                title={userEmail ?? undefined}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={{ background: "#6D5EF6", color: "#fff" }}
                >
                  {initial}
                </div>
                <ChevronDown size={11} style={{ color: "#505068" }} className="hidden sm:block" />
              </button>

              {accountOpen && (
                <div
                  className="absolute right-0 mt-2 w-56 rounded-xl overflow-hidden z-50"
                  style={{
                    background: "#15151C",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 16px 40px rgba(0,0,0,0.6)",
                  }}
                >
                  {userEmail && (
                    <div className="px-3 py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <p className="text-[10px] uppercase tracking-widest mb-0.5" style={{ color: "#404058" }}>Signed in as</p>
                      <p className="text-xs truncate" style={{ color: "#EEEEF5" }}>{userEmail}</p>
                    </div>
                  )}
                  <button
                    onClick={() => { setAccountOpen(false); onExit(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs transition-colors"
                    style={{ color: "#8080A0" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <LogOut size={14} /> Exit to site
                  </button>
                  {onSignOut && (
                    <button
                      onClick={() => { setAccountOpen(false); onSignOut(); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs transition-colors"
                      style={{ color: "#FC8181" }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(252,129,129,0.08)")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                    >
                      <LogOut size={14} /> Sign out
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto" style={{ background: "#0B0B0F" }}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  breadcrumb,
  action,
}: {
  title: string;
  breadcrumb?: string[];
  action?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-start justify-between px-6 py-5"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div>
        {breadcrumb && (
          <p className="text-xs mb-1 flex items-center gap-1" style={{ color: "#404058" }}>
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span>/</span>}
                {b}
              </span>
            ))}
          </p>
        )}
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</h1>
      </div>
      {action && <div className="flex items-center gap-2 mt-1">{action}</div>}
    </div>
  );
}

export function PrimaryBtn({
  children,
  onClick,
  icon,
  small,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  icon?: React.ReactNode;
  small?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-xl font-semibold transition-all duration-150 ${disabled ? "opacity-50 cursor-not-allowed" : "hover:scale-[1.02] active:scale-[0.98]"} ${small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"}`}
      style={{ background: "#6D5EF6", color: "#fff" }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = "#5B4EE0"; }}
      onMouseLeave={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = "#6D5EF6"; }}
    >
      {icon}
      {children}
    </button>
  );
}

export function GhostBtn({
  children,
  onClick,
  icon,
  small,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  icon?: React.ReactNode;
  small?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-xl font-medium transition-all duration-150 ${small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"}`}
      style={{
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: danger ? "#FC8181" : "#BBBBD0",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)";
        (e.currentTarget as HTMLElement).style.color = danger ? "#FEB2B2" : "#EEEEF5";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)";
        (e.currentTarget as HTMLElement).style.color = danger ? "#FC8181" : "#BBBBD0";
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: "active" | "warning" | "error" | "processing" | "queued" | "ready" }) {
  const map = {
    active:     { bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.25)", color: "#34D399", label: "Active" },
    warning:    { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.25)", color: "#F59E0B", label: "Warning" },
    error:      { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.25)",  color: "#EF4444", label: "Error"  },
    processing: { bg: "rgba(109,94,246,0.12)", border: "rgba(109,94,246,0.25)", color: "#A89FF8", label: "Processing" },
    queued:     { bg: "rgba(255,255,255,0.06)",border: "rgba(255,255,255,0.1)", color: "#8080A0", label: "Queued" },
    ready:      { bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.25)", color: "#34D399", label: "Ready"  },
  };
  const s = map[status];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

