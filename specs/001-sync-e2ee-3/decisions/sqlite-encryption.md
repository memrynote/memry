# Decision: Local SQLite Encryption at Rest

**Status**: Recommend OS-level FDE (no application-level SQLite encryption)
**Date**: 2026-02-28
**Context**: T245e — evaluate encryption at rest for `data.db` and `index.db`

## Options Evaluated

### Option A: SQLCipher via better-sqlite3-multiple-ciphers

**What it is**: Drop-in replacement for `better-sqlite3` that bundles SQLCipher (AES-256-CBC page-level encryption). Each `PRAGMA key = '...'` call encrypts/decrypts the entire DB transparently.

**Pros**:

- Transparent encryption; no application-level code changes to queries
- Proven in production (Signal Desktop uses a fork: `@signalapp/better-sqlite3`)
- Protects against cold-boot disk image attacks independent of OS

**Cons**:

- **Native module rebuild complexity**: `better-sqlite3-multiple-ciphers` requires native compilation with OpenSSL or bundled crypto. Electron rebuild is fragile — `NODE_MODULE_VERSION` mismatches already cause `ERR_DLOPEN_FAILED` with plain `better-sqlite3`
- **Performance overhead**: 15-25% slower on reads, measurable on large FTS queries against `index.db`. WAL mode interactions with SQLCipher have known edge cases (SQLITE_CORRUPT reports in Signal Desktop)
- **Key management problem**: The encryption key must be available in memory before any DB operation. Options:
  - Derive from vaultKey → ties DB access to sync auth state; breaks offline-first
  - Store in OS keychain → attacker with keychain access already has masterKey; redundant
  - Hardcode/obfuscate → security theater
- **Migration**: Encrypting existing unencrypted DBs requires `ATTACH` + `sqlcipher_export`, which is a destructive one-time migration that can fail mid-way
- **Maintenance burden**: Pinned to `better-sqlite3-multiple-ciphers` fork lifecycle; Electron major bumps require coordinated native rebuilds

### Option B: Vault-Key-Derived Encryption (Application-Level)

**What it is**: Encrypt sensitive column values (e.g., `content`, `title`) with XChaCha20 using a key derived from vaultKey before writing to SQLite. Leave structural columns (IDs, timestamps, types) unencrypted for queryability.

**Pros**:

- Uses existing crypto primitives (XChaCha20, vaultKey derivation)
- No native module changes
- Selective — only encrypts sensitive fields, preserving query performance on metadata

**Cons**:

- **Already implemented at the sync layer**: `sync_items.encrypted_data` stores the encrypted blob. Local content in `tasks`, `notes`, `projects` tables is the _decrypted working copy_. Encrypting it again adds a second encryption layer with no additional threat model coverage
- **Breaks FTS**: Full-text search index (`index.db`) requires plaintext for tokenization. Encrypting content makes search impossible without decrypting every row at query time
- **Query limitations**: `WHERE title LIKE '%search%'` becomes impossible on encrypted fields
- **Complexity**: Every read/write path needs encrypt/decrypt wrappers; risk of plaintext leaks through SQLite temp files, WAL, or journal

### Option C: OS-Level Full Disk Encryption (FDE)

**What it is**: Rely on macOS FileVault (default on), Windows BitLocker (common on managed devices), and Linux LUKS. The entire filesystem — including SQLite files, WAL journals, temp files, and swap — is encrypted at rest.

**Pros**:

- **Zero application complexity**: No code changes, no native module changes, no migration
- **Comprehensive**: Encrypts everything — DB files, WAL, journal, temp, logs, swap. SQLCipher only encrypts the DB file itself; WAL/temp leakage is a known gap
- **No performance penalty for the app**: Encryption is hardware-accelerated (AES-NI) at the block device level
- **Key management solved**: OS handles key storage (Secure Enclave / TPM), user authenticates at boot
- **Industry standard**: Signal Desktop moved _away_ from relying solely on SQLCipher toward OS-level protections for many scenarios

**Cons**:

- **Not enforceable by the app**: The app cannot guarantee FDE is enabled. On macOS FileVault is on by default; on Windows/Linux it varies
- **Doesn't protect against**: Logged-in attacker with filesystem access (but neither does SQLCipher if the key is in memory)

## Threat Model Analysis

The relevant threat for encryption at rest is: **attacker gains access to the physical disk while the app is not running** (stolen laptop, disk image, decommissioned hardware).

| Threat                    | SQLCipher             | App-Level                  | OS FDE |
| ------------------------- | --------------------- | -------------------------- | ------ |
| Stolen powered-off laptop | Yes                   | Yes                        | Yes    |
| Disk image forensics      | Yes                   | Partial (metadata exposed) | Yes    |
| Logged-in local attacker  | No (key in memory)    | No (key in memory)         | No     |
| Swap/temp file leakage    | No (only encrypts DB) | No                         | Yes    |
| WAL journal leakage       | Partial               | No                         | Yes    |

## Recommendation

**Use OS-level FDE. Do not add SQLCipher or application-level DB encryption.**

Rationale:

1. **The sync layer already encrypts sensitive data** with XChaCha20 + Ed25519 signatures before it touches the server. Local DBs hold _working copies_ for the UI
2. **FDE covers more surface area** than SQLCipher (swap, temp files, logs, WAL journals)
3. **SQLCipher adds significant build complexity** for Electron with minimal marginal security benefit given FDE
4. **The key management problem is unsolvable** without tying DB access to auth state, which breaks the offline-first design
5. **Pre-production**: If the threat model changes (e.g., multi-user devices, enterprise compliance requiring app-level encryption), SQLCipher can be evaluated again with `better-sqlite3-multiple-ciphers`

### Future Considerations

- If enterprise customers require app-level encryption for compliance (SOC2, HIPAA), revisit `better-sqlite3-multiple-ciphers` with a keychain-stored key
- Consider adding a startup check that warns users if FDE is not enabled (macOS: `fdesetup status`, Windows: `manage-bde -status`)
- The `sodium_mlock` utilities (T245h) are already in place for when native mlock becomes available

## References

- [Signal Desktop better-sqlite3 fork](https://github.com/signalapp/better-sqlite3)
- [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers)
- [SQLCipher by Zetetic](https://www.zetetic.net/sqlcipher/)
- [Signal Desktop SQLCipher corruption issues](https://discuss.zetetic.net/t/is-anybody-else-seeing-sqlite-corrupt-errors-with-electron/3578)
