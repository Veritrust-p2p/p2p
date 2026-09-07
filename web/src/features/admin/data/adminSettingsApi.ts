import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../shared/libs/api'

/** Test first, live second — the order the console offers them in. */
export type PaystackMode = 'test' | 'live'

export interface PaystackModeSettings {
  mode: PaystackMode
  updatedAt: string
  /** Whether the server actually holds each secret. A mode without its key
   *  cannot be selected, so the UI disables it rather than failing on submit. */
  testKeyConfigured: boolean
  liveKeyConfigured: boolean
}

export const adminSettingsKeys = {
  all: ['admin', 'settings'] as const,
  paystackMode: () => [...adminSettingsKeys.all, 'paystack-mode'] as const,
}

export function usePaystackMode() {
  return useQuery({
    queryKey: adminSettingsKeys.paystackMode(),
    queryFn: () => api<PaystackModeSettings>('/api/admin/settings/paystack-mode'),
    retry: false,
  })
}

/**
 * Switch the environment every Paystack charge runs against.
 *
 * No optimistic update on purpose: this decides whether real cards get charged,
 * so the UI should show what the server confirmed and nothing sooner.
 */
export function useSetPaystackMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mode: PaystackMode) =>
      api<PaystackModeSettings>('/api/admin/settings/paystack-mode', {
        method: 'PATCH',
        body: { mode },
      }),
    onSuccess: (settings) => {
      queryClient.setQueryData(adminSettingsKeys.paystackMode(), settings)
    },
  })
}
