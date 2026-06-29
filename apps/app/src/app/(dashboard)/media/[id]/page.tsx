"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Download, Trash2, Volume2,
  FileText, Box, Tag, FolderTree, Image as ImageIcon,
} from "lucide-react";
import { useMediaItem, useMediaUrl, useDeleteMedia } from "@/hooks/useMedia";
import { MediaViewer } from "@medialocker/ui";
import type { Media } from "@/lib/api";
import { formatSize, formatDuration, mediaKind, extLabel } from "@/lib/format";

/* ─── Helpers ───────────────────────────────────────── */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

/* ─── Design tokens ─────────────────────────────────── */
const C = {
  bg: "#0B0B0F",
  panel: "#15151C",
  border: "rgba(255,255,255,0.07)",
  text: "#EEEEF5",
  muted: "#8080A0",
  muted2: "#606080",
  muted3: "#505068",
  muted4: "#404058",
  violet: "#6D5EF6",
  violetDim: "rgba(109,94,246,0.12)",
  violetText: "#A89FF8",
  green: "#34D399",
  amber: "#F59E0B",
  red: "#FC8181",
  redDark: "#EF4444",
  teal: "#4ECDC4",
};

/* ─── Sub-components ────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, ...style }}>
      {children}
    </div>
  );
}

function CardSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${C.border}` }}>
        <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.muted4 }}>
          {label}
        </p>
      </div>
      <div style={{ padding: "14px 18px 16px" }}>{children}</div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "5px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <span style={{ fontSize: 12, color: C.muted3, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: 12,
          color: C.text,
          textAlign: "right",
          wordBreak: "break-all",
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "0.01em",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function TypeChip({ mimeType }: { mimeType: string }) {
  const kind = mediaKind(mimeType);
  const color: Record<string, string> = {
    video: C.violetText, image: C.green,
    audio: C.amber, pdf: C.red, "3d": C.teal,
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: color[kind],
        background: `${color[kind]}18`,
        border: `1px solid ${color[kind]}30`,
      }}
    >
      {extLabel(mimeType)}
    </span>
  );
}

/* ─── Preview panel — renders the real asset ────────── */
function Preview({ file, url }: { file: Media; url?: string }) {
  return (
    <Card style={{ minHeight: 440, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 380,
          position: "relative",
          background: "#0F0F14",
        }}
      >
        {url ? (
          <MediaViewer
            src={url}
            mimeType={file.mimeType}
            alt={file.filename}
            className="w-full h-full"
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <FileText size={56} style={{ color: C.muted3, opacity: 0.55 }} />
            <span style={{ fontSize: 12, color: C.muted3 }}>{file.filename}</span>
          </div>
        )}
      </div>

      {/* Type chip bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: `1px solid ${C.border}` }}>
        <TypeChip mimeType={file.mimeType} />
        {file.width && file.height && (
          <span style={{ fontSize: 12, color: C.muted3 }}>
            {file.width.toLocaleString()} × {file.height.toLocaleString()}
          </span>
        )}
        {file.duration != null && !file.width && (
          <span style={{ fontSize: 12, color: C.muted3 }}>{formatDuration(file.duration)}</span>
        )}
        <span style={{ marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.muted4, wordBreak: "break-all" }}>
          {file.filename}
        </span>
      </div>
    </Card>
  );
}

/* ─── Main page ─────────────────────────────────────── */
export default function MediaDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: file, isLoading } = useMediaItem(id);
  const { data: url } = useMediaUrl(id, !!file);
  const deleteMedia = useDeleteMedia();
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    await deleteMedia.mutateAsync(id);
    router.push("/media");
  }

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400, color: C.muted2, fontSize: 14 }}>
        Loading…
      </div>
    );
  }

  if (!file) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, color: C.muted2, gap: 12 }}>
        <FileText size={40} style={{ opacity: 0.3 }} />
        <p style={{ fontSize: 14 }}>File not found.</p>
        <button
          onClick={() => router.push("/media")}
          style={{ fontSize: 13, color: C.violet, background: "none", border: "none", cursor: "pointer" }}
        >
          ← Back to Library
        </button>
      </div>
    );
  }

  const tags = file.tags ?? [];
  const categories = file.categories ?? [];

  return (
    <div style={{ padding: "24px 28px 60px", maxWidth: 1100, margin: "0 auto", color: C.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Back */}
      <button
        onClick={() => router.push("/media")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: C.muted2,
          background: "none",
          border: "none",
          cursor: "pointer",
          marginBottom: 20,
          padding: 0,
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = C.text)}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = C.muted2)}
      >
        <ArrowLeft size={14} />
        Back to Library
      </button>

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: confirmDelete ? 16 : 28,
          flexWrap: "wrap",
        }}
      >
        <div>
          <p style={{ fontSize: 11, color: C.muted4, marginBottom: 5, letterSpacing: "0.01em" }}>my-studio / Library</p>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em", color: C.text, margin: 0, lineHeight: 1.3, wordBreak: "break-all" }}>
            {file.filename}
          </h1>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 2 }}>
          <a
            href={url ?? undefined}
            download={file.filename}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!url}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 16px",
              borderRadius: 12,
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: C.violet,
              textDecoration: "none",
              cursor: "pointer",
              transition: "background 0.15s, transform 0.1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "#5B4EE0";
              (e.currentTarget as HTMLElement).style.transform = "scale(1.02)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = C.violet;
              (e.currentTarget as HTMLElement).style.transform = "scale(1)";
            }}
          >
            <Download size={14} />
            Download
          </a>

          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 14px",
              borderRadius: 12,
              fontSize: 13,
              fontWeight: 500,
              color: C.red,
              background: "rgba(252,129,129,0.07)",
              border: "1px solid rgba(252,129,129,0.2)",
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(252,129,129,0.12)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(252,129,129,0.35)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(252,129,129,0.07)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(252,129,129,0.2)";
            }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </div>

      {/* Inline delete confirmation */}
      {confirmDelete && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            padding: "14px 18px",
            borderRadius: 14,
            marginBottom: 24,
            background: "rgba(239,68,68,0.06)",
            border: "1px solid rgba(239,68,68,0.28)",
          }}
        >
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: C.red, marginBottom: 2 }}>
              Delete this file? This can&apos;t be undone.
            </p>
            <p style={{ fontSize: 12, color: C.muted2 }}>
              {file.filename} · {formatSize(file.size)} will be permanently removed.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMedia.isPending}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 500,
                color: "#BBBBD0",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteMedia.isPending}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: "#fff",
                background: C.redDark,
                border: "none",
                cursor: deleteMedia.isPending ? "default" : "pointer",
                opacity: deleteMedia.isPending ? 0.7 : 1,
              }}
            >
              {deleteMedia.isPending ? "Deleting…" : "Delete file"}
            </button>
          </div>
        </div>
      )}

      {/* Two-column body */}
      <div
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}
        className="file-detail-grid"
      >
        <Preview file={file} url={url} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <CardSection label="Details">
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <Row label="Size" value={formatSize(file.size)} />
              <Row label="Type" value={file.mimeType} />
              {file.width && file.height && (
                <Row label="Dimensions" value={`${file.width.toLocaleString()} × ${file.height.toLocaleString()}`} />
              )}
              {file.duration != null && <Row label="Duration" value={formatDuration(file.duration)} />}
              {file.key && <Row label="Bucket key" value={file.key} />}
              <Row label="Created" value={formatDate(file.createdAt)} />
            </div>
          </CardSection>

          <CardSection label="Tags">
            {tags.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "4px 10px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 500,
                      background: C.violetDim,
                      color: C.violetText,
                      border: "1px solid rgba(109,94,246,0.22)",
                    }}
                  >
                    <Tag size={10} style={{ flexShrink: 0 }} />
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: C.muted3, fontStyle: "italic" }}>No tags yet.</p>
            )}
          </CardSection>

          <CardSection label="Categories">
            {categories.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {categories.map((c) => (
                  <span
                    key={c}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "4px 10px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 500,
                      background: "rgba(255,255,255,0.06)",
                      color: C.muted2,
                      border: "1px solid rgba(255,255,255,0.09)",
                    }}
                  >
                    <FolderTree size={10} style={{ flexShrink: 0 }} />
                    {c}
                  </span>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: C.muted3, fontStyle: "italic" }}>No categories.</p>
            )}
          </CardSection>
        </div>
      </div>
    </div>
  );
}
