//! The activity log's share of the watcher's facts, as `watcher.ts` records them: a watched
//! file that got a new note, a move, a deletion that deleted its note, a file of a type the
//! vault does not open, and one it could not read. What the open walk found goes into its
//! [`ScanActivity`], which the walk records as `recordScanActivity` does once it ended.

use super::apply::Applier;
use crate::vault::activity::{
    ActivityInput, ActivityKind, ActivitySource, ScanActivity, UNREADABLE_REPORT_MS, failure_key,
};
use crate::vault::watch::VaultEvent;

impl Applier {
    /// A fact that changes no row. A vault the identity leaves as it is gets none of these
    /// entries, nor the walk's: they name files that have no note.
    pub(super) fn report(&self, event: &VaultEvent) {
        let (path, unreadable) = match event {
            VaultEvent::Unsupported { path } => (path, None),
            VaultEvent::Unreadable { path, reason } => (path, Some(reason)),
            _ => return,
        };
        if self.leaves_vault() {
            return;
        }
        match unreadable {
            None => {
                self.activity
                    .record_skipped(&self.root, path, ActivitySource::Watcher);
            }
            Some(reason) => {
                self.activity.record(
                    &self.root,
                    ActivityInput::new(ActivityKind::Failed, ActivitySource::Watcher)
                        .path(path.as_str())
                        .reason("read-failed")
                        .message(reason.as_str())
                        .dedupe(failure_key("read-failed", path), UNREADABLE_REPORT_MS),
                );
            }
        }
    }

    /// A file that got its note. Only a new one is `added`, as Electron records an add no note
    /// claimed: a watched file's at once, a walked file's in the walk's `scan`.
    pub(super) fn report_found(&self, path: &str, created: bool, scan: Option<&mut ScanActivity>) {
        if !created {
            return;
        }
        match scan {
            Some(scan) => scan.add(path),
            None => {
                self.activity.record(
                    &self.root,
                    ActivityInput::new(ActivityKind::Added, ActivitySource::Watcher).path(path),
                );
            }
        }
    }

    /// What the open walk found (`recordScanActivity`), but in a vault the identity leaves as
    /// it is: its activity log is not written.
    pub(super) fn report_scan(&self, scan: &ScanActivity) {
        if !self.leaves_vault() {
            self.activity.record_scan(&self.root, scan, scan.mode());
        }
    }

    fn leaves_vault(&self) -> bool {
        self.identity.leaves_vault(&self.ctx())
    }

    /// A removed file whose note was deleted.
    pub(super) fn report_removed(&self, path: &str) {
        self.activity.record(
            &self.root,
            ActivityInput::new(ActivityKind::Removed, ActivitySource::Watcher).path(path),
        );
    }

    pub(super) fn report_renamed(&self, old_path: &str, new_path: &str) {
        self.activity.record(
            &self.root,
            ActivityInput::new(ActivityKind::Renamed, ActivitySource::Watcher)
                .path(new_path)
                .old_path(old_path),
        );
    }
}

/// A walked file that is there and whose read failed (`failure`, the error). A watcher's fact
/// reports nothing here: the watcher reports a file it could not read itself (`Unreadable`).
pub(super) fn report_unread(scan: Option<&mut ScanActivity>, path: &str, failure: Option<String>) {
    if let (Some(scan), Some(message)) = (scan, failure) {
        scan.fail(path, "read-failed", Some(message));
    }
}
