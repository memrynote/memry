import { describe, expect, it } from 'vitest'
import { COMMANDS, SETTINGS_SECTIONS, type CommandId } from '@memry/contracts/commands'

// The types make an owner supply every id it names. They cannot say an owner is
// rendered anywhere, so this reads the renderer's sources: each command id must
// be written out in a file that registers behavior for it.
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true
})

const registrars = Object.entries(sources).filter(([, source]) =>
  /\buse(App|Tab)Commands\(|\bregisterCommands\(|\buseEditorCommands\b/.test(source)
)

describe('command owners', () => {
  it('finds the files that register commands', () => {
    expect(registrars.length).toBeGreaterThan(5)
  })

  it.each((Object.keys(COMMANDS) as CommandId[]).filter((id) => !id.startsWith('settings.open')))(
    '%s has an owner that registers it',
    (id) => {
      const owners = registrars.filter(([, source]) => source.includes(`'${id}'`))
      expect(
        owners.map(([path]) => path),
        id
      ).not.toHaveLength(0)
    }
  )

  it('registers one settings command per section from the section list', () => {
    const [, source] =
      registrars.find(([path]) => path.endsWith('settings-modal-context.tsx')) ?? []
    expect(source).toContain('SETTINGS_SECTIONS.map')
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0)
  })
})
