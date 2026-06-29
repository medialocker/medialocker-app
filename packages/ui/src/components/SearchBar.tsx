import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "./_utils";

export interface SearchFilter {
  key: string;
  label: string;
  options?: { value: string; label: string }[];
  type: "text" | "select" | "date-range";
}

export interface SearchBarProps {
  onSearch: (query: string, filters: Record<string, string>) => void;
  placeholder?: string;
  filters?: SearchFilter[];
  className?: string;
  debounceMs?: number;
}

export function SearchBar({
  onSearch,
  placeholder = "Search...",
  filters = [],
  className,
  debounceMs = 300,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>(
    {},
  );
  const [showFilters, setShowFilters] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const triggerSearch = useCallback(
    (q: string, f: Record<string, string>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onSearch(q, f);
      }, debounceMs);
    },
    [onSearch, debounceMs],
  );

  const handleQueryChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setQuery(v);
      triggerSearch(v, activeFilters);
    },
    [triggerSearch, activeFilters],
  );

  const handleFilterChange = useCallback(
    (key: string, value: string) => {
      const next = { ...activeFilters, [key]: value };
      if (!value) delete next[key];
      setActiveFilters(next);
      triggerSearch(query, next);
    },
    [triggerSearch, query, activeFilters],
  );

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setShowFilters(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const hasActiveFilters = Object.keys(activeFilters).length > 0;

  return (
    <div className={cn("w-full", className)} onKeyDown={handleKeyDown}>
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder={placeholder}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                triggerSearch("", activeFilters);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              ×
            </button>
          )}
        </div>

        {filters.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 border rounded-lg text-sm transition-colors",
              hasActiveFilters
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-gray-300 text-gray-600 hover:bg-gray-50",
            )}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
              />
            </svg>
            Filters
            {hasActiveFilters && (
              <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 inline-flex items-center justify-center">
                {Object.keys(activeFilters).length}
              </span>
            )}
          </button>
        )}
      </div>

      {showFilters && filters.length > 0 && (
        <div className="mt-2 p-4 bg-white border border-gray-200 rounded-lg shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filters.map((filter) => (
            <div key={filter.key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {filter.label}
              </label>
              {filter.type === "select" && filter.options ? (
                <select
                  value={activeFilters[filter.key] ?? ""}
                  onChange={(e) =>
                    handleFilterChange(filter.key, e.target.value)
                  }
                  className="border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All</option>
                  {filter.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : filter.type === "date-range" ? (
                <input
                  type="date"
                  value={activeFilters[filter.key] ?? ""}
                  onChange={(e) =>
                    handleFilterChange(filter.key, e.target.value)
                  }
                  className="border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              ) : (
                <input
                  type="text"
                  value={activeFilters[filter.key] ?? ""}
                  onChange={(e) =>
                    handleFilterChange(filter.key, e.target.value)
                  }
                  placeholder={`Filter by ${filter.label.toLowerCase()}...`}
                  className="border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          ))}
          {hasActiveFilters && (
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => {
                  setActiveFilters({});
                  triggerSearch(query, {});
                }}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
