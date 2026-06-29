"use client";

import { useEffect } from "react";

// Replaces the root layout when an error escapes it (so it must render its own
// <html>/<body>). This is the last-resort boundary for the dashboard. (P1)
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          margin: 0,
          background: "#0B0B0F",
          color: "#EEEEF5",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px 20px",
          textAlign: "center",
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 8px" }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: 14, color: "#8080A0", maxWidth: 380, lineHeight: 1.55 }}>
          The dashboard failed to load. Please try again.
        </p>
        {error.digest && (
          <p style={{ fontSize: 11, color: "#505068", marginTop: 8, fontFamily: "monospace" }}>
            Ref: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          style={{
            marginTop: 24,
            padding: "11px 22px",
            borderRadius: 12,
            background: "#6D5EF6",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            border: "none",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
