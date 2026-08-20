import type { AppIcon } from '@/lib/icons'
import { CalendarDays, FileInput, BookMarked, ListTodo } from '@/lib/icons'

export type AuthFlowType = 'oauth2' | 'api_key' | 'none'

export interface IntegrationDefinition {
  id: string
  i18nKey: string
  name: string
  description: string
  icon: AppIcon
  authFlow: AuthFlowType
  comingSoon: boolean
}

// Calendar providers are NOT listed here — `calendar:list-providers` reports
// them, because main is the only place that knows which ones this build ships
// and what each one can do. This list is for everything else.
const INTEGRATIONS = [
  {
    id: 'apple-calendar',
    i18nKey: 'appleCalendar',
    name: 'Apple Calendar',
    description: 'Local calendar integration via system APIs',
    icon: CalendarDays,
    authFlow: 'none',
    comingSoon: true
  },
  {
    id: 'notion',
    i18nKey: 'notion',
    name: 'Notion',
    description: 'One-time page import into your vault',
    icon: FileInput,
    authFlow: 'oauth2',
    comingSoon: true
  },
  {
    id: 'readwise',
    i18nKey: 'readwise',
    name: 'Readwise',
    description: 'Sync highlights into your vault',
    icon: BookMarked,
    authFlow: 'api_key',
    comingSoon: true
  },
  {
    id: 'todoist',
    i18nKey: 'todoist',
    name: 'Todoist',
    description: 'Two-way task sync',
    icon: ListTodo,
    authFlow: 'api_key',
    comingSoon: true
  }
] as const satisfies readonly IntegrationDefinition[]

export type IntegrationId = (typeof INTEGRATIONS)[number]['id']

export function getIntegration(id: IntegrationId): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.id === id)
}

export function getAvailableIntegrations(): readonly IntegrationDefinition[] {
  return INTEGRATIONS
}
