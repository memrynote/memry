import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp } from '@/lib/icons'
import type { WritingToolsSession, WritingTrimReview } from './writing-tools-session'

interface TrimReviewBarProps {
  session: WritingToolsSession
  trim: WritingTrimReview
}

/** Floating bottom-center bar for stepping through trim suggestions. */
export function TrimReviewBar({ session, trim }: TrimReviewBarProps) {
  const { t } = useT('notes')
  return (
    <div
      role="toolbar"
      aria-label={t('writingTools.trimReview.aria')}
      data-marquee-ignore
      className="absolute inset-x-0 bottom-6 z-30 mx-auto flex w-fit items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
    >
      <span className="px-1.5 text-xs tabular-nums text-text-secondary" aria-live="polite">
        {t('writingTools.trimReview.position', {
          position: trim.focusedIndex + 1,
          total: trim.ids.length
        })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={t('writingTools.trimReview.previous')}
        onClick={() => session.focusTrim(-1)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={t('writingTools.trimReview.next')}
        onClick={() => session.focusTrim(1)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5"
        onClick={() => session.keepTrim()}
      >
        {t('writingTools.trimReview.keep')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5"
        onClick={() => session.cutTrim()}
      >
        {t('writingTools.trimReview.cut')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5"
        onClick={() => session.cutAllTrims()}
      >
        {t('writingTools.trimReview.cutAll')}
      </Button>
    </div>
  )
}
