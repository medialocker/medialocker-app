import React from "react";
import { cn } from "./_utils";

export interface SetCardProps {
  id: string;
  name: string;
  thumbnailUrl?: string;
  itemCount: number;
  onClick?: (id: string) => void;
  className?: string;
}

export function SetCard({
  id,
  name,
  thumbnailUrl,
  itemCount,
  onClick,
  className,
}: SetCardProps) {
  return (
    <div
      className={cn(
        "group relative bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-all cursor-pointer",
        className,
      )}
      onClick={() => onClick?.(id)}
    >
      <div className="aspect-video bg-gray-100 flex items-center justify-center">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <svg
              className="w-10 h-10"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
            <span className="text-xs">No preview</span>
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium text-gray-900 truncate">{name}</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          {itemCount} item{itemCount !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors rounded-xl" />
    </div>
  );
}

export interface StoryboardClipData {
  id: string;
  objectId: string;
  thumbnailUrl?: string;
  position: number;
  note?: string;
}

export interface StoryboardTimelineProps {
  name: string;
  clips: StoryboardClipData[];
  onClipClick?: (clip: StoryboardClipData) => void;
  className?: string;
}

export function StoryboardTimeline({
  name,
  clips,
  onClipClick,
  className,
}: StoryboardTimelineProps) {
  const sorted = [...clips].sort((a, b) => a.position - b.position);

  return (
    <div className={cn("bg-white rounded-xl border border-gray-200 shadow-sm", className)}>
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-medium text-gray-900">{name}</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          {clips.length} clip{clips.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {sorted.map((clip, i) => (
            <div
              key={clip.id}
              className="flex flex-col items-center gap-2 cursor-pointer group"
              onClick={() => onClipClick?.(clip)}
            >
              <div className="relative flex items-center gap-0">
                {i > 0 && (
                  <div className="w-4 h-0.5 bg-gray-300 group-hover:bg-blue-400 transition-colors" />
                )}
                <div
                  className={cn(
                    "w-24 h-16 rounded-lg border-2 border-transparent group-hover:border-blue-400 bg-gray-100 flex items-center justify-center overflow-hidden transition-all shrink-0",
                  )}
                >
                  {clip.thumbnailUrl ? (
                    <img
                      src={clip.thumbnailUrl}
                      alt={`Clip ${clip.position}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-xs text-gray-400">
                      #{clip.position}
                    </span>
                  )}
                </div>
                {i < sorted.length - 1 && (
                  <div className="w-4 h-0.5 bg-gray-300 group-hover:bg-blue-400 transition-colors" />
                )}
              </div>
              <div className="text-center">
                <span className="text-xs font-medium text-gray-600 block">
                  #{clip.position}
                </span>
                {clip.note && (
                  <span className="text-[10px] text-gray-400 block truncate max-w-[96px]">
                    {clip.note}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
