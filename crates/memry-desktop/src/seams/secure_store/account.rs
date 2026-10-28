//! Keychain service and account names, the rule of `apps/desktop/src/main/crypto/keychain-account.ts`
//! and `packages/contracts/src/crypto.ts` (`KEYCHAIN_ENTRIES`).

use memry_core::seams::secure_store::SecureStoreKey;

/// The one keychain service of every sync secret.
pub const SERVICE: &str = "com.memry.sync";

/// Every entry of the seam, in the order `clear` removes them.
pub const KEYS: [SecureStoreKey; 5] = [
    SecureStoreKey::MasterKey,
    SecureStoreKey::DeviceSigningKey,
    SecureStoreKey::AccessToken,
    SecureStoreKey::RefreshToken,
    SecureStoreKey::SetupToken,
];

fn base_account(key: SecureStoreKey) -> &'static str {
    match key {
        SecureStoreKey::MasterKey => "master-key",
        SecureStoreKey::DeviceSigningKey => "device-signing-key",
        SecureStoreKey::AccessToken => "access-token",
        SecureStoreKey::RefreshToken => "refresh-token",
        SecureStoreKey::SetupToken => "setup-token",
    }
}

/// `dev-<8 lowercase hex>` is the per-checkout device of a plain dev run; every such checkout
/// shares one `dev` account, or a second worktree would look under another account and miss the
/// key (`normalizeDeviceSuffix`).
fn is_worktree_device(suffix: &str) -> bool {
    suffix.strip_prefix("dev-").is_some_and(|hash| {
        hash.len() == 8 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The account of `key` for `device_suffix` (the `MEMRY_DEVICE` value): bare without a device.
pub fn account(key: SecureStoreKey, device_suffix: Option<&str>) -> String {
    let base = base_account(key);
    match device_suffix {
        None | Some("") => base.to_owned(),
        Some(suffix) if is_worktree_device(suffix) => format!("{base}-dev"),
        Some(suffix) => format!("{base}-{suffix}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_accounts_are_bare() {
        let accounts: Vec<_> = KEYS.iter().map(|key| account(*key, None)).collect();
        assert_eq!(
            accounts,
            [
                "master-key",
                "device-signing-key",
                "access-token",
                "refresh-token",
                "setup-token"
            ]
        );
        assert_eq!(account(SecureStoreKey::MasterKey, Some("")), "master-key");
    }

    #[test]
    fn a_dev_worktree_hash_collapses_to_dev() {
        assert_eq!(
            account(SecureStoreKey::MasterKey, Some("dev-0123abcd")),
            "master-key-dev"
        );
        assert_eq!(
            account(SecureStoreKey::DeviceSigningKey, Some("dev")),
            "device-signing-key-dev"
        );
    }

    #[test]
    fn other_devices_keep_their_suffix() {
        for (suffix, expected) in [
            ("A", "master-key-A"),
            ("e2e-3f2a-B", "master-key-e2e-3f2a-B"),
            ("dev-0123ABCD", "master-key-dev-0123ABCD"),
            ("dev-0123abc", "master-key-dev-0123abc"),
            ("dev-0123abcde", "master-key-dev-0123abcde"),
        ] {
            assert_eq!(account(SecureStoreKey::MasterKey, Some(suffix)), expected);
        }
    }
}
