"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, AlertCircle, Loader2 } from "lucide-react";
import { LogoMark } from "@medialocker/ui";
import { useAuth } from "@/hooks/useAuth";

/* ─── Tokens ─────────────────────────────────────────── */
const C = {
  bg: "#0B0B0F",
  panel: "#15151C",
  border: "rgba(255,255,255,0.07)",
  text: "#EEEEF5",
  muted: "#8080A0",
  muted3: "#505068",
  violet: "#6D5EF6",
  violetHov: "#5B4EE0",
  input: "#1E1E28",
  inputBord: "rgba(255,255,255,0.1)",
  red: "#FC8181",
};

/* ─── Input ─────────────────────────────────────────── */
function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  suffix,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete: string;
  suffix?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 500,
          color: C.text,
          marginBottom: 6,
          letterSpacing: "-0.01em",
        }}
      >
        {label}
      </label>
      <div style={{ position: "relative" }}>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: "100%",
            padding: suffix ? "10px 44px 10px 14px" : "10px 14px",
            background: C.input,
            border: `1px solid ${focused ? C.violet : C.inputBord}`,
            borderRadius: 12,
            fontSize: 14,
            color: C.text,
            outline: "none",
            boxSizing: "border-box",
            boxShadow: focused ? "0 0 0 3px rgba(109,94,246,0.15)" : "none",
            transition: "border-color 0.15s, box-shadow 0.15s",
            fontFamily: "inherit",
          }}
        />
        {suffix && (
          <div
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
            }}
          >
            {suffix}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────── */
export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearError() {
    if (error) setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px 64px",
        fontFamily: "'Inter', system-ui, sans-serif",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Restrained violet glow */}
      <div
        style={{
          position: "absolute",
          top: "38%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 560,
          height: 420,
          background:
            "radial-gradient(ellipse at center, rgba(109,94,246,0.09) 0%, transparent 68%)",
          pointerEvents: "none",
        }}
      />

      {/* ── Narrow column ────────────────────────── */}
      <div style={{ width: "100%", maxWidth: 380, position: "relative" }}>
        {/* ── Centered header ──────────────────────── */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 18,
            }}
          >
            <LogoMark size={44} />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: C.text,
                lineHeight: 1.2,
              }}
            >
              Sign in to <span>Media</span>
              <span style={{ color: C.violet }}>Locker</span>
            </span>
          </div>

          <p
            style={{
              fontSize: 14,
              color: C.muted,
              lineHeight: 1.55,
              maxWidth: 300,
              margin: "0 auto",
            }}
          >
            Enter your credentials to access your dashboard.
          </p>
        </div>

        {/* ── Card ─────────────────────────────────── */}
        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: "28px 28px 24px",
          }}
        >
          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Field
                label="Email"
                type="email"
                value={email}
                onChange={(v) => {
                  setEmail(v);
                  clearError();
                }}
                placeholder="you@example.com"
                autoComplete="email"
              />

              <Field
                label="Password"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  clearError();
                }}
                placeholder="••••••••"
                autoComplete="current-password"
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    tabIndex={-1}
                    style={{
                      background: "none",
                      border: "none",
                      color: C.muted3,
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                      alignItems: "center",
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = C.muted)
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = C.muted3)
                    }
                  >
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                }
              />

              {error && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    padding: "10px 13px",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.28)",
                    borderRadius: 10,
                  }}
                >
                  <AlertCircle
                    size={15}
                    style={{ color: C.red, flexShrink: 0, marginTop: 1 }}
                  />
                  <p style={{ fontSize: 13, color: C.red, margin: 0, lineHeight: 1.45 }}>
                    {error}
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  background: C.violet,
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  cursor: loading ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  opacity: loading ? 0.68 : 1,
                  transition: "background 0.15s, transform 0.1s, opacity 0.15s",
                  fontFamily: "inherit",
                  marginTop: 4,
                }}
                onMouseEnter={(e) => {
                  if (!loading)
                    (e.currentTarget as HTMLElement).style.background = C.violetHov;
                }}
                onMouseLeave={(e) => {
                  if (!loading)
                    (e.currentTarget as HTMLElement).style.background = C.violet;
                }}
                onMouseDown={(e) => {
                  if (!loading)
                    (e.currentTarget as HTMLElement).style.transform = "scale(0.99)";
                }}
                onMouseUp={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "scale(1)";
                }}
              >
                {loading && (
                  <Loader2 size={15} style={{ animation: "ml-spin 1s linear infinite" }} />
                )}
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Spin keyframe */}
      <style>{`
        @keyframes ml-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
