import type { AppIcon } from '@/lib/icons'
import { Calendar, CalendarDays, FileInput, BookMarked, ListTodo } from '@/lib/icons'

export type AuthFlowType = 'oauth2' | 'api_key' | 'none'

export interface IntegrationDefinition {
  id: string
  name: string
  description: string
  icon: AppIcon
  authFlow: AuthFlowType
  comingSoon: boolean
}

const INTEGRATIONS = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Surface events in your daily journal',
    icon: Calendar,
    authFlow: 'oauth2',
    comingSoon: true
  },
  {
    id: 'apple-calendar',
    name: 'Apple Calendar',
    description: 'Local calendar integration via system APIs',
    icon: CalendarDays,
    authFlow: 'none',
    comingSoon: true
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'One-time page import into your vault',
    icon: FileInput,
    authFlow: 'oauth2',
    comingSoon: true
  },
  {
    id: 'readwise',
    name: 'Readwise',
    description: 'Sync highlights into your vault',
    icon: BookMarked,
    authFlow: 'api_key',
    comingSoon: true
  },
  {
    id: 'todoist',
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
