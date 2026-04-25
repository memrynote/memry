import { describe, expect, it } from 'vitest'

import {
  extractBindingsCommands,
  extractElectronChannels,
  extractForwarderDomains,
  extractGenerateHandlerCommands,
  extractInvokeLiterals,
  extractMockRouteKeys,
} from './command-parity-audit'

describe('extractInvokeLiterals', () => {
  it('returns the literal string passed to invoke()', () => {
    // #given a renderer file
    const src = "await invoke('settings_get', { key: 'a' })"

    // #when scanning for literals
    const found = extractInvokeLiterals(src)

    // #then the command name is captured
    expect(found).toEqual(['settings_get'])
  })

  it('captures generic-typed invoke<T>(name)', () => {
    // #given a renderer file using the typed invoke
    const src = "const x = await invoke<Foo>('notes_list', { folder })"

    // #when scanning for literals
    const found = extractInvokeLiterals(src)

    // #then the command name is captured
    expect(found).toEqual(['notes_list'])
  })

  it('ignores non-string-literal invoke calls', () => {
    // #given dynamic invoke usage
    const src = 'await invoke(name, args)'

    // #when scanning for literals
    const found = extractInvokeLiterals(src)

    // #then dynamic calls do not produce a literal
    expect(found).toEqual([])
  })
})

describe('extractForwarderDomains', () => {
  it('captures the domain prefix from createInvokeForwarder', () => {
    // #given a service module wires a forwarder
    const src = "createInvokeForwarder<NotesAPI>('notes')"

    // #when scanning for forwarder domains
    const found = extractForwarderDomains(src)

    // #then the domain prefix is captured
    expect(found).toEqual(['notes'])
  })
})

describe('extractMockRouteKeys', () => {
  it('returns top-level route keys from a Routes object literal', () => {
    // #given a mock module with two top-level routes and one nested object
    const src = [
      "export const updaterRoutes: MockRouteMap = {",
      '  updater_get_state: async () => state,',
      '  updater_check_for_updates: async () => state,',
      '  meta: { unrelated: 1 }',
      '}',
    ].join('\n')

    // #when extracting keys
    const found = extractMockRouteKeys(src)

    // #then only the top-level keys with the route shape come back
    expect(found.sort()).toEqual(['meta', 'updater_check_for_updates', 'updater_get_state'])
  })
})

describe('extractGenerateHandlerCommands', () => {
  it('extracts the last segment of every entry in generate_handler!', () => {
    // #given a Tauri lib.rs handler list
    const src = [
      'tauri::generate_handler![',
      '  commands::settings::settings_get,',
      '  commands::settings::settings_set,',
      '  commands::lifecycle::notify_flush_done,',
      ']',
    ].join('\n')

    // #when parsing the macro body
    const found = extractGenerateHandlerCommands(src)

    // #then we get the bare command names
    expect(found.sort()).toEqual(['notify_flush_done', 'settings_get', 'settings_set'])
  })
})

describe('extractBindingsCommands', () => {
  it('captures __TAURI_INVOKE("name") calls from the generated bindings', () => {
    // #given a specta-generated bindings snippet
    const src = `
      settingsGet: () => __TAURI_INVOKE("settings_get", { input }),
      notifyFlushDone: () => __TAURI_INVOKE("notify_flush_done"),
    `

    // #when parsing it
    const found = extractBindingsCommands(src)

    // #then both names are reported
    expect(found.sort()).toEqual(['notify_flush_done', 'settings_get'])
  })
})

describe('extractElectronChannels', () => {
  it('captures kebab-style "domain:method" entries from generated-ipc-invoke-map.ts', () => {
    // #given a snippet of the Electron generated map
    const src = [
      'export interface MainIpcInvokeHandlers {',
      '  "auth:request-otp": (...args: []) => Awaited<unknown>',
      '  "calendar:list-events": (...args: []) => Awaited<unknown>',
      '}',
    ].join('\n')

    // #when extracting channels
    const found = extractElectronChannels(src)

    // #then both channels surface
    expect(found.sort()).toEqual(['auth:request-otp', 'calendar:list-events'])
  })
})
