# Electron profile format

The Tauri app imports the data of the Electron app on first launch. The readers live in `crates/memry-desktop/src/electron_import/` and never write to the Electron profile. This page lists the byte layouts they read and where each comes from in the Electron app.

## Where the profile is

`applyMemrynoteIdentity` in `apps/desktop/src/main/app-identity.ts` puts userData at `<appData>/memrynote` and leaves a symlink or junction at the legacy `<appData>/@memry/desktop`. `<appData>` is `~/Library/Application Support` on macOS, `%APPDATA%` on Windows and `$XDG_CONFIG_HOME` or `~/.config` on Linux. `MEMRY_ELECTRON_PROFILE_DIR` replaces the search.

A directory is a profile when it is a real directory (`lstat`, never a symlink) with an entry other than `logs`, `.DS_Store` and `app-identity.json`. Windows and Linux create `logs` at every start, so an existing directory alone proves nothing. A symlink is followed once and accepted only when its target is a profile. A dangling link finds nothing. When both paths hold a profile, `memrynote` wins.

`app-identity.json` is `{version: 1, appName, flipped}`. It names the app name that produced the secret store. An unreadable pin, or a pin with another name, is ignored.

The app name matters because Chromium derives its key location from it on macOS and Linux, and not on Windows. The reader lists the names to try, most likely first, and tries each until a decrypt passes the plaintext check below:

- Linux with a ciphertext in the store: `@memry/desktop`, then `memrynote`.
- A pin: the pinned name, then the other.
- Windows: `memrynote` only.
- A store in a profile that was not born at the new path, or that left a legacy symlink behind: `@memry/desktop`, then `memrynote`.
- Otherwise: `memrynote`, then `@memry/desktop`.

## `secure-secrets.json`

`{version: 1, entries: {<service>: {<account>: <base64 of safeStorage.encryptString(value)>}}}` (`apps/desktop/src/main/secrets/secret-storage.ts`). Every secret of the app lives there: the five `com.memry.sync` keys, calendar providers, Readwise, OneNote, voice transcription, the local AI provider and capture pairing. A missing file reads as no secrets. An unparseable file is an error, and the reader never renames it aside, unlike the app.

The ciphertext is Chromium's synchronous `OSCrypt`, which Electron 43.1.1 restores with `patches/chromium/revert_oscrypt_remove_sync_backend.patch`:

| Host    | Prefix | Key                                                                                                                            | Cipher                                          |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| macOS   | `v10`  | PBKDF2-HMAC-SHA1(Keychain password of `<appName> Safe Storage` / `<appName> Key`, salt `saltysalt`, 1003 iterations, 16 bytes) | AES-128-CBC, PKCS7, IV of sixteen `0x20`        |
| Windows | `v10`  | 32 bytes: `os_crypt.encrypted_key` in `Local State`, base64, prefix `DPAPI`, then `CryptUnprotectData`                         | 12-byte nonce, AES-256-GCM, 16-byte tag, no AAD |
| Linux   | `v11`  | PBKDF2-HMAC-SHA1(libsecret or KWallet secret, `saltysalt`, 1 iteration, 16 bytes)                                              | AES-128-CBC, PKCS7, IV of sixteen `0x20`        |
| Linux   | `v10`  | fixed key `fd621fe5a2b402539dfa147ca9272778`                                                                                   | AES-128-CBC, PKCS7, IV of sixteen `0x20`        |

On Linux a failed CBC decrypt retries with the key of the empty password, `d0d0ec9c7d77d43ac54187fa4818d17f`.

CBC has no authentication, so a wrong key still decrypts about once in 256 tries on padding luck. Electron applies the printable-ASCII test (`looksLikePlaintextSecret` in `secret-storage.ts`) only in `probeSecretStoreIdentity`, to judge the key. `decryptValue` accepts any decrypt. The reader follows both: a candidate key is validated when it decrypts some entry to printable ASCII, and under a validated key every entry that decrypts to valid UTF-8 is accepted, so a value with accented letters survives. A store whose entries are all non-printable validates no key and reads as unreadable. The GCM tag authenticates the key, so a Windows result only has to be UTF-8.

A `version` field other than 1 in `secure-secrets.json` or `app-identity.json` is an error (`UnsupportedVersion`), and a store whose `entries` is not an object is `UnsupportedLayout`. A service that is not an object, or an account whose value is not a string, is reported as `CorruptCiphertext`, never dropped.

Every entry that does not decrypt, and has no legacy keytar copy, is reported as unreadable with a reason (`WrongIdentity`, `KeySourceMissing`, `KeySourceDenied`, `CorruptCiphertext`). The reader never reports a secret as absent when it exists but could not be read. The migration uses this to refuse to mint a new master key over an unreadable one.

## `memry-config.json`

