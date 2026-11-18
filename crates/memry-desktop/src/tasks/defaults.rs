//! The task infrastructure every vault opens with: Electron's `ensureDefaultTaskProject`
//! (`apps/desktop/src/main/database/defaults.ts:12`), called on every open by `openVault`
//! (`apps/desktop/src/main/vault/index.ts:672`), the open of a vault it just created included.
//!
//! The seed itself is the core's [`memry_core::api::tasks::Tasks::ensure_inbox`], which iOS
//! runs too: Electron's id `inbox`, name, colour, icon and three statuses, written only when the
//! vault holds no Inbox record (a synced or tombstoned one included). Like Electron's, it has no
//! clock and is not queued: a pulled Inbox replaces it outright, and the sync pass after a pull
//! that reached the feed head clocks and queues one no pull replaced
//! (`memry_core::domain::projects::seed_unclocked`).

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::seams::secure_store::SecureStore;

use crate::session::{OpenStage, Session};

/// Seeds the Inbox at every open, before sync starts (as Electron seeds before its sync).
/// A failure (no device identity, a locked keychain) is logged by the session and leaves the
/// vault open without one; the next open tries again.
pub fn register(session: &Session, store: Arc<dyn SecureStore>) {
    session.on_open(
        "default-task-project",
        OpenStage::Defaults,
        Arc::new(move |view| {
            let not_seeded =
                |error: &dyn std::fmt::Display| format!("the Inbox was not seeded: {error}");
            ensure_device_identity(store.clone()).map_err(|error| not_seeded(&error))?;
            let tasks = view
                .vault
                .tasks(store.clone())
                .map_err(|error| not_seeded(&error))?;
            tasks
                .ensure_inbox()
                .map(drop)
                .map_err(|error| not_seeded(&error))
        }),
    );
}
