// Runs inside Electron 43.1.1: writes the parts of a profile that only Electron itself can
// produce (safeStorage ciphertexts, Chromium localStorage, Chromium custom dictionary).
const { app, BrowserWindow, safeStorage, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [appName, userData, plaintextsPath, storageHtml] = process.argv.slice(-4)

app.setName(appName)
app.setPath('userData', userData)

async function main() {
  await app.whenReady()
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable')

  // Same shape as secret-storage.ts writeStoreFile: { version: 1, entries: { service: { account: b64 } } }
  const plaintexts = JSON.parse(fs.readFileSync(plaintextsPath, 'utf-8'))
  const entries = {}
  for (const [service, accounts] of Object.entries(plaintexts)) {
    entries[service] = {}
    for (const [account, value] of Object.entries(accounts)) {
      entries[service][account] = safeStorage.encryptString(value).toString('base64')
    }
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'secure-secrets.json'),
    JSON.stringify({ version: 1, entries }, null, 2)
  )

  // The packaged renderer loads through loadFile, so the origin is file://.
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadFile(storageHtml)
  await session.defaultSession.addWordToSpellCheckerDictionary('memryfixtureword')
  await session.defaultSession.addWordToSpellCheckerDictionary('zettelkasten')
  await session.defaultSession.addWordToSpellCheckerDictionary('naïve')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await session.defaultSession.flushStorageData()
  win.destroy()
  app.quit()
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
