//! Desktop hardening of the sync engine, ported from Electron's
//! `apps/desktop/src/main/sync/engine/` (Step 17, #3534). Each module owns one
//! guard. Both shells run the ones on the shared apply path (the requeue);
//! the ledgers and repairs run only in a pull built `PullLoop::with_hardening`
//! or from `SyncDriver`, which iOS's `sync_now` is not (decision K2).

pub(crate) mod corrupt;
pub mod history;
pub mod manifest;
pub mod orphans;
#[cfg(test)]
mod pending_deletes;
pub mod quarantine;
pub(crate) mod requeue;
pub mod stale_cursor;
