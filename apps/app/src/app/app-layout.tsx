"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { DashboardShellClient } from "@/components/dashboard/DashboardShellClient";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  useEffect(() => {
    if (!loading && !session && !isLoginPage) {
      router.push("/login");
    }
  }, [session, loading, isLoginPage, router]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (isLoginPage) {
    return <main>{children}</main>;
  }

  if (!session) {
    return null;
  }

  return <DashboardShellClient>{children}</DashboardShellClient>;
}
