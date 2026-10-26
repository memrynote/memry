//! A password-protected login keyring that was never unlocked in this session, against the live
//! Secret Service (`--features live-os-secrets`, Linux, `MEMRY_LIVE_LOCKED_KEYRING=1`). The
//! caller (CI, or a VM) first stores a keytar item `com.memry.sync` / `master-key` in an
//! encrypted keyring, stops the daemon and starts a fresh one without the password.
//!
//! A cold gnome-keyring hides the attributes of items in a locked collection (only
//! `gkr:compat:hashed:*` stay readable), so a listing that reads `service` and `account`
//! without unlocking finds nothing. The reader must unlock (the service prompts the user) and
//! report a declined or unanswered prompt, never an empty listing.
#![cfg(all(feature = "live-os-secrets", target_os = "linux"))]

use std::time::Duration;

use memry_desktop::electron_import::secrets::{Guarded, KeytarSource, OsKeytar};

#[test]
fn a_cold_locked_keyring_is_never_listed_as_empty() {
    if !std::env::var("MEMRY_LIVE_LOCKED_KEYRING").is_ok_and(|v| v == "1") {
        return;
    }
    // No prompter runs in CI and nobody answers on a desktop, so the unlock ends as a failure or
    // a timeout; a listing that found the item would also be correct.
    let listed = Guarded::with_timeout(OsKeytar, Duration::from_secs(10)).list();
    if let Ok(items) = listed {
        assert!(
            items
                .iter()
                .any(|(service, account)| service == "com.memry.sync" && account == "master-key"),
            "a locked keyring listed {} items although it holds the keytar item",
            items.len()
        );
    }
}
