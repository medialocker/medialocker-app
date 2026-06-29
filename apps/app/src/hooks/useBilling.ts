"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export function useBilling() {
  return useQuery({
    queryKey: ["billing"],
    queryFn: () => apiClient.billing.get(),
  });
}

export function useAddCapacity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gb: number) => apiClient.billing.addCapacity(gb),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

export function useUpdateAutoCapacity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: { enabled: boolean; increment: number; threshold: number; maxSpend: number }) =>
      apiClient.billing.updateAutoCapacity(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

export function useDowngrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tierKey: string) => apiClient.billing.downgrade(tierKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });
}

export function usePortalSession() {
  return useMutation({
    mutationFn: () => apiClient.billing.portalSession(),
  });
}

export function useBillingInvoices() {
  return useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: () => apiClient.billing.invoices(),
  });
}

export function usePlans() {
  return useQuery({
    queryKey: ["plans"],
    queryFn: () => apiClient.billing.plans(),
    staleTime: 5 * 60 * 1000,
  });
}
