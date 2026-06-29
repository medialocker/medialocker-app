"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Upload, X, AlertCircle, CheckCircle2, RotateCcw, ChevronDown } from "lucide-react";
import { PageHeader, PrimaryBtn } from "./DashboardShell";
import { useBuckets } from "@/hooks/useBuckets";
import { useMultipartUpload } from "@/hooks/useMedia";

const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "ps1", "sh", "bash", "zsh",
  "dll", "so", "dylib", "sys", "drv", "scr",
  "app", "apk", "deb", "rpm",
  "jar", "class", "war",
  "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
  "com", "cpl",
]);

function isDangerousFile(file: File): boolean {
  if (!file.name.includes(".")) return false;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return BLOCKED_EXTENSIONS.has(ext);
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "—";
  if (bytesPerSec > 1e6) return (bytesPerSec / 1e6).toFixed(1) + " MB/s";
  if (bytesPerSec > 1e3) return (bytesPerSec / 1e3).toFixed(0) + " KB/s";
  return bytesPerSec.toFixed(0) + " B/s";
}

type FileStatus = "uploading" | "done" | "error";
interface UploadFile {
  id: number;
  name: string;
  size: string;
  sizeBytes: number;
  pct: number;
  speed: string;
  status: FileStatus;
  thumb?: string;
  file?: File;
  tags?: string[];
  warning?: string;
  error?: string;
}

function parseTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

