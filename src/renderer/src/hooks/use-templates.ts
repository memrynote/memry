/**
 * useTemplates Hook
 *
 * Provides template management functionality with automatic refresh on events.
 */

import { useState, useEffect, useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:Templates')
import {
  templatesService,
  onTemplateCreated,
  onTemplateUpdated,
  onTemplateDeleted,
  type Template,
  type TemplateListItem,
  type TemplateCreateInput,
  type TemplateUpdateInput
} from '@/services/templates-service'

interface UseTemplatesOptions {
  /** Whether to auto-load templates on mount */
  autoLoad?: boolean
}

interface UseTemplatesReturn {
  /** List of templates */
  templates: TemplateListItem[]
  /** Whether templates are loading */
  isLoading: boolean
  /** Error message if any */
  error: string | null
  /** Reload templates list */
  reload: () => Promise<void>
  /** Get a single template by ID */
  getTemplate: (id: string) => Promise<Template | null>
  /** Create a new template */
  createTemplate: (input: TemplateCreateInput) => Promise<Template | null>
  /** Update a template */
  updateTemplate: (input: TemplateUpdateInput) => Promise<Template | null>
  /** Delete a template */
  deleteTemplate: (id: string) => Promise<boolean>
  /** Duplicate a template */
  duplicateTemplate: (id: string, newName: string) => Promise<Template | null>
}

export function useTemplates(options: UseTemplatesOptions = {}): UseTemplatesReturn {
  const { autoLoad = true } = options

  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await templatesService.list()
      setTemplates(response.templates)
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to load templates'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  const getTemplate = useCallback(async (id: string): Promise<Template | null> => {
    try {
      return await templatesService.get(id)
    } catch (err) {
      log.error('Failed to get template:', err)
      return null
    }
  }, [])

  const createTemplate = useCallback(
    async (input: TemplateCreateInput): Promise<Template | null> => {
      try {
        const response = await templatesService.create(input)
        if (response.success && response.template) {
          // Optimistic update
          setTemplates((prev) => [
            ...prev,
            {
              id: response.template!.id,
              name: response.template!.name,
              description: response.template!.description,
              icon: response.template!.icon,
              isBuiltIn: false
            }
          ])
          return response.template
        }
        return null
      } catch (err) {
        log.error('Failed to create template:', err)
        return null
      }
    },
    []
  )

  const updateTemplate = useCallback(
    async (input: TemplateUpdateInput): Promise<Template | null> => {
      try {
        const response = await templatesService.update(input)
        if (response.success && response.template) {
          // Optimistic update
          setTemplates((prev) =>
            prev.map((t) =>
              t.id === input.id
                ? {
                    ...t,
                    name: response.template!.name,
                    description: response.template!.description,
                    icon: response.template!.icon
                  }
                : t
            )
          )
          return response.template
        }
        return null
      } catch (err) {
        log.error('Failed to update template:', err)
        return null
      }
    },
    []
  )

  const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await templatesService.delete(id)
      if (response.success) {
        // Optimistic update
        setTemplates((prev) => prev.filter((t) => t.id !== id))
        return true
      }
      return false
    } catch (err) {
      log.error('Failed to delete template:', err)
      return false
    }
  }, [])

  const duplicateTemplate = useCallback(
    async (id: string, newName: string): Promise<Template | null> => {
      try {
        const response = await templatesService.duplicate(id, newName)
        if (response.success && response.template) {
          // Optimistic update
          setTemplates((prev) => [
            ...prev,
            {
              id: response.template!.id,
              name: response.template!.name,
              description: response.template!.description,
              icon: response.template!.icon,
              isBuiltIn: false
            }
          ])
          return response.template
        }
        return null
      } catch (err) {
        log.error('Failed to duplicate template:', err)
        return null
      }
    },
    []
  )

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad) {
      reload()
    }
  }, [autoLoad, reload])

  // Subscribe to template events
  useEffect(() => {
    const unsubCreated = onTemplateCreated(() => {
      reload()
    })
    const unsubUpdated = onTemplateUpdated(() => {
      reload()
    })
    const unsubDeleted = onTemplateDeleted(() => {
      reload()
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
    }
  }, [reload])

  return {
    templates,
    isLoading,
    error,
    reload,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate
  }
}

export default useTemplates
