import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './index.mjs'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('no-window-fanout', plugin.rules['no-window-fanout'], {
  valid: [
    'broadcastToAllWindows("channel", payload)',
    // a deliberate subset of windows is not a fan-out
    'for (const win of windowIds.map(getWindow)) win.webContents.send("c", p)',
    // two-step form is not statically distinguishable from window selection
    'const windows = BrowserWindow.getAllWindows(); for (const w of windows) w.webContents.send("c", p)',
    'BrowserWindow.getAllWindows().forEach((w) => w.focus())',
    'for (const w of BrowserWindow.getAllWindows()) w.close()'
  ],
  invalid: [
    {
      code: 'for (const w of BrowserWindow.getAllWindows()) { w.webContents.send("c", p) }',
      errors: [{ messageId: 'handRolled' }]
    },
    {
      code: 'BrowserWindow.getAllWindows().forEach((w) => { w.webContents.send("c", p) })',
      errors: [{ messageId: 'handRolled' }]
    }
  ]
})
