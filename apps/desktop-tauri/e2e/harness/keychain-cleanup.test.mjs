import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KEYCHAIN_ACCOUNTS,
  isE2eDeviceId,
  isPurgeableE2eEntry,
  keychainAccountsForDevice,
  linuxAccountsForDevice,
  parseCmdkeyList,
  parseKeychainDump,
  parseSecretToolSearch,
  parseWindowsTarget,
  windowsTargetsForDevice
} from './keychain-cleanup.mjs'

const SYNC = 'com.memry.sync'
const OWN = 'com.memrynote.memry'
const UUID = 'acc474be-3e59-4621-a8ea-fba2ddd008cc'

test('the account list matches KEYCHAIN_ENTRIES in @memry/contracts', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../packages/contracts/src/crypto.ts', import.meta.url)),
    'utf8'
  )
  const block = source.slice(source.indexOf('export const KEYCHAIN_ENTRIES'))
  const accounts = [...block.slice(0, block.indexOf('} as const')).matchAll(/account: '([^']+)'/g)]
  assert.deepEqual(
    accounts.map((match) => match[1]),
    KEYCHAIN_ACCOUNTS
  )
})

test('only e2e device ids are purgeable', () => {
  assert.equal(isE2eDeviceId(`e2e-${UUID}-A`), true)
  for (const id of [
    undefined,
    '',
    'A',
    'dev',
    'dev-6f23ea9b',
    'e2e',
    'e2e-',
    'e2e-a b',
    'x-e2e-a'
  ]) {
    assert.equal(isE2eDeviceId(id), false, String(id))
  }
})

test('accounts for a device carry the device suffix, in both services', () => {
  const suffixed = KEYCHAIN_ACCOUNTS.map((account) => `${account}-e2e-x`)
  assert.deepEqual(keychainAccountsForDevice('e2e-x'), [
    ...suffixed.map((account) => ({ service: OWN, account })),
    ...suffixed.map((account) => ({ service: SYNC, account }))
  ])
})

test('matches every e2e-suffixed account of both sync services', () => {
  for (const service of [OWN, SYNC]) {
    for (const entry of KEYCHAIN_ACCOUNTS) {
      for (const device of [`e2e-${UUID}-A`, `e2e-${UUID}-B`, `e2e-vault-deletion-${UUID}`]) {
        assert.equal(isPurgeableE2eEntry({ service, account: `${entry}-${device}` }), true)
      }
    }
  }
})

test('never matches production or local dev accounts', () => {
  for (const account of [
    'master-key',
    'master-key-dev',
    'master-key-A',
    'master-key-B',
    'master-key-C',
    'master-key-dev-6f23ea9b',
    'device-signing-key-A',
    'device-signing-key-dev-d9cfd05c',
    'access-token-B',
    'refresh-token-dev-d9cfd05c',
    'setup-token-C',
    'pairing-token',
    'access-token-kaan94karaca@gmail.com-dev-d9cfd05c'
  ]) {
    assert.equal(isPurgeableE2eEntry({ service: SYNC, account }), false, account)
    assert.equal(isPurgeableE2eEntry({ service: OWN, account }), false, account)
  }
})

test('ignores services outside memry', () => {
  assert.equal(
    isPurgeableE2eEntry({ service: 'com.apple.foo', account: 'master-key-e2e-x' }),
    false
  )
  assert.equal(isPurgeableE2eEntry({ service: 'AirPort', account: 'e2e-network' }), false)
  assert.equal(isPurgeableE2eEntry({ service: `${OWN}.readwise`, account: 'token-e2e-x' }), false)
  assert.equal(isPurgeableE2eEntry({ service: SYNC, account: undefined }), false)
  assert.equal(isPurgeableE2eEntry({ service: undefined, account: 'master-key-e2e-x' }), false)
})

test('matches e2e safeStorage services but not dev ones', () => {
  const account = `memry-e2e-${UUID}-A Key`
  assert.equal(isPurgeableE2eEntry({ service: `memry-e2e-${UUID}-A Safe Storage`, account }), true)
  assert.equal(
    isPurgeableE2eEntry({ service: 'memry-A Safe Storage', account: 'memry-A Key' }),
    false
  )
  assert.equal(
    isPurgeableE2eEntry({ service: '@memry/desktop Safe Storage', account: '@memry/desktop Key' }),
    false
  )
})

