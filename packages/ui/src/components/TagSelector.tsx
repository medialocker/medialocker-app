import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
} from "react";
import { cn } from "./_utils";

export interface TagSuggestion {
  id: string;
  name: string;
  slug: string;
}

export interface TagSelectorProps {
  tags: TagSuggestion[];
  selected: TagSuggestion[];
  onSelect: (tag: TagSuggestion) => void;
  onRemove: (tag: TagSuggestion) => void;
  onCreate?: (name: string) => Promise<TagSuggestion>;
  placeholder?: string;
  className?: string;
  maxSuggestions?: number;
}

export function TagSelector({
  tags,
  selected,
  onSelect,
  onRemove,
  onCreate,
  placeholder = "Add tag...",
  className,
  maxSuggestions = 8,
}: TagSelectorProps) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedIds = new Set(selected.map((t) => t.id));

  const suggestions = tags
    .filter(
      (t) =>
        !selectedIds.has(t.id) &&
        t.name.toLowerCase().includes(input.toLowerCase()),
    )
    .slice(0, maxSuggestions);

  const showCreate =
    input.trim().length > 0 &&
    onCreate &&
    !tags.some((t) => t.name.toLowerCase() === input.toLowerCase()) &&
    !selected.some((t) => t.name.toLowerCase() === input.toLowerCase());

  useEffect(() => {
    setActiveIndex(0);
  }, [input]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = useCallback(
    (tag: TagSuggestion) => {
      onSelect(tag);
      setInput("");
      setFocused(false);
      inputRef.current?.focus();
    },
    [onSelect],
  );

  const handleCreate = useCallback(async () => {
    if (!onCreate || !input.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const tag = await onCreate(input.trim());
      onSelect(tag);
      setInput("");
      setFocused(false);
    } finally {
      setIsCreating(false);
    }
  }, [input, onCreate, isCreating, onSelect]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const max = suggestions.length + (showCreate ? 1 : 0);
        setActiveIndex((i) => (i + 1) % Math.max(1, max));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const max = suggestions.length + (showCreate ? 1 : 0);
        setActiveIndex((i) => (i - 1 + max) % Math.max(1, max));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (showCreate && activeIndex >= suggestions.length) {
          handleCreate();
        } else if (suggestions[activeIndex]) {
          handleSelect(suggestions[activeIndex]);
        }
      } else if (e.key === "Escape") {
        setFocused(false);
      }
    },
    [suggestions, activeIndex, showCreate, handleSelect, handleCreate],
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 min-h-[42px] px-3 py-2 border rounded-lg transition-colors",
          "bg-white border-gray-300",
          focused && "border-blue-500 ring-2 ring-blue-100",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 text-sm rounded-full"
          >
            {tag.name}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(tag);
              }}
              className="hover:bg-blue-200 rounded-full w-4 h-4 inline-flex items-center justify-center text-xs"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] outline-none border-none bg-transparent text-sm py-0.5"
        />
      </div>

      {focused && (suggestions.length > 0 || showCreate) && (
        <div className="absolute z-50 top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {suggestions.map((tag, i) => (
            <button
              key={tag.id}
              type="button"
              className={cn(
                "w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors",
                i === activeIndex && "bg-blue-50 text-blue-700",
              )}
              onClick={() => handleSelect(tag)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {tag.name}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              className={cn(
                "w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors border-t border-gray-100",
                activeIndex >= suggestions.length && "bg-blue-50 text-blue-700",
              )}
              onClick={handleCreate}
              onMouseEnter={() => setActiveIndex(suggestions.length)}
            >
              <span className="text-gray-400">Create</span> &ldquo;{input}
              &rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
