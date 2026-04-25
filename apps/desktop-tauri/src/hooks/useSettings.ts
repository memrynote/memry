import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/ipc/invoke'
import type { Setting } from '@/generated/bindings'

const settingsKey = (key: string) => ['settings', key] as const
const settingsListKey = ['settings', 'list'] as const

export function useSetting(key: string) {
  return useQuery<string | null>({
    queryKey: settingsKey(key),
    queryFn: () => invoke<string | null>('settings_get', { input: { key } })
  })
}

export function useSettings() {
  return useQuery<Setting[]>({
    queryKey: settingsListKey,
    queryFn: () => invoke<Setting[]>('settings_list')
  })
}

export function useSetSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      invoke<void>('settings_set', { input: { key, value } }),
    onSuccess: (_, { key }) => {
      qc.invalidateQueries({ queryKey: settingsKey(key) })
      qc.invalidateQueries({ queryKey: settingsListKey })
    }
  })
}
