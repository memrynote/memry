//! The task infrastructure every vault opens with: Electron's `ensureDefaultTaskProject`
//! (`apps/desktop/src/main/database/defaults.ts:12`), called on every open by `openVault`
//! (`apps/desktop/src/main/vault/index.ts:672`), the open of a vault it just created included.
//!
//! The seed itself is the core's [`memry_core::api::tasks::Tasks::ensure_inbox`], which iOS
//! runs too: Electron's id `inbox`, name, colour, icon and three statuses, written only when the
//! vault holds no Inbox record (a synced or tombstoned one included), and queued for sync like
//! any create. Every device seeds the same id, so the seeds of two devices meet as one project.

use std::sync::Arc;

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
            let tasks = view
                .vault
                .tasks(store.clone())
                .map_err(|error| format!("the Inbox was not seeded: {error}"))?;
            tasks
                .ensure_inbox()
                .map(drop)
                .map_err(|error| format!("the Inbox was not seeded: {error}"))
        }),
    );
}
