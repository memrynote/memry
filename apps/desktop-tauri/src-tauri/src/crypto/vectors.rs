//! KDF context table mirrored from Electron `apps/desktop/src/main/crypto/keys.ts`.
//!
//! Each entry pins the libsodium `crypto_kdf_derive_from_key` inputs for one
//! purpose: the human-readable `label` callers pass to `derive_key`, the 8-byte
//! `context_bytes` libsodium uses internally, and the `subkey_id`. Drift on
//! either bytes or id breaks compatibility with existing Electron-encrypted
//! data. The table is deliberately the only place these are spelled out.

/// One entry in the KDF context table.
pub struct KdfContextEntry {
    pub label: &'static str,
    pub subkey_id: u64,
    pub context_bytes: [u8; 8],
}

pub const KDF_CONTEXTS: &[KdfContextEntry] = &[
    KdfContextEntry {
        label: "memry-vault-key-v1",
        subkey_id: 1,
        context_bytes: *b"memryvlt",
    },
    KdfContextEntry {
        label: "memry-signing-key-v1",
        subkey_id: 2,
        context_bytes: *b"memrysgn",
    },
    KdfContextEntry {
        label: "memry-verify-key-v1",
        subkey_id: 3,
        context_bytes: *b"memryvrf",
    },
    KdfContextEntry {
        label: "memry-key-verifier-v1",
        subkey_id: 4,
        context_bytes: *b"memrykve",
    },
    KdfContextEntry {
        label: "memry-linking-enc-v1",
        subkey_id: 5,
        context_bytes: *b"memrylnk",
    },
    KdfContextEntry {
        label: "memry-linking-mac-v1",
        subkey_id: 6,
        context_bytes: *b"memrymac",
    },
    KdfContextEntry {
        label: "memry-linking-sas-v1",
        subkey_id: 7,
        context_bytes: *b"memrysas",
    },
];

pub fn lookup_context(label: &str) -> Option<&'static KdfContextEntry> {
    KDF_CONTEXTS.iter().find(|entry| entry.label == label)
}
