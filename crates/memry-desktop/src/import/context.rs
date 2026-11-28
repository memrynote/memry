//! `apps/desktop/src/main/import/import-context.ts`: the counters and skip reasons of one run,
//! and the progress snapshot sent on every change.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::messages::ImportText;
use crate::vault::activity::MAX_ITEMS;

/// `MAX_SKIPPED_REASON_GROUPS`: distinct free-text skip reasons kept per run. Coded reasons are
/// exempt: their space is bounded by the codes, and a cap would let free text crowd them out.
pub const MAX_SKIPPED_REASON_GROUPS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportPhase {
    Scanning,
    Importing,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedItem {
    pub item: String,
    pub error: String,
}

/// `ImportSkippedGroup`: skipped items of one reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkippedGroup {
    pub reason: ImportText,
    pub count: usize,
}

/// `ImportSummaryResult`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub attachments: usize,
    pub skipped: usize,
    pub failed: Vec<FailedItem>,
    /// Absent when nothing was skipped with a reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_reasons: Option<Vec<SkippedGroup>>,
}

/// `ImportProgressEvent`: the whole state of a run, sent on every change. Only the last one,
/// `done`, carries the summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub import_id: String,
    pub phase: ImportPhase,
    pub status: ImportText,
    pub imported: usize,
    pub attachments: usize,
    pub skipped: usize,
    pub failed: usize,
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<ImportSummary>,
}

/// Where the snapshots go: the runner's throttle in the app, a recorder in the tests.
pub type ProgressSink = Box<dyn FnMut(ImportProgress) + Send>;

/// The state of one run, handed to the importer. Every report sends a snapshot.
pub struct ImportContext {
    import_id: String,
    cancel: CancellationToken,
    emit: ProgressSink,
    phase: ImportPhase,
    status: ImportText,
    imported: usize,
    attachments: usize,
    skipped: usize,
    completed: usize,
    total: usize,
    failed: Vec<FailedItem>,
    groups: Vec<SkippedGroup>,
    /// Group of each reason key: its code, or its text when it has none.
    group_of: HashMap<String, usize>,
    free_text_groups: usize,
    /// `item — reason` of the first skipped items, for the activity log line (`runner.ts`).
    skipped_items: Vec<String>,
}

impl ImportContext {
    pub fn new(
        import_id: impl Into<String>,
        cancel: CancellationToken,
        emit: ProgressSink,
    ) -> Self {
        Self {
            import_id: import_id.into(),
            cancel,
            emit,
            phase: ImportPhase::Scanning,
            status: ImportText::Text(String::new()),
            imported: 0,
            attachments: 0,
            skipped: 0,
            completed: 0,
            total: 0,
            failed: Vec::new(),
            groups: Vec::new(),
            group_of: HashMap::new(),
            free_text_groups: 0,
            skipped_items: Vec::new(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The run's token, for a reader that checks it while it holds the context.
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn status(&mut self, status: impl Into<ImportText>) {
        self.status = status.into();
        self.emit();
    }

    pub fn set_phase(&mut self, phase: ImportPhase) {
        self.phase = phase;
        self.emit();
    }

    pub fn report_progress(&mut self, completed: usize, total: usize) {
        self.completed = completed;
        self.total = total;
        self.emit();
    }

    pub fn report_imported(&mut self) {
        self.imported += 1;
        self.emit();
    }

    pub fn report_attachment(&mut self) {
        self.attachments += 1;
        self.emit();
    }

    /// A coded reason is grouped and translated in the summary; text renders verbatim.
    pub fn report_skipped(&mut self, item: &str, reason: Option<ImportText>) {
        self.skipped += 1;
        if self.skipped_items.len() < MAX_ITEMS {
            self.skipped_items.push(match &reason {
                Some(reason) => format!("{item} \u{2014} {}", reason.text()),
                None => item.to_owned(),
            });
        }
        if let Some(reason) = reason {
            let code = reason.code().map(str::to_owned);
            let key = code.clone().unwrap_or_else(|| reason.text().to_owned());
            if let Some(&at) = self.group_of.get(&key) {
                self.groups[at].count += 1;
            } else if code.is_some() || self.free_text_groups < MAX_SKIPPED_REASON_GROUPS {
                if code.is_none() {
                    self.free_text_groups += 1;
                }
                self.group_of.insert(key, self.groups.len());
                self.groups.push(SkippedGroup { reason, count: 1 });
            }
        }
        tracing::debug!(scope = "import", "import item skipped");
        self.emit();
    }

    pub fn report_failed(&mut self, item: &str, error: &str) {
        self.failed.push(FailedItem {
            item: item.to_owned(),
            error: error.to_owned(),
        });
        tracing::warn!(scope = "import", "import item failed");
        self.emit();
    }

    pub fn summary(&self) -> ImportSummary {
        ImportSummary {
            imported: self.imported,
            attachments: self.attachments,
            skipped: self.skipped,
            failed: self.failed.clone(),
            skipped_reasons: (!self.groups.is_empty()).then(|| self.groups.clone()),
        }
    }

    pub(super) fn skipped_items(&self) -> &[String] {
        &self.skipped_items
    }

    fn emit(&mut self) {
        let done = self.phase == ImportPhase::Done;
        let snapshot = ImportProgress {
            import_id: self.import_id.clone(),
            phase: self.phase,
            status: self.status.clone(),
            imported: self.imported,
            attachments: self.attachments,
            skipped: self.skipped,
            failed: self.failed.len(),
            completed: self.completed,
            total: self.total,
            done,
            summary: done.then(|| self.summary()),
        };
        (self.emit)(snapshot);
    }
}
