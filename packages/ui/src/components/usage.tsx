import React from "react";
import { cn } from "./_utils";

export interface UsageGaugeProps {
  usedBytes: number;
  allocatedBytes: number;
  label?: string;
  className?: string;
}

const GB = 1_000_000_000;

function formatBytes(bytes: number): string {
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function UsageGauge({
  usedBytes,
  allocatedBytes,
  label = "Storage",
  className,
}: UsageGaugeProps) {
  const pct = allocatedBytes > 0 ? (usedBytes / allocatedBytes) * 100 : 0;
  const safePct = Math.min(100, Math.max(0, pct));

  const colorClass =
    safePct >= 90
      ? "bg-red-500"
      : safePct >= 75
        ? "bg-yellow-500"
        : "bg-blue-500";

  return (
    <div className={cn("w-full", className)}>
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <span className="text-xs text-gray-500">
          {formatBytes(usedBytes)} / {formatBytes(allocatedBytes)}
        </span>
      </div>
      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", colorClass)}
          style={{ width: `${safePct}%` }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs text-gray-400">
          {safePct.toFixed(0)}% used
        </span>
        {safePct >= 90 && (
          <span className="text-xs text-red-500 font-medium">
            Near capacity
          </span>
        )}
      </div>
    </div>
  );
}

export interface CapacityBarProps {
  data: { label: string; bytes: number; color?: string }[];
  maxBytes?: number;
  className?: string;
}

export function CapacityBar({
  data,
  maxBytes,
  className,
}: CapacityBarProps) {
  const total = data.reduce((sum, d) => sum + d.bytes, 0);
  const max = maxBytes ?? total;

  const defaultColors = [
    "bg-blue-500",
    "bg-green-500",
    "bg-yellow-500",
    "bg-purple-500",
    "bg-pink-500",
    "bg-indigo-500",
  ];

  return (
    <div className={cn("w-full", className)}>
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-sm font-medium text-gray-700">
          Storage Breakdown
        </span>
        <span className="text-xs text-gray-500">
          Total: {formatBytes(total)}
        </span>
      </div>
      <div className="w-full h-6 bg-gray-200 rounded-full overflow-hidden flex">
        {data.map((d, i) => {
          const pct = (d.bytes / max) * 100;
          if (pct < 0.5) return null;
          const color = d.color ?? defaultColors[i % defaultColors.length]!;
          return (
            <div
              key={d.label}
              className={cn("h-full transition-all duration-300", color)}
              style={{ width: `${pct}%` }}
              title={`${d.label}: ${formatBytes(d.bytes)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mt-2">
        {data.map((d, i) => (
          <div key={d.label} className="flex items-center gap-1.5">
            <div
              className={cn(
                "w-3 h-3 rounded-sm",
                d.color ?? defaultColors[i % defaultColors.length],
              )}
            />
            <span className="text-xs text-gray-600">
              {d.label} ({formatBytes(d.bytes)})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
