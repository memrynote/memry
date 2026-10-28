import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './index.mjs'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('no-location-navigation', plugin.rules['no-location-navigation'], {
  valid: [
    'location.reload()',
    'window.location.reload()',
    'const href = location.href',
    'const { pathname } = window.location',
    // Same-document: a fragment only scrolls.
    'location.hash = "#top"',
    'window.location.hash = id',
    // Locals of the same names are not the window's.
    'const location = locateBlock(doc, id); location.href = url',
    'function f(location) { location = next; location.pathname = p }',
    'const window = frame; window.location = url',
    'route.location = next',
    'const l = getRouter(); l.href = url',
    'let l = window.location; l = other',
    'window.open(url, "_blank", "noopener,noreferrer")',
    'window.open(url)',
    'function open(u, t) {} open(url, "_self")',
    'void commands.shellOpenExternal(url)'
  ],
  invalid: [
    'location.assign(url)',
    'window.location.assign(url)',
    'location.replace(url)',
    'document.location.replace(url)',
    'location.href = url',
    'window.location.href = url',
    'window.location = url',
    'document.location = url',
    'top.location = url',
    'parent.location.href = url',
    'location = url',
    'window["location"] = url',
    'window["location"].href = url',
    'location["href"] = url',
    'const l = window.location; l.href = url',
    'const l = location; l.assign(url)',
    'const l = document.location; l.pathname = "/x"',
    'location.pathname = "/x"',
    'location.search = "?q=1"',
    'location.host = "example.com"',
    'location.hostname = "example.com"',
    'location.port = "8080"',
    'location.protocol = "https:"',
    'window.open(url, "_self")',
    'window.open(url, "_top")',
    'open(url, "_parent")',
    'globalThis.open(url, "_self", "")'
  ].map((code) => ({ code, errors: [{ messageId: 'navigates' }] }))
})
