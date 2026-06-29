import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  UploadProgress,
  type UploadFile,
} from "../src/components/UploadProgress";

const files: UploadFile[] = [
  { id: "a", name: "pending.png", size: 1_000, progress: 0, status: "pending" },
  {
    id: "b",
    name: "uploading.png",
    size: 2_000_000,
    progress: 42,
    status: "uploading",
  },
  { id: "c", name: "done.png", size: 5_000_000, progress: 100, status: "done" },
  {
    id: "d",
    name: "error.png",
    size: 3_000,
    progress: 0,
    status: "error",
    error: "Upload failed",
  },
];

describe("UploadProgress", () => {
  it("renders the dropzone prompt", () => {
    render(<UploadProgress files={[]} onFilesSelected={vi.fn()} />);
    expect(
      screen.getByText("Drag & drop files or click to browse"),
    ).toBeInTheDocument();
  });

  it("renders a row for each file with its name", () => {
    render(<UploadProgress files={files} onFilesSelected={vi.fn()} />);
    expect(screen.getByText("pending.png")).toBeInTheDocument();
    expect(screen.getByText("uploading.png")).toBeInTheDocument();
    expect(screen.getByText("done.png")).toBeInTheDocument();
    expect(screen.getByText("error.png")).toBeInTheDocument();
  });

  it("summarizes counts by state", () => {
    render(<UploadProgress files={files} onFilesSelected={vi.fn()} />);
    // pending + uploading => 2 active
    expect(screen.getByText("2 uploading")).toBeInTheDocument();
    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("4 files")).toBeInTheDocument();
  });

  it("renders the error message for failed uploads", () => {
    render(<UploadProgress files={files} onFilesSelected={vi.fn()} />);
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
  });

  it("shows a waiting hint for pending files", () => {
    render(<UploadProgress files={files} onFilesSelected={vi.fn()} />);
    expect(screen.getByText("Waiting...")).toBeInTheDocument();
  });

  it("reflects in-progress percent via the progress bar width", () => {
    const { container } = render(
      <UploadProgress
        files={[files[1]!]}
        onFilesSelected={vi.fn()}
      />,
    );
    const bar = container.querySelector('[style*="width: 42%"]');
    expect(bar).not.toBeNull();
  });

  it("shows the formatted file size", () => {
    render(
      <UploadProgress files={[files[2]!]} onFilesSelected={vi.fn()} />,
    );
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
  });

  it("renders an accept hint and singular 'file' label", () => {
    render(
      <UploadProgress
        files={[files[0]!]}
        onFilesSelected={vi.fn()}
        accept="image/*"
      />,
    );
    expect(screen.getByText(/Accepts: image\/\*/)).toBeInTheDocument();
    expect(screen.getByText("1 file")).toBeInTheDocument();
  });
});
