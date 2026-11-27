//! The driver's half of the repairs ([`crate::sync::hardening`]): when they
//! run, under the pass gate.

use super::SyncDriver;
use crate::sync::engine::PassReport;

impl SyncDriver {
    /// The manifest check, after a pass whose pull delivered and reached the
    /// head of the feed (`reuploadLocalOnly`), under the pass gate. A failure
    /// is logged; the next due pass checks again.
    pub(super) async fn check_manifest(&self, pass: &PassReport) {
        let pull = &pass.pull;
        if pass.pull_error.is_some() || pull.pages == 0 || pull.refused || pull.has_more {
            return;
        }
        let _gate = self.engine.hold_gate().await;
        let now = crate::sync::pull::now_ms();
        match self.manifest.run(&self.first.pull, now).await {
            // A re-uploaded note or journal goes with its whole body: the server lost the
            // create, so it may hold none of the document's updates (#4785).
            Ok(Some(outcome)) => {
                for (_, id) in outcome
                    .reuploaded
                    .iter()
                    .filter(|(item_type, _)| item_type == "note" || item_type == "journal")
                {
                    self.snapshot_requests.request(id, now);
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("memry-core: the manifest check failed: {error}"),
        }
    }
}
