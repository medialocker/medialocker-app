"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useSets() {
  return useQuery({
    queryKey: ["sets"],
    queryFn: () => apiClient.sets.list(),
  });
}

export function useSet(id: string) {
  return useQuery({
    queryKey: ["sets", id],
    queryFn: () => apiClient.sets.get(id),
    enabled: !!id,
  });
}

export function useCreateSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; baseAssetId?: string }) =>
      apiClient.sets.create(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });
}

export function useDeleteSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.sets.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });
}

export function useAddSetItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      setId,
      mediaId,
      targets,
    }: {
      setId: string;
      mediaId: string;
      targets?: { aspectRatio?: string; width?: number; height?: number; role?: string };
    }) => apiClient.sets.addItem(setId, mediaId, targets),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["sets", variables.setId] });
    },
  });
}

export function useRemoveSetItem() {
  const queryClient = useQueryClient();
  return useMutation({
    // itemId is the set_item join id (not the object id) — that's what the backend keys on.
    mutationFn: ({ setId, itemId }: { setId: string; itemId: string }) =>
      apiClient.sets.removeItem(setId, itemId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["sets", variables.setId] });
    },
  });
}

export function useGenerateVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (setId: string) => apiClient.sets.generateVariants(setId),
    onSuccess: (_data, setId) => {
      queryClient.invalidateQueries({ queryKey: ["sets", setId] });
    },
  });
}
