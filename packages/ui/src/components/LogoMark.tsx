/* Canonical MediaLocker mark — "Frame Stack" (40×40 viewBox).
   Three equal rounded rects (22×15, rx 2.5) stacked with a 3px
   diagonal offset; back two peek only at left + bottom edges.
   Inner 14×7.5 aperture (≈16:9) encodes the multi-ratio sets feature. */

export type LogoMarkMode = "color" | "white" | "black";

export interface LogoMarkProps {
  size?: number;
  mode?: LogoMarkMode;
}

export function LogoMark({ size = 32, mode = "color" }: LogoMarkProps) {
  const fills = {
    color: {
      back: { fill: "#6D5EF6", fillOpacity: 0.2 },
      mid: { fill: "#6D5EF6", fillOpacity: 0.5 },
      front: { fill: "#6D5EF6", fillOpacity: 1 },
      window: { fill: "#ffffff", fillOpacity: 0.18 },
    },
    white: {
      back: { fill: "#ffffff", fillOpacity: 0.2 },
      mid: { fill: "#ffffff", fillOpacity: 0.52 },
      front: { fill: "#ffffff", fillOpacity: 1 },
      window: { fill: "#ffffff", fillOpacity: 0.22 },
    },
    black: {
      back: { fill: "#111118", fillOpacity: 0.14 },
      mid: { fill: "#111118", fillOpacity: 0.4 },
      front: { fill: "#111118", fillOpacity: 0.9 },
      window: { fill: "#ffffff", fillOpacity: 0.35 },
    },
  } as const;

  const f = fills[mode];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      {/* Back frame — peeks left + bottom */}
      <rect x="6" y="15" width="22" height="15" rx="2.5" {...f.back} />
      {/* Mid frame */}
      <rect x="9" y="12" width="22" height="15" rx="2.5" {...f.mid} />
      {/* Front frame */}
      <rect x="12" y="9" width="22" height="15" rx="2.5" {...f.front} />
      {/* Inner aperture — 14×7.5 ≈ 16:9 */}
      <rect x="16" y="13" width="14" height="7.5" rx="1.5" {...f.window} />
    </svg>
  );
}
