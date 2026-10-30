//! The activity log's share of the watcher's facts, as `watcher.ts` records them: a watched
//! file that got a new note, a move, a deletion that deleted its note, a file of a type the
//! vault does not open, and one it could not read. A fact the open walk found is not news.

use super::apply::Applier;
use crate::vault::activity::{ActivityInput, ActivityKind, ActivitySource};
use crate::vault::watch::VaultEvent;

/// A file that stays unreadable is reported once in this window, not on every event.
const UNREADABLE_REPORT_MS: i64 = 60 * 60 * 1000;

impl Applier {
    /// A fact that changes no row.
    pub(super) fn report(&self, event: &VaultEvent) {
        match event {
            VaultEvent::Unsupported { path } => {
                self.activity
                    .record_skipped(&self.root, path, ActivitySource::Watcher);
            }
            VaultEvent::Unreadable { path, reason } => {
                self.activity.record(
                    &self.root,
                    ActivityInput::new(ActivityKind::Failed, ActivitySource::Watcher)
                        .path(path.as_str())
                        .reason("read-failed")
                        .message(reason.as_str())
                        .dedupe(format!("read-failed:{path}"), UNREADABLE_REPORT_MS),
                );
            }
            _ => {}
        }
    }

    /// A file that got its note. Only a watched file that got a new one is `added`: Electron
    /// records an add no note claimed.
    pub(super) fn report_found(&self, path: &str, origin: ActivitySource, created: bool) {
        if created && origin == ActivitySource::Watcher {
            self.activity.record(
                &self.root,
                ActivityInput::new(ActivityKind::Added, origin).path(path),
            );
        }
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
