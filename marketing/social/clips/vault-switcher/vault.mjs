// Two more vaults next to Maya's, built with the app's own CLI: Work and Family. Each vault's
// icon is stored the way the app stores it (`vaultIcon` in .memry/config.json). The extra vaults
// sit beside the clip's vault; scenes.mjs copies them into the slot and opens them through the
// app's Open vault action.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { cliFor } from '../../vault/cli.mjs'

const setIcon = (vault, value) => {
  const file = path.join(vault, '.memry/config.json')
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  config.vaultIcon = { value, updatedAt: Date.now(), pendingSync: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
}

export default function ({ vault }) {
  const root = path.join(path.dirname(vault), 'extra')
  fs.mkdirSync(root, { recursive: true })
  const make = (name, icon, notes) => {
    const dir = path.join(root, name)
    const cli = cliFor(process.env.MEMRY_SOCIAL_APP, dir)
    fs.mkdirSync(dir, { recursive: true })
    cli('vault', 'init')
    cli('vault', 'update-config', JSON.stringify({ title: name }))
    for (const [title, content] of notes) cli('notes', 'create', title, '--content', content)
    setIcon(dir, icon)
  }
  setIcon(vault, '📓')
  make('Work', '💼', [
    ['Client pipeline', 'Studio North: design review Thursday.\n\nNext: send the proposal.'],
    ['Invoices', 'October invoices sent. Waiting on two.']
  ])
  make('Family', '🏡', [
    ['Weekend plans', "Saturday: market, then lunch at Mum's."],
    ['Gift ideas', 'Dad: a good notebook.']
  ])
}
