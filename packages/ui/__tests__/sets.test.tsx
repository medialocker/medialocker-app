import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  SetCard,
  StoryboardTimeline,
  type StoryboardClipData,
} from "../src/components/sets";

describe("SetCard", () => {
  it("renders the name and pluralized item count", () => {
    render(<SetCard id="s1" name="Vacation" itemCount={3} />);
    expect(screen.getByText("Vacation")).toBeInTheDocument();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("uses the singular label for a single item", () => {
    render(<SetCard id="s1" name="Solo" itemCount={1} />);
    expect(screen.getByText("1 item")).toBeInTheDocument();
  });

  it("renders a thumbnail when provided, else a placeholder", () => {
    const { rerender, container } = render(
      <SetCard id="s1" name="Set" itemCount={1} thumbnailUrl="/t.jpg" />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/t.jpg");

    rerender(<SetCard id="s1" name="Set" itemCount={1} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("No preview")).toBeInTheDocument();
  });

  it("calls onClick with the set id", () => {
    const onClick = vi.fn();
    render(
      <SetCard id="abc" name="Set" itemCount={1} onClick={onClick} />,
    );
    fireEvent.click(screen.getByText("Set"));
    expect(onClick).toHaveBeenCalledWith("abc");
  });
});

describe("StoryboardTimeline", () => {
  const clips: StoryboardClipData[] = [
    { id: "c2", objectId: "o2", position: 2, note: "second" },
    { id: "c1", objectId: "o1", position: 1, note: "first" },
    { id: "c3", objectId: "o3", position: 3 },
  ];

  it("renders the name and clip count", () => {
    render(<StoryboardTimeline name="Board" clips={clips} />);
    expect(screen.getByText("Board")).toBeInTheDocument();
    expect(screen.getByText("3 clips")).toBeInTheDocument();
  });

  it("renders clips sorted by position", () => {
    const withThumbs: StoryboardClipData[] = clips.map((c) => ({
      ...c,
      thumbnailUrl: `/thumb-${c.id}.jpg`,
    }));
    const { container } = render(
      <StoryboardTimeline name="Board" clips={withThumbs} />,
    );
    // With thumbnails, each clip renders exactly one "#<position>" label.
    const positions = within(container)
      .getAllByText(/^#\d+$/)
      .map((el) => el.textContent);
    expect(positions).toEqual(["#1", "#2", "#3"]);
  });

  it("renders clip notes when present", () => {
    render(<StoryboardTimeline name="Board" clips={clips} />);
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("calls onClipClick with the clicked clip", () => {
    const onClipClick = vi.fn();
    render(
      <StoryboardTimeline
        name="Board"
        clips={clips}
        onClipClick={onClipClick}
      />,
    );
    fireEvent.click(screen.getByText("first"));
    expect(onClipClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", position: 1 }),
    );
  });
});
