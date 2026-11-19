import { newItemViewState } from '@/contexts/tabs/helpers'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useNavigateToPage } from '@/hooks/use-navigate-to-page'
import { useToday } from '@/hooks/use-today'
import {
  DEFAULT_JOURNAL_DRILL,
  JOURNAL_DATE_KEY,
  JOURNAL_VIEW_STATE_KEYS
} from '@/pages/journal-view-state'
import { useAppCommands } from './use-command-impls'

/**
 * The owner of the commands that open a page as a tab. A page whose feature is
 * switched off has no command: the palette must not offer a way to a page the
 * rail hides.
 */
export function usePageCommands(): void {
  const navigate = useNavigateToPage()
  const { isEnabled } = useFeatureFlags()
  const today = useToday()

  useAppCommands('pages', {
    'go.home': {
      run: () => navigate('home')
    },
    'go.inbox': {
      enabled: isEnabled('inbox'),
      run: () => navigate('inbox')
    },
    // Lands on today's day view even when the journal tab shows another day or a month.
    'go.journal': {
      enabled: isEnabled('journal'),
      run: () =>
        navigate('journal', {
          viewState: {
            [JOURNAL_DATE_KEY]: today,
            [JOURNAL_VIEW_STATE_KEYS.drill]: DEFAULT_JOURNAL_DRILL
          }
        })
    },
    'go.calendar': {
      enabled: isEnabled('calendar'),
      run: () => navigate('calendar')
    },
    'go.tasks': {
      enabled: isEnabled('tasks'),
      run: () => navigate('tasks')
    },
    'go.graph': {
      enabled: isEnabled('graph'),
      run: () => navigate('graph')
    },
    'go.tags': {
      run: () => navigate('tags')
    },
    'create.task': {
      enabled: isEnabled('tasks'),
      run: () => navigate('tasks', { viewState: newItemViewState('tasks') })
    },
    'create.calendarEvent': {
      enabled: isEnabled('calendar'),
      run: () => navigate('calendar', { viewState: newItemViewState('calendar') })
    },
    'create.inboxItem': {
      enabled: isEnabled('inbox'),
      run: () => navigate('inbox', { viewState: newItemViewState('inbox') })
    }
  })
}
