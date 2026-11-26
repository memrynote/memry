//! The pull gate's view of memry sync for the open vault (`readPullEnv`, `SyncEngineView` and
//! `waitForVaultIndexBuild` in `pull-gate.ts`), read from the session's running
//! [`SyncSupervisor`] and the note index.
//!
//! No supervisor running (before the launch attach, or after a sign-out detach) reads as no
//! verdict, so a run waits and then is skipped as `not-ready`. Electron's signed-out install
//! reaches the verdict "does not sync" and pulls without a claim; here a run needs a
//! supervisor's verdict first, since a run that starts before the launch attach cannot tell
//! "signed out" from "not decided yet".

use std::sync::Arc;

use memry_core::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
use tokio::runtime::Handle;

use super::pull_gate::{PullEnv, SyncView};
use crate::notes::index::NoteIndex;
use crate::session::Session;
use crate::sync::supervisor::SyncSupervisor;

const SCOPE: &str = "Readwise:SyncView";

pub type Reading = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct SessionSyncView {
    session: Session,
    index: Arc<NoteIndex>,
    runtime: Handle,
    /// The registered sync device id (`getCurrentDeviceId`).
    device_id: Reading,
    /// `readCurrentDeviceName`.
    device_name: Reading,
}

impl SessionSyncView {
    pub fn new(
        session: Session,
        index: Arc<NoteIndex>,
        runtime: Handle,
        device_id: Reading,
        device_name: Reading,
    ) -> Self {
        Self {
            session,
            index,
            runtime,
            device_id,
            device_name,
        }
    }

    fn supervisor(&self) -> Option<SyncSupervisor> {
        self.session.sync_supervisor()
    }
}

impl SyncView for SessionSyncView {
    fn env(&self) -> PullEnv {
        let Some(sync) = self.supervisor() else {
            return PullEnv::default();
        };
        PullEnv {
            decided: sync.decided(),
            eligible: sync.status().sync_eligible,
            pulled: sync.completed_pulls() > 0,
            device_id: (self.device_id)(),
        }
    }

    fn caught_up(&self) -> bool {
        self.supervisor().is_some_and(|sync| sync.caught_up())
    }

    fn request_push(&self) {
        if let Some(sync) = self.supervisor() {
            sync.request_push();
        }
    }

    /// Unreadable reads as queued: the claim is not known to be delivered.
    fn settings_queued(&self) -> bool {
        let Some(sync) = self.supervisor() else {
            return true;
        };
        match self.runtime.block_on(sync.outbox_count(SETTINGS_ITEM_ID)) {
            Ok(count) => count > 0,
            Err(error) => {
                tracing::warn!(scope = SCOPE, %error, "the settings outbox could not be read");
                true
            }
        }
    }

    fn completed_pulls(&self) -> u64 {
        self.supervisor().map_or(0, |sync| sync.completed_pulls())
    }

    fn device_name(&self) -> Option<String> {
        (self.device_name)()
    }

    fn indexing(&self) -> bool {
        self.index.indexing().is_some()
    }
}
