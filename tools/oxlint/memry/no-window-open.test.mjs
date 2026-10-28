import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './index.mjs'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('no-window-open', plugin.rules['no-window-open'], {
  valid: [
    'openLink(url)',
    // Locals and other objects named like it are not the window's.
    'function open(u) {} open(url)',
    'const window = frame; window.open(url)',
    'dialog.open(url)',
    'menu.open = true',
    'const { open } = useDisclosure(); open()',
    'setOpen(true)'
  ],
  invalid: [
    'window.open(url, "_blank", "noopener,noreferrer")',
    'window.open(url)',
    'globalThis.open(url)',
    'self.open(url)',
    'open(url, "_blank")',
    "window['open'](url)",
    // Handed on as a callback, it is still the engine's popup path.
    'items.forEach(window.open)',
    'const go = window.open; go(url)'
  ].map((code) => ({ code, errors: [{ messageId: 'opens' }] }))
})