test('parses security dump-keychain output (macOS)', () => {
  const dump = [
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="master-key-e2e-1234-A"',
    '    "svce"<blob>="com.memry.sync"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'attributes:',
    '    "acct"<blob>=0x6D6173746572  "master-key"',
    '    "svce"<blob>="com.memry.sync"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'attributes:',
    '    "acct"<blob>=<NULL>',
    '    "svce"<blob>="com.apple.kerberos.kdc"',
    ''
  ].join('\n')

  const entries = parseKeychainDump(dump)

  assert.deepEqual(entries, [
    { service: 'com.memry.sync', account: 'master-key-e2e-1234-A' },
    { service: 'com.memry.sync', account: 'master-key' },
    { service: 'com.apple.kerberos.kdc', account: undefined }
  ])
  assert.deepEqual(entries.filter(isPurgeableE2eEntry), [
    { service: 'com.memry.sync', account: 'master-key-e2e-1234-A' }
  ])
})

const CMDKEY = [
  '',
  'Currently stored credentials:',
  '',
  `    Target: LegacyGeneric:target=master-key-e2e-${UUID}-A.com.memry.sync`,
  '    Type: Generic',
  '    User: master-key-e2e-' + UUID + '-A',
  '    Local machine persistence',
  '',
  `    Target: LegacyGeneric:target=access-token-e2e-${UUID}-B.com.memry.sync`,
  '    Type: Generic',
  '    User: access-token',
  '',
  '    Target: LegacyGeneric:target=master-key.com.memry.sync',
  '    Type: Generic',
  '',
  `    Target: LegacyGeneric:target=${OWN}/master-key-e2e-${UUID}-A`,
  '    Type: Generic',
  '',
  `    Target: LegacyGeneric:target=${OWN}/device-signing-key-e2e-${UUID}-B`,
  '    Type: Generic',
  '',
  `    Target: LegacyGeneric:target=${OWN}/device-signing-key`,
  '    Type: Generic',
  '',
  '    Target: Domain:target=TERMSRV/host',
  '    Type: Domain Password',
  ''
].join('\r\n')

test('parses cmdkey /list output and selects only this device (Windows)', () => {
  const targets = parseCmdkeyList(CMDKEY)

  assert.equal(targets.length, 7)
  assert.deepEqual(windowsTargetsForDevice(targets, `e2e-${UUID}-A`), [
    `master-key-e2e-${UUID}-A.com.memry.sync`,
    `${OWN}/master-key-e2e-${UUID}-A`
  ])
  assert.deepEqual(windowsTargetsForDevice(targets, `e2e-${UUID}-B`), [
    `access-token-e2e-${UUID}-B.com.memry.sync`,
    `${OWN}/device-signing-key-e2e-${UUID}-B`
  ])
  assert.deepEqual(windowsTargetsForDevice(targets, 'A'), [])
})

test('a Windows target names its service and account in either form', () => {
  assert.deepEqual(parseWindowsTarget(`${OWN}/master-key-e2e-x`), {
    service: OWN,
    account: 'master-key-e2e-x'
  })
  assert.deepEqual(parseWindowsTarget('master-key-e2e-x.com.memry.sync'), {
    service: SYNC,
    account: 'master-key-e2e-x'
  })
  assert.equal(parseWindowsTarget(`${OWN}.readwise/token-e2e-x`), undefined)
  assert.equal(parseWindowsTarget('TERMSRV/host'), undefined)
})

test('reads the older cmdkey form without a target= prefix (Windows)', () => {
  assert.deepEqual(parseCmdkeyList('    Target: some.com.memry.sync\n'), ['some.com.memry.sync'])
})

const SECRET_TOOL = [
  '[/org/freedesktop/secrets/collection/login/12]',
  'label = master-key-e2e-x-A',
  'secret = hunter2',
  'created = 2026-10-24 10:00:00',
  'schema = org.freedesktop.Secret.Generic',
  'attribute.service = com.memry.sync',
  'attribute.username = master-key-e2e-x-A',
  '[/org/freedesktop/secrets/collection/login/13]',
  'label = master-key',
  'attribute.service = com.memry.sync',
  'attribute.username = master-key',
  '[/org/freedesktop/secrets/collection/login/14]',
  'attribute.service = com.memry.sync',
  'attribute.username = access-token-e2e-x-B',
  '[/org/freedesktop/secrets/collection/login/15]',
  `attribute.service = ${OWN}`,
  'attribute.username = device-signing-key-e2e-x-A',
  ''
].join('\n')

test('parses secret-tool search output and selects only this device (Linux)', () => {
  const entries = parseSecretToolSearch(SECRET_TOOL)

  assert.equal(entries.length, 4)
  assert.deepEqual(linuxAccountsForDevice(entries, 'e2e-x-A'), [
    'master-key-e2e-x-A',
    'device-signing-key-e2e-x-A'
  ])
  assert.deepEqual(linuxAccountsForDevice(entries, 'e2e-x-B'), ['access-token-e2e-x-B'])
  assert.deepEqual(linuxAccountsForDevice(entries, 'dev'), [])
})
