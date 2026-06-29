"use client";

import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useSearch(query: string, filters?: Record<string, string>, page?: number) {
  return useQuery({
    queryKey: ["search", query, filters, page],
    queryFn: () => apiClient.search.query(query, filters, page),
    enabled: query.length > 0,
  });
}

export function useInfiniteSearch(query: string, filters?: Record<string, string>) {
  return useInfiniteQuery({
    queryKey: ["search-infinite", query, filters],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => apiClient.search.query(query, filters, pageParam as number),
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.media.length, 0);
      const total = allPages[0]?.total ?? 0;
      return loaded < total ? allPages.length + 1 : undefined;
    },
    enabled: query.length > 0,
  });
}
