//! Desktop hardening of the sync engine, ported from Electron's
//! `apps/desktop/src/main/sync/engine/` (Step 17, #3534). Each module owns one
//! guard; both shells run the ones on the shared apply path.

pub(crate) mod requeue;
