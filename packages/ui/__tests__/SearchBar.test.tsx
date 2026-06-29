import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBar, type SearchFilter } from "../src/components/SearchBar";

describe("SearchBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the default placeholder", () => {
    render(<SearchBar onSearch={vi.fn()} />);
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("renders a custom placeholder", () => {
    render(<SearchBar onSearch={vi.fn()} placeholder="Find media" />);
    expect(screen.getByPlaceholderText("Find media")).toBeInTheDocument();
  });

  it("typing triggers onSearch after the debounce window", () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} debounceMs={300} />);

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "cat" },
    });

    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("cat", {});
  });

  it("debounce coalesces rapid input into a single call with the latest value", () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} debounceMs={300} />);
    const input = screen.getByPlaceholderText("Search...");

    fireEvent.change(input, { target: { value: "c" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "ca" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "cat" } });

    // Not enough time has passed since the last keystroke.
    expect(onSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("cat", {});
  });

  it("does not render the Filters button when no filters are provided", () => {
    render(<SearchBar onSearch={vi.fn()} />);
    expect(screen.queryByText("Filters")).not.toBeInTheDocument();
  });

  it("renders the filter UI when filters prop is passed and toggled open", () => {
    const filters: SearchFilter[] = [
      {
        key: "kind",
        label: "Kind",
        type: "select",
        options: [
          { value: "image", label: "Image" },
          { value: "video", label: "Video" },
        ],
      },
    ];
    render(<SearchBar onSearch={vi.fn()} filters={filters} />);

    const filterButton = screen.getByText("Filters");
    expect(filterButton).toBeInTheDocument();

    // Filter panel is hidden until toggled.
    expect(screen.queryByText("Kind")).not.toBeInTheDocument();
    fireEvent.click(filterButton);
    expect(screen.getByText("Kind")).toBeInTheDocument();
  });

  it("changing a filter triggers onSearch with the filter value", () => {
    const onSearch = vi.fn();
    const filters: SearchFilter[] = [
      {
        key: "kind",
        label: "Kind",
        type: "select",
        options: [{ value: "image", label: "Image" }],
      },
    ];
    render(<SearchBar onSearch={onSearch} filters={filters} debounceMs={0} />);

    fireEvent.click(screen.getByText("Filters"));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "image" },
    });

    vi.advanceTimersByTime(0);
    expect(onSearch).toHaveBeenCalledWith("", { kind: "image" });
  });
});
