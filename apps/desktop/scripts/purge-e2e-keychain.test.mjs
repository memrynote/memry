import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPurgeableE2eEntry, parseKeychainDump } from './purge-e2e-keychain.mjs'

const SYNC = 'com.memry.sync'

test('matches every e2e-suffixed com.memry.sync account', () => {
  const uuid = 'acc474be-3e59-4621-a8ea-fba2ddd008cc'
  for (const entry of [
    'master-key',
    'device-signing-key',
    'access-token',
    'refresh-token',
    'setup-token'
  ]) {
    for (const device of [`e2e-${uuid}-A`, `e2e-${uuid}-B`, `e2e-vault-deletion-${uuid}`]) {
      assert.equal(
        isPurgeableE2eEntry({ service: SYNC, account: `${entry}-${device}` }),
        true,
        `${entry}-${device} should be purgeable`
      )
    }
  }
})

test('never matches production or local dev accounts', () => {
  const protectedAccounts = [
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
  ]
  for (const account of protectedAccounts) {
    assert.equal(
      isPurgeableE2eEntry({ service: SYNC, account }),
      false,
      `${account} must never be purged`
    )
  }
})

test('ignores services outside memry', () => {
  assert.equal(
    isPurgeableE2eEntry({ service: 'com.apple.foo', account: 'master-key-e2e-x' }),
    false
  )
  assert.equal(isPurgeableE2eEntry({ service: 'AirPort', account: 'e2e-network' }), false)
  assert.equal(isPurgeableE2eEntry({ service: SYNC, account: undefined }), false)
  assert.equal(isPurgeableE2eEntry({ service: undefined, account: 'master-key-e2e-x' }), false)
})

test('matches e2e safeStorage services but not dev ones', () => {
  const account = 'memry-e2e-6c29af05-f76e-4a84-a0fe-37567745f447-A Key'
  assert.equal(
    isPurgeableE2eEntry({
      service: 'memry-e2e-6c29af05-f76e-4a84-a0fe-37567745f447-A Safe Storage',
      account
    }),
    true
  )
  assert.equal(
    isPurgeableE2eEntry({ service: 'memry-A Safe Storage', account: 'memry-A Key' }),
    false
  )
  assert.equal(
    isPurgeableE2eEntry({
      service: '@memry/desktop Safe Storage',
      account: '@memry/desktop Key'
    }),
    false
  )
})

test('parses security dump-keychain output', () => {
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
