import React, { useState, useCallback, useRef, type DragEvent } from "react";
import { cn } from "./_utils";

export interface UploadFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

export interface UploadProgressProps {
  files: UploadFile[];
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  maxSizeBytes?: number;
  className?: string;
  disabled?: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function UploadProgress({
  files,
  onFilesSelected,
  accept,
  multiple = true,
  maxSizeBytes,
  className,
  disabled = false,
}: UploadProgressProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const processFiles = useCallback(
    (fileList: FileList) => {
      const selected = Array.from(fileList);
      const valid = selected.filter((f) => {
        if (maxSizeBytes && f.size > maxSizeBytes) return false;
        return true;
      });
      if (valid.length > 0) {
        onFilesSelected(valid);
      }
    },
    [onFilesSelected, maxSizeBytes],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles, disabled],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
        e.target.value = "";
      }
    },
    [processFiles],
  );

  const activeCount = files.filter(
    (f) => f.status === "pending" || f.status === "uploading",
  ).length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn(
          "relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer",
          isDragOver && !disabled
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-gray-50 hover:border-gray-400",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleInputChange}
          className="hidden"
          disabled={disabled}
        />

        <div className="flex flex-col items-center gap-2">
          <svg
            className={cn(
              "w-12 h-12 mb-2",
              isDragOver ? "text-blue-500" : "text-gray-400",
            )}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          <p className="text-sm font-medium text-gray-700">
            {isDragOver
              ? "Drop files here"
              : "Drag & drop files or click to browse"}
          </p>
          <p className="text-xs text-gray-500">
            {accept ? `Accepts: ${accept}` : "All file types supported"}
            {maxSizeBytes ? ` · Max ${formatFileSize(maxSizeBytes)}` : ""}
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
            <span>
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            <span className="flex gap-3">
              {activeCount > 0 && (
                <span className="text-blue-600">
                  {activeCount} uploading
                </span>
              )}
              {doneCount > 0 && (
                <span className="text-green-600">{doneCount} done</span>
              )}
              {errorCount > 0 && (
                <span className="text-red-600">{errorCount} failed</span>
              )}
            </span>
          </div>

          {files.map((file) => (
            <div
              key={file.id}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg border",
                file.status === "error" && "border-red-200 bg-red-50",
                file.status === "done" && "border-green-200 bg-green-50",
                file.status === "uploading" && "border-blue-200 bg-blue-50",
                file.status === "pending" && "border-gray-200",
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-700 truncate">
                    {file.name}
                  </span>
                  <span className="text-xs text-gray-500 shrink-0">
                    {formatFileSize(file.size)}
                  </span>
                </div>

                {(file.status === "uploading" || file.status === "done") && (
                  <div className="mt-1.5 w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-300",
                        file.status === "done"
                          ? "bg-green-500"
                          : "bg-blue-500",
                      )}
                      style={{ width: `${file.progress}%` }}
                    />
                  </div>
                )}

                {file.status === "error" && file.error && (
                  <p className="text-xs text-red-600 mt-1">{file.error}</p>
                )}

                {file.status === "pending" && (
                  <p className="text-xs text-gray-400 mt-1">Waiting...</p>
                )}
              </div>

              {file.status === "done" && (
                <svg
                  className="w-5 h-5 text-green-500 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
              {file.status === "error" && (
                <svg
                  className="w-5 h-5 text-red-500 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
