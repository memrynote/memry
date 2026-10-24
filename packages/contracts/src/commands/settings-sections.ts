import type { CommandMeta } from './types'

/** Every Settings section a caller may open by name. */
export const SETTINGS_SECTIONS = [
  'general',
  'editor',
  'templates',
  'journal',
  'tasks',
  'inbox',
  'calendar',
  'vault',
  'appearance',
  'ai',
  'agent-providers',
  'agent-mcp',
  'import',
  'tags',
  'properties',
  'shortcuts',
  'command-line',
  'account',
  'features'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

type PascalCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Capitalize<Head>}${PascalCase<Tail>}`
  : Capitalize<S>

export type SettingsCommandId = `settings.open${PascalCase<SettingsSection>}`

function pascalCase(section: string): string {
  return section
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function settingsCommandId<S extends SettingsSection>(
  section: S
): `settings.open${PascalCase<S>}` {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- template-literal key computed from the section name; TS cannot carry PascalCase<S> through pascalCase()
  return `settings.open${pascalCase(section)}` as `settings.open${PascalCase<S>}`
}

interface SettingsCommandMeta extends CommandMeta {
  readonly context: 'app'
  readonly owner: 'settings'
  readonly group: 'settings'
}

/**
 * One "open this section" command per section, derived from the list so a new
 * section gets its command with its name. Labels are `menu:commands.settings<Section>`.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- template-literal key computed from the section name; TS cannot carry PascalCase<S> through pascalCase()
export const SETTINGS_COMMANDS = Object.fromEntries(
  SETTINGS_SECTIONS.map((section) => [
    settingsCommandId(section),
    {
      context: 'app',
      owner: 'settings',
      group: 'settings',
      i18nKey: `commands.settings${pascalCase(section)}`
    } satisfies SettingsCommandMeta
  ])
) as {
  readonly [S in SettingsSection as `settings.open${PascalCase<S>}`]: SettingsCommandMeta
}
