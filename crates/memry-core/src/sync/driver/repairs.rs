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
        let checked = self
            .manifest
            .run(&self.first.pull, crate::sync::pull::now_ms())
            .await;
        if let Err(error) = checked {
            eprintln!("memry-core: the manifest check failed: {error}");
        }
    }
}
