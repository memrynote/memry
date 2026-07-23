import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTagCategories } from '@/hooks/use-tag-categories'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { CategoryBlock } from '@/components/tags-hub/category-block'
import { InlineCreateRow } from '@/components/tags-hub/inline-create-row'

export function TagsHubPage(): React.JSX.Element {
  const { t } = useT('notes')
  const { categories, uncategorized, isLoading, error, createCategory, createTag } =
    useTagCategories()
  const { openSidebarItem } = useSidebarNavigation()

  const handleTagOpen = (tag: string): void => {
    openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag })
  }

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
            {categories.map((category) => (
              <CategoryBlock
                key={category.id}
                id={category.id}
                name={category.name}
                tags={category.tags}
                onTagOpen={handleTagOpen}
              />
            ))}
            <CategoryBlock
              id={null}
              name={t('tagsHub.uncategorized')}
              tags={uncategorized}
              onTagOpen={handleTagOpen}
            />
            <InlineCreateRow onCreateCategory={createCategory} onCreateTag={createTag} />
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
