import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MediaViewer } from "../src/components/MediaViewer";

describe("MediaViewer", () => {
  it("renders an <img> for image mime types", () => {
    const { container } = render(
      <MediaViewer src="/x.png" mimeType="image/png" alt="A cat" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/x.png");
    expect(img).toHaveAttribute("alt", "A cat");
  });

  it("renders a <video> for video mime types", () => {
    const { container } = render(
      <MediaViewer src="/x.mp4" mimeType="video/mp4" />,
    );
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("renders an <audio> element for audio mime types", () => {
    const { container } = render(
      <MediaViewer src="/x.mp3" mimeType="audio/mpeg" />,
    );
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("renders an <iframe> viewer for PDFs", () => {
    const { container } = render(
      <MediaViewer src="/doc.pdf" mimeType="application/pdf" />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("title", "PDF Viewer");
  });

  it("renders a <model-viewer> custom element for GLB models", () => {
    const { container } = render(
      <MediaViewer src="/m.glb" mimeType="model/gltf-binary" />,
    );
    const mv = container.querySelector("model-viewer");
    expect(mv).not.toBeNull();
    expect(mv).toHaveAttribute("src", "/m.glb");
  });

  it("falls back to an unsupported viewer for unknown types", () => {
    const { container, getByText } = render(
      <MediaViewer src="/x.bin" mimeType="application/octet-stream" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(getByText("Preview not available")).toBeInTheDocument();
    expect(getByText("application/octet-stream")).toBeInTheDocument();
  });

  it("treats SVG as unsupported (not an inline image viewer)", () => {
    const { container, getByText } = render(
      <MediaViewer src="/x.svg" mimeType="image/svg+xml" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("Preview not available")).toBeInTheDocument();
  });
});
