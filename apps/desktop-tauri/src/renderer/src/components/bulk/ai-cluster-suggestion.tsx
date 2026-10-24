import { Lightbulb, Plus, X } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import type { InboxItemListItem } from '@/types'
import { useT } from '@memry/i18n/renderer'

interface ClusterSuggestion {
  items: InboxItemListItem[]
  reason: string
}

interface AIClusterSuggestionProps {
  suggestion: ClusterSuggestion
  onAddToSelection: () => void
  onDismiss: () => void
}

const AIClusterSuggestion = ({
  suggestion,
  onAddToSelection,
  onDismiss
}: AIClusterSuggestionProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('inbox')
  return (
    <div className="flex items-center justify-center gap-3 text-sm">
      <Lightbulb className="size-4 text-yellow-500" aria-hidden="true" />
      <span className="text-[var(--muted-foreground)]">
        {tPhaseF('phaseF.componentsBulkAiClusterSuggestion.aiDetected')}
        {suggestion.reason}"
      </span>
      <Button variant="outline" size="sm" onClick={onAddToSelection} className="gap-1.5 h-7">
        <Plus className="size-3" aria-hidden="true" />

        {tPhaseF('phaseF.componentsBulkAiClusterSuggestion.addToSelection')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        className="gap-1.5 h-7 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <X className="size-3" aria-hidden="true" />

        {tPhaseF('phaseF.componentsBulkAiClusterSuggestion.dismiss')}
      </Button>
    </div>
  )
}

export { AIClusterSuggestion }
