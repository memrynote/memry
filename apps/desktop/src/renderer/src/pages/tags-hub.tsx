import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTagCategories } from '@/hooks/use-tag-categories'
import { InlineCreateRow } from '@/components/tags-hub/inline-create-row'

export function TagsHubPage(): React.JSX.Element {
  const { t } = useT('notes')
  const { categories, uncategorized, isLoading, error, createCategory, createTag } =
    useTagCategories()

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('tagsHub.loading')}</div>
        ) : (
          <>
            {/* Category blocks land here in Task 9 */}
            <InlineCreateRow onCreateCategory={createCategory} onCreateTag={createTag} />
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
