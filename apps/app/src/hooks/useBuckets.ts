"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useBuckets() {
  return useQuery({
    queryKey: ["buckets"],
    queryFn: () => apiClient.buckets.list(),
  });
}

export function useCreateBucket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiClient.buckets.create(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
}

export function useDeleteBucket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.buckets.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
}
