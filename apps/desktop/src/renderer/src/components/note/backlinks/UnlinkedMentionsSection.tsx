import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { UnlinkedMention } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { ChevronDown } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { notesService } from '@/services/notes-service'
import { unlinkedMentionsKey, useUnlinkedMentionsQuery } from '@/hooks/use-unlinked-mentions'
import { notesKeys } from '@/hooks/use-notes-query'
import { BacklinksLoadingState } from './BacklinksLoadingState'

interface UnlinkedMentionsSectionProps {
  noteId: string
  onOpen: (noteId: string, title: string) => void
}

/**
 * Notes that mention this note's title or an alias as plain text (#3320).
 * Collapsed by default, and fetched only once opened: the scan reads every
 * candidate file.
 */
export function UnlinkedMentionsSection({ noteId, onOpen }: UnlinkedMentionsSectionProps) {
  const { t } = useT('notes')
  const [isOpen, setIsOpen] = useState(false)
  const { mentions, isLoading } = useUnlinkedMentionsQuery(noteId, isOpen)
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)

  const link = async (sourceId: string, ordinal: number) => {
    const key = `${sourceId}:${ordinal}`
    setPending(key)
    try {
      const { linked } = await notesService.linkMention({ sourceId, targetId: noteId, ordinal })
      if (!linked) toast.error(t('unlinkedMentions.gone'))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('unlinkedMentions.linkFailed')))
    } finally {
      setPending(null)
      void queryClient.invalidateQueries({ queryKey: unlinkedMentionsKey(noteId) })
      void queryClient.invalidateQueries({ queryKey: notesKeys.links(noteId) })
    }
  }

  return (
    <section className="flex flex-col gap-1" aria-label={t('unlinkedMentions.sectionAria')}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
        aria-expanded={isOpen}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 text-text-tertiary flex-shrink-0 transition-transform duration-150',
            !isOpen && '-rotate-90'
          )}
          aria-hidden="true"
        />
        <span className="text-xs/4 font-medium text-text-tertiary">
          {isOpen && !isLoading
            ? t('unlinkedMentions.summary', { count: mentions.length })
            : t('unlinkedMentions.title')}
        </span>
      </button>

      {isOpen &&
        (isLoading ? (
          <BacklinksLoadingState />
        ) : (
          <div className="flex flex-col">
            {mentions.map((source) => (
              <SourceMentions
                key={source.sourceId}
                source={source}
                pending={pending}
                onOpen={onOpen}
                onLink={(ordinal) => void link(source.sourceId, ordinal)}
              />
            ))}
          </div>
        ))}
    </section>
  )
}

function SourceMentions({
  source,
  pending,
  onOpen,
  onLink
}: {
  source: UnlinkedMention
  pending: string | null
  onOpen: (noteId: string, title: string) => void
  onLink: (ordinal: number) => void
}) {
  const { t } = useT('notes')
  return (
    <div role="group" aria-label={t('unlinkedMentions.fromAria', { title: source.sourceTitle })}>
      <button
        type="button"
        onClick={() => onOpen(source.sourceId, source.sourceTitle)}
        className="block max-w-full truncate px-1.5 py-1 text-start text-[13px]/4 font-medium text-text-bright hover:underline"
      >
        {source.sourceTitle}
      </button>
      <ul className="ms-5 flex flex-col gap-px">
        {source.contexts.map((context, ordinal) => (
          <li
            key={ordinal}
            className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-active/30"
          >
            <p className="flex-1 min-w-0 text-xs/[17px] text-text-tertiary line-clamp-3">
              {context.snippet.slice(0, context.linkStart)}
              <mark className="bg-transparent text-muted-foreground font-medium">
                {context.snippet.slice(context.linkStart, context.linkEnd)}
              </mark>
              {context.snippet.slice(context.linkEnd)}
            </p>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => onLink(ordinal)}
              className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary hover:text-muted-foreground hover:bg-surface-active/40 disabled:opacity-50"
              aria-label={t('unlinkedMentions.linkAria', {
                text: context.snippet.slice(context.linkStart, context.linkEnd)
              })}
            >
              {t('unlinkedMentions.link')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
