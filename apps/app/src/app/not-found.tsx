import Link from "next/link";

export default function NotFound() {
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
      <p style={{ fontSize: "3.5rem", fontWeight: 800, letterSpacing: "-0.04em", margin: 0, color: "#6D5EF6" }}>
        404
      </p>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.02em", margin: "12px 0 8px" }}>
        Page not found
      </h1>
      <p style={{ fontSize: 14, color: "#8080A0", maxWidth: 340, lineHeight: 1.55 }}>
        This page doesn&apos;t exist in your dashboard.
      </p>
      <Link
        href="/"
        style={{
          marginTop: 24,
          padding: "10px 20px",
          borderRadius: 12,
          background: "#6D5EF6",
          color: "#fff",
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Go to dashboard
      </Link>
    </div>
  );
}
