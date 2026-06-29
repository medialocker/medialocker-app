import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  TagSelector,
  type TagSuggestion,
} from "../src/components/TagSelector";

const tags: TagSuggestion[] = [
  { id: "1", name: "Nature", slug: "nature" },
  { id: "2", name: "Night", slug: "night" },
  { id: "3", name: "Portrait", slug: "portrait" },
];

describe("TagSelector", () => {
  it("renders the placeholder when nothing is selected", () => {
    render(
      <TagSelector
        tags={tags}
        selected={[]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText("Add tag...")).toBeInTheDocument();
  });

  it("renders selected tags", () => {
    render(
      <TagSelector
        tags={tags}
        selected={[tags[0]!]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("Nature")).toBeInTheDocument();
  });

  it("typing shows matching suggestions", () => {
    render(
      <TagSelector
        tags={tags}
        selected={[]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ni" } });

    expect(screen.getByText("Night")).toBeInTheDocument();
    expect(screen.queryByText("Portrait")).not.toBeInTheDocument();
  });

  it("caps suggestions at maxSuggestions", () => {
    const many: TagSuggestion[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      name: `tag-${i}`,
      slug: `tag-${i}`,
    }));
    render(
      <TagSelector
        tags={many}
        selected={[]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        maxSuggestions={3}
      />,
    );
    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "tag" } });

    const buttons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.startsWith("tag-"));
    expect(buttons).toHaveLength(3);
  });

  it("selecting a suggestion calls onSelect", () => {
    const onSelect = vi.fn();
    render(
      <TagSelector
        tags={tags}
        selected={[]}
        onSelect={onSelect}
        onRemove={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "nat" } });
    fireEvent.click(screen.getByText("Nature"));

    expect(onSelect).toHaveBeenCalledWith(tags[0]);
  });

  it("removing a selected tag calls onRemove", () => {
    const onRemove = vi.fn();
    render(
      <TagSelector
        tags={tags}
        selected={[tags[0]!]}
        onSelect={vi.fn()}
        onRemove={onRemove}
      />,
    );
    // The remove control is the "×" button inside the tag pill.
    const removeButton = screen.getByRole("button", { name: "×" });
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith(tags[0]);
  });

  it("creating a new tag calls onCreate then onSelect", async () => {
    const created: TagSuggestion = { id: "99", name: "Fresh", slug: "fresh" };
    const onCreate = vi.fn().mockResolvedValue(created);
    const onSelect = vi.fn();
    render(
      <TagSelector
        tags={tags}
        selected={[]}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Fresh" } });

    // The "Create" option appears for an unknown tag name.
    const createButton = screen.getByText("Create").closest("button")!;
    fireEvent.click(createButton);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Fresh"));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(created));
  });

  it("does not offer create for an exact existing tag name", () => {
    render(
      <TagSelector
        tags={tags}
        selected={[]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("Add tag...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Nature" } });
    expect(screen.queryByText("Create")).not.toBeInTheDocument();
  });
});