function formatSize(bytes: number): string {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

export function UploadScreen() {
  const { data: buckets = [] } = useBuckets();
  const bucketNames = buckets.map((b) => b.name);

  const [files, setFiles]     = useState<UploadFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [bucket, setBucket]   = useState("");
  const [tags, setTags]       = useState("");
  const [bucketOpen, setBucketOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedBucket = buckets.find((b) => b.name === bucket) ?? buckets[0];
  const upload = useMultipartUpload(selectedBucket?.id ?? "");

  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
  const startTimesRef = useRef<Record<number, number>>({});
  // One AbortController per upload id so cancel aborts exactly that file's
  // in-flight requests — not whichever upload happens to be active (P2.52).
  const controllersRef = useRef<Record<number, AbortController>>({});

  function patch(id: number, next: Partial<UploadFile>) {
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...next } : f)));
  }

  const updateSpeed = useCallback((id: number, sizeBytes: number, pct: number) => {
    const started = startTimesRef.current[id];
    if (!started || pct === 0) return;
    const elapsedSec = (Date.now() - started) / 1000;
    if (elapsedSec <= 0.1) return;
    const bytesUploaded = sizeBytes * (pct / 100);
    const bps = bytesUploaded / elapsedSec;
    patch(id, { speed: formatSpeed(bps) });
  }, []);

  async function startUpload(entry: UploadFile) {
    if (!entry.file || !selectedBucket) {
      patch(entry.id, { status: "error", pct: 0, error: "No bucket selected" });
      return;
    }
    startTimesRef.current[entry.id] = Date.now();
    const controller = new AbortController();
    controllersRef.current[entry.id] = controller;
    patch(entry.id, { status: "uploading", pct: 0, speed: "—", error: undefined });
    try {
      await upload.mutateAsync({
        file: entry.file,
        tags: entry.tags,
        signal: controller.signal,
        onProgress: (pct: number) => {
          patch(entry.id, { pct });
          updateSpeed(entry.id, entry.sizeBytes, pct);
        },
      });
      patch(entry.id, { status: "done", pct: 100 });
    } catch (err) {
      // Distinguish a user-initiated cancel from a real failure, and surface the
      // actual error (e.g. a missing-ETag multipart failure, P2.53) instead of a
      // blanket "network error".
      const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
      patch(entry.id, {
        status: "error",
        pct: 0,
        error: aborted ? "Upload cancelled" : ((err as Error)?.message ?? "Upload failed"),
      });
    } finally {
      delete startTimesRef.current[entry.id];
      delete controllersRef.current[entry.id];
    }
  }

  function enqueue(fileList: FileList | File[]) {
    const appliedTags = parseTags(tags);
    const oversized: string[] = [];
    const dangerous: string[] = [];
    const entries: UploadFile[] = Array.from(fileList)
      .filter((f) => {
        if (f.size > MAX_FILE_SIZE) {
          oversized.push(`${f.name} (${formatSize(f.size)})`);
          return false;
        }
        if (isDangerousFile(f)) {
          dangerous.push(f.name);
          return false;
        }
        return true;
      })
      .map((f, i) => ({
        id: Date.now() + i,
        name: f.name,
        size: formatSize(f.size),
        sizeBytes: f.size,
        pct: 0,
        speed: "—",
        status: "uploading" as FileStatus,
        file: f,
        tags: appliedTags,
        warning: !f.type ? "Unknown file type — upload may fail" : undefined,
      }));
    if (oversized.length > 0) {
      alert(`Files exceed 5 GB limit:\n${oversized.join("\n")}`);
    }
    if (dangerous.length > 0) {
      alert(`Blocked executable file types:\n${dangerous.join("\n")}`);
    }
    setFiles((prev) => [...prev, ...entries]);
    entries.forEach(startUpload);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  }

  function removeFile(id: number) {
    setFiles((fs) => fs.filter((f) => f.id !== id));
  }

  function cancelUpload(id: number) {
    // Abort only THIS upload's controller (P2.52). The mutation's catch handler
    // then marks it cancelled.
    controllersRef.current[id]?.abort();
  }

  function retry(id: number) {
    const entry = files.find((f) => f.id === id);
    if (entry) startUpload(entry);
  }

  const active   = files.filter((f) => f.status === "uploading");
  const done     = files.filter((f) => f.status === "done");
  const errored  = files.filter((f) => f.status === "error");
  const hasActive = active.length > 0;

  useEffect(() => {
    if (!hasActive) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasActive]);

  return (
    <div>
      <PageHeader
        title="Upload"
        breadcrumb={["my-studio"]}
        action={<PrimaryBtn small onClick={() => setFiles((fs) => fs.filter((f) => f.status !== "done"))}>Clear completed</PrimaryBtn>}
      />
      <div className="p-5 max-w-3xl mx-auto flex flex-col gap-5">

        {/* Dropzone */}
        <div
          className="rounded-2xl flex flex-col items-center justify-center py-16 px-6 cursor-pointer transition-all duration-200"
          style={{
            border: dragging ? "2px dashed #6D5EF6" : "2px dashed rgba(255,255,255,0.1)",
            background: dragging ? "rgba(109,94,246,0.06)" : "rgba(255,255,255,0.02)",
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.files?.length) enqueue(e.target.files);
              e.target.value = "";
            }}
          />
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{
              background: dragging ? "rgba(109,94,246,0.2)" : "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <Upload size={22} style={{ color: dragging ? "#A89FF8" : "#505068" }} />
          </div>
          <p className="text-sm font-medium mb-1" style={{ color: dragging ? "#A89FF8" : "#EEEEF5" }}>
            {dragging ? "Drop to upload" : "Drag files here or click to browse"}
          </p>
          <p className="text-xs" style={{ color: "#505068" }}>
            Any format · Large files upload in 8 MiB multipart chunks
          </p>
        </div>

        {/* Options */}
        <div className="grid sm:grid-cols-2 gap-3">
          {/* Bucket selector */}
          <div className="relative">
            <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Target bucket</label>
            <button
              onClick={() => setBucketOpen(!bucketOpen)}
              disabled={hasActive}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm"
              style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5", opacity: hasActive ? 0.5 : 1, cursor: hasActive ? "not-allowed" : "pointer" }}
            >
              <span className="font-mono text-xs" style={{ color: "#A89FF8" }}>{selectedBucket?.name ?? "Select bucket"}</span>
              <ChevronDown size={13} style={{ color: "#505068" }} />
            </button>
            {bucketOpen && (
              <div
                className="absolute z-20 w-full mt-1 rounded-xl py-1 overflow-hidden"
                style={{ background: "#1A1A26", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}
              >
                {bucketNames.map((b) => (
                  <button
                    key={b}
                    onClick={() => { setBucket(b); setBucketOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-mono transition-colors"
                    style={{ color: b === bucket ? "#A89FF8" : "#8080A0" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "#606080" }}>Apply tags on upload</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. client-A, approved, 4K"
              className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
              style={{ background: "#15151C", border: "1px solid rgba(255,255,255,0.1)", color: "#EEEEF5" }}
            />
          </div>
        </div>

        {/* Active uploads */}
        {active.length > 0 && (
          <div>
            <p className="text-xs mb-3" style={{ color: "#606080" }}>
              Uploading — {active.length} file{active.length !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-col gap-2">
              {active.map((f) => <UploadRow key={f.id} file={f} onRemove={removeFile} onCancel={cancelUpload} />)}
            </div>
          </div>
        )}

        {/* Errors */}
        {errored.length > 0 && (
          <div>
            <p className="text-xs mb-3 flex items-center gap-1.5" style={{ color: "#FC8181" }}>
              <AlertCircle size={12} /> {errored.length} failed
            </p>
            <div className="flex flex-col gap-2">
              {errored.map((f) => <UploadRow key={f.id} file={f} onRemove={removeFile} onRetry={retry} />)}
            </div>
          </div>
        )}

        {/* Completed */}
        {done.length > 0 && (
          <div>
            <p className="text-xs mb-3 flex items-center gap-1.5" style={{ color: "#34D399" }}>
              <CheckCircle2 size={12} /> {done.length} completed
            </p>
            <div className="flex flex-col gap-2">
              {done.map((f) => <UploadRow key={f.id} file={f} onRemove={removeFile} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UploadRow({
  file,
  onRemove,
  onRetry,
  onCancel,
}: {
  file: UploadFile;
  onRemove: (id: number) => void;
  onRetry?: (id: number) => void;
  onCancel?: (id: number) => void;
}) {
  const statusColor = {
    uploading: "#6D5EF6",
    done:      "#34D399",
    error:     "#EF4444",
  }[file.status];

  return (
    <div
      className="flex items-center gap-3 px-3 py-3 rounded-2xl"
      style={{
        background: "#15151C",
        border: `1px solid ${file.status === "error" ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.07)"}`,
      }}
    >
      {/* Thumb */}
      <div className="w-12 h-8 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: "#1E1E28" }}>
        {file.thumb
          ? <img src={file.thumb} alt="" className="w-full h-full object-cover" />
          : <Upload size={14} style={{ color: "#505068" }} />}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-medium truncate" style={{ color: "#EEEEF5", maxWidth: "70%" }}>{file.name}</p>
          <div className="flex items-center gap-2 flex-shrink-0">
            {file.status === "uploading" && (
              <span className="text-[10px] font-mono" style={{ color: "#606080" }}>{file.speed}</span>
            )}
            <span className="text-[10px]" style={{ color: "#606080" }}>{file.size}</span>
          </div>
        </div>
        {file.status !== "done" && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${file.pct}%`,
                  background: file.status === "error" ? "#EF4444" : "linear-gradient(90deg, #6D5EF6, #A78BFA)",
                }}
              />
            </div>
            <span className="text-[10px] font-mono w-7 text-right" style={{ color: statusColor }}>
              {file.status === "error" ? "!" : `${file.pct}%`}
            </span>
          </div>
        )}
        {file.status === "done" && (
          <p className="text-[10px] flex items-center gap-1" style={{ color: "#34D399" }}>
            <CheckCircle2 size={10} /> Uploaded successfully
          </p>
        )}
        {file.status === "error" && (
          <p className="text-[10px] flex items-center gap-1" style={{ color: "#FC8181" }}>
            <AlertCircle size={10} /> {file.error ?? "Upload failed"}
          </p>
        )}
        {file.warning && (
          <p className="text-[10px] flex items-center gap-1 mt-0.5" style={{ color: "#FBBF24" }}>
            <AlertCircle size={10} /> {file.warning}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {file.status === "error" && onRetry && (
          <button
            onClick={() => onRetry(file.id)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "#A89FF8" }}
            title="Retry"
          >
            <RotateCcw size={13} />
          </button>
        )}
        {file.status === "uploading" && onCancel && (
          <button
            onClick={() => onCancel(file.id)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "#FC8181" }}
            title="Cancel upload"
          >
            <X size={13} />
          </button>
        )}
        <button
          onClick={() => onRemove(file.id)}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: "#505068" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#FC8181")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#505068")}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
