"use client";

import { usePathname, useRouter } from "next/navigation";
import { DashboardShell, type DashboardScreen } from "./DashboardShell";
import { useUsage } from "@/hooks/useUsage";
import { useAuth } from "@/hooks/useAuth";

/** Route each Figma "screen" id onto a real Next.js dashboard route. */
const ROUTE_BY_SCREEN: Record<DashboardScreen, string> = {
  library: "/media",
  upload: "/upload",
  organize: "/sets",
  search: "/search",
  buckets: "/buckets",
  apikeys: "/api-keys",
  usage: "/usage",
  billing: "/billing",
};

function screenFromPath(pathname: string): DashboardScreen {
  // Storyboards live under the Organize group but have their own route.
  if (pathname === "/storyboards" || pathname.startsWith("/storyboards/")) return "organize";
  const match = (Object.entries(ROUTE_BY_SCREEN) as [DashboardScreen, string][])
    .filter(([, route]) => pathname === route || pathname.startsWith(`${route}/`))
    // longest route prefix wins (so /media/123 → library, not a shorter match)
    .sort((a, b) => b[1].length - a[1].length)[0];
  return match?.[0] ?? "library";
}

export function DashboardShellClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const screen = screenFromPath(pathname);
  const { data: usage } = useUsage();
  const { session, signOut } = useAuth();

  return (
    <DashboardShell
      screen={screen}
      onNavigate={(s) => router.push(ROUTE_BY_SCREEN[s])}
      onExit={() => {
        window.location.href = process.env.NEXT_PUBLIC_WEB_URL || "https://medialocker.io";
      }}
      onSignOut={async () => {
        await signOut();
        router.push("/login");
      }}
      usedBytes={usage?.usedStorage}
      totalBytes={usage?.allocatedStorage}
      userEmail={session?.user?.email}
    >
      {children}
    </DashboardShell>
  );
}
