import { useCallback, useEffect, useState } from 'react'
import type { CreateThemeInput, CustomTheme, UpdateThemeInput } from '@memry/contracts/themes-api'
import {
  themesService,
  onThemeCreated,
  onThemeUpdated,
  onThemeDeleted
} from '@/services/themes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('CustomThemes')

interface UseCustomThemesResult {
  themes: CustomTheme[]
  isLoading: boolean
  createTheme: (input: CreateThemeInput) => Promise<CustomTheme | null>
  updateTheme: (id: string, updates: UpdateThemeInput) => Promise<CustomTheme | null>
  deleteTheme: (id: string) => Promise<boolean>
}

export function useCustomThemes(): UseCustomThemesResult {
  const [themes, setThemes] = useState<CustomTheme[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setThemes(await themesService.list())
    } catch (err) {
      log.warn('Failed to load custom themes', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    const unsubscribes = [
      onThemeCreated(() => void reload()),
      onThemeUpdated(() => void reload()),
      onThemeDeleted(() => void reload())
    ]
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [reload])

  const createTheme = useCallback(async (input: CreateThemeInput) => {
    try {
      const result = await themesService.create(input)
      return result.success ? (result.theme ?? null) : null
    } catch (err) {
      log.warn('Failed to create theme', err)
      return null
    }
  }, [])

  const updateTheme = useCallback(async (id: string, updates: UpdateThemeInput) => {
    try {
      const result = await themesService.update({ id, ...updates })
      return result.success ? (result.theme ?? null) : null
    } catch (err) {
      log.warn('Failed to update theme', err)
      return null
    }
  }, [])

  const deleteTheme = useCallback(async (id: string) => {
    try {
      return (await themesService.delete({ id })).success
    } catch (err) {
      log.warn('Failed to delete theme', err)
      return false
    }
  }, [])

  return { themes, isLoading, createTheme, updateTheme, deleteTheme }
}
