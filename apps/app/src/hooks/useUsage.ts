"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useUsage() {
  return useQuery({
    queryKey: ["usage"],
    queryFn: () => apiClient.usage.get(),
    refetchInterval: 30_000,
  });
}

export function useUsageHistory() {
  return useQuery({
    queryKey: ["usage", "history"],
    queryFn: () => apiClient.usage.history(),
  });
}
