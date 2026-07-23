import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Plus } from '@/lib/icons'
import type { CreateCategoryResponse } from '@/services/tags-service'

export interface InlineCreateRowProps {
  onCreateCategory: (name: string) => Promise<CreateCategoryResponse>
  onCreateTag: (name: string) => Promise<void>
}

/**
 * Minimal placeholder for the tag hub's create affordances.
 * Task 10 wires the real inline-create behavior (text input, submit, focus
 * management). This task only needs the two buttons with the accessible
 * names asserted by `tags-hub.test.tsx` to exist.
 */
export function InlineCreateRow(_props: InlineCreateRowProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled>
        <Plus className="me-1.5 h-3.5 w-3.5" />
        {t('tagsHub.newCategory')}
      </Button>
      <Button variant="outline" size="sm" disabled>
        <Plus className="me-1.5 h-3.5 w-3.5" />
        {t('tagsHub.newTag')}
      </Button>
    </div>
  )
}

export default InlineCreateRow
