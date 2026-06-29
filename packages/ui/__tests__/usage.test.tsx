import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageGauge, CapacityBar } from "../src/components/usage";

describe("UsageGauge", () => {
  it("renders the default label and used/allocated summary", () => {
    render(<UsageGauge usedBytes={2_000_000_000} allocatedBytes={4_000_000_000} />);
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB / 4.0 GB")).toBeInTheDocument();
  });

  it("computes and displays the used percentage", () => {
    render(
      <UsageGauge usedBytes={1_000_000_000} allocatedBytes={4_000_000_000} />,
    );
    expect(screen.getByText("25% used")).toBeInTheDocument();
  });

  it("clamps percentage to 100 and warns near capacity", () => {
    render(
      <UsageGauge usedBytes={10_000_000_000} allocatedBytes={5_000_000_000} />,
    );
    expect(screen.getByText("100% used")).toBeInTheDocument();
    expect(screen.getByText("Near capacity")).toBeInTheDocument();
  });

  it("handles a zero allocation without dividing by zero", () => {
    render(<UsageGauge usedBytes={500} allocatedBytes={0} />);
    expect(screen.getByText("0% used")).toBeInTheDocument();
  });

  it("respects a custom label", () => {
    render(
      <UsageGauge usedBytes={0} allocatedBytes={1_000} label="Quota" />,
    );
    expect(screen.getByText("Quota")).toBeInTheDocument();
  });
});

describe("CapacityBar", () => {
  it("renders the breakdown header and total", () => {
    render(
      <CapacityBar
        data={[
          { label: "Images", bytes: 1_000_000_000 },
          { label: "Video", bytes: 3_000_000_000 },
        ]}
      />,
    );
    expect(screen.getByText("Storage Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Total: 4.0 GB")).toBeInTheDocument();
  });

  it("renders a legend entry per data slice with formatted size", () => {
    render(
      <CapacityBar
        data={[
          { label: "Images", bytes: 1_500_000 },
          { label: "Audio", bytes: 2_500 },
        ]}
      />,
    );
    expect(screen.getByText("Images (1.5 MB)")).toBeInTheDocument();
    expect(screen.getByText("Audio (2.5 KB)")).toBeInTheDocument();
  });
});
