import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FieldFillStatus } from '@memry/contracts/tag-fill-api'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { tagsService } from '@/services/tags-service'

const FILL_STATUS_KEY = ['tags', 'fill-status'] as const

export function useFillStatus(): {
  status: FieldFillStatus | null
  visible: boolean
  refresh: () => void
} {
  const { enabled: aiEnabled } = useAISettingsContext()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: FILL_STATUS_KEY,
    queryFn: () => tagsService.getFillStatus(),
    enabled: aiEnabled,
    staleTime: 30_000
  })
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: FILL_STATUS_KEY }),
    [queryClient]
  )
  const status = query.data ?? null
  return { status, visible: aiEnabled && status?.available === true, refresh }
}
