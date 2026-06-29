"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useStoryboards() {
  return useQuery({
    queryKey: ["storyboards"],
    queryFn: () => apiClient.storyboards.list(),
  });
}

export function useStoryboard(id: string) {
  return useQuery({
    queryKey: ["storyboards", id],
    queryFn: () => apiClient.storyboards.get(id),
    enabled: !!id,
  });
}

export function useCreateStoryboard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      apiClient.storyboards.create(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storyboards"] });
    },
  });
}

export function useDeleteStoryboard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.storyboards.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storyboards"] });
    },
  });
}

export function useAddClip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ storyboardId, mediaId, order }: { storyboardId: string; mediaId: string; order: number }) =>
      apiClient.storyboards.addClip(storyboardId, mediaId, order),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["storyboards", vars.storyboardId] });
    },
  });
}

export function useRemoveClip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ storyboardId, clipId }: { storyboardId: string; clipId: string }) =>
      apiClient.storyboards.removeClip(storyboardId, clipId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["storyboards", vars.storyboardId] });
    },
  });
}

export function useReorderClips() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ storyboardId, clipIds }: { storyboardId: string; clipIds: string[] }) =>
      apiClient.storyboards.reorder(storyboardId, clipIds),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["storyboards", vars.storyboardId] });
    },
  });
}