The electron-store file (`apps/desktop/src/main/store.ts`, `StoredVaultInfo` and the sections beside it). The reader keeps the whole JSON object, so keys it does not know survive. Invalid JSON is an error that carries a byte offset and no content.

## `Local Storage/leveldb`

Chromium's localStorage. The packaged renderer loads through `loadFile`, so its origin is `file://`. An entry is the LevelDB key `_<origin>`, `0x00`, one format byte, the key text, and a value of one format byte followed by the text. Format `0x01` is Latin-1 and `0x00` is UTF-16LE. An entry that does not decode is skipped and counted.

## `crdt-stores/<vaultDirName>/` and `crdt-store/`

y-leveldb 0.2.0 on classic-level. `vaultDirName` (`apps/desktop/src/main/lib/vault-dir-name.ts`) keeps a canonical lower-case uuid and otherwise uses the first 32 hex of the sha256 of the value. `crdt-store/` is the global store every build before per-vault scoping wrote (`apps/desktop/src/main/sync/crdt-store-path.ts`).

The key encoding is y-leveldb's `keyEncoding`: a string is `0x00`, a varuint byte length and the UTF-8 bytes. A number is `0x01` and a big-endian u32. Keys:

- `[v1, <doc>, update, <clock>]` holds one Yjs update.
- `[v1_sv, <doc>]` holds a varuint clock and a var-byte state vector.
- `[v1, <doc>, meta, <key>]` holds a lib0 `encodeAny` value.

Two bookkeeping records in `memry-config.json` (`crdtStore`, `apps/desktop/src/main/store.ts`) decide which directory and which vault a store belongs to, and the migration reads them through `ElectronConfig`:

- `pendingRenames[newUuid] = oldUuid`: device linking rewrote the vault uuid and the store directory is still named after the old one. `YStoreReader::open` takes the old directory when the new one does not exist, as `settlePendingCrdtStoreRename` does. When both exist, the new one wins.
- `legacyStoreClaimedBy` names the one vault that inherited the global `crdt-store/`. `legacyStorePartitionPendingFor` names the vault that still owes it a partition pass, which means the legacy store may hold documents of other vaults. Step 37 must not attribute a legacy document to a vault while the pass is pending.

Keys in a store that are none of the three shapes are counted (`ignored_keys`) and reported.

The pseudo document `__memry_crdt_store__` holds `syncEpoch`. A note's meta key `memry.snapshotWatermark.v1` (`packages/sync-client/src/crdt-snapshot-watermark.ts`) holds `{appliedSequence, snapshotRevision?}`. The reader returns it only for a non-negative integer `appliedSequence` and an absent or string `snapshotRevision`, as `decodeSnapshotWatermark` does.

## `Custom Dictionary.txt`

One word per line, then `checksum_v1 = <lowercase md5 hex of everything before that line>` (`chrome/browser/spellchecker/spellcheck_custom_dictionary.cc`). Chromium drops the words when the checksum fails, and keeps `Custom Dictionary.txt.backup`. The reader falls back to the backup on a checksum failure.

## How the readers stay read-only

LevelDB writes when it opens a database, so no reader opens a store in the profile. It copies the directory without `LOCK` into a `Scratch` directory under the app's own data dir (never the system temp dir, since a CRDT copy holds decrypted note history) and opens the copy. Stale copies older than an hour are swept when the scratch directory is opened, and a store over 4 GiB is refused.

rusty-leveldb silently drops a log record whose checksum fails and opens with fewer entries. The reader therefore checks the crc32c of every record of each `*.log` and `MANIFEST-*` in the copy and returns `LevelDb` on a mismatch. Only a torn tail passes: a record cut short by the end of the file, or the zero padding at a block end. A bit flip in the length field of the last record looks like a torn tail and is tolerated; table files are checked by rusty-leveldb's paranoid mode. Before the copy, a probe asks whether a running Electron holds the `LOCK` file (an `fcntl` lock query on Unix, an exclusive-open check on Windows) and refuses with `ProfileInUse` if so. The tests hash the profile tree (path, size, sha256) before and after every reader and require equality.

## Fixtures

`node scripts/electron-fixtures/capture.mjs --out <dir>` runs against the repo's own `pnpm install` (the desktop app's electron, y-leveldb and yjs, so the tool brings no second Electron lockfile). It launches the real Electron 43.1.1 with a fixture app name and writes a profile into `crates/memry-desktop/tests/fixtures/electron/<os>/`. It uses fixture names, never `memrynote` or `@memry/desktop`, so it cannot touch a real Safe Storage item. On macOS it passes `--use-mock-keychain`, which makes Chromium use a fixed password and leave the login keychain alone. The expected plaintexts and the throw-away key material sit in `<new|legacy>.json` beside each profile.
