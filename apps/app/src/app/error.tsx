"use client";

import { useEffect } from "react";

export default function Error({
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
    <div
      style={{
        minHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px",
        textAlign: "center",
        color: "#EEEEF5",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 8px" }}>
        Something went wrong
      </h1>
      <p style={{ fontSize: 14, color: "#8080A0", maxWidth: 360, lineHeight: 1.55 }}>
        We hit an unexpected error loading this screen. Try again, or reload the
        dashboard.
      </p>
      {error.digest && (
        <p style={{ fontSize: 11, color: "#505068", marginTop: 8, fontFamily: "monospace" }}>
          Ref: {error.digest}
        </p>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
        <button
          onClick={reset}
          style={{
            padding: "10px 20px",
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
        <a
          href="/"
          style={{
            padding: "10px 20px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#8080A0",
            fontSize: 14,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          Dashboard home
        </a>
      </div>
    </div>
  );
}
