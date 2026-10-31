//! What the open walk found, as the activity log tells it (`recordScanActivity`,
//! `vault/activity-log.ts`): the files that got a new note, the ones that could not be read and
//! the ones the vault does not index. A few are one entry each; many are one summary.

use std::path::Path;

use super::entry::{ActivityInput, ActivityKind, ActivitySource, MAX_ITEMS};
use super::store::is_user_content;
use super::{ActivityLog, State};
use crate::vault::walk::UNSUPPORTED_COLLECT_LIMIT;

/// `SCAN_COLLECT_LIMIT`: paths kept per list; past it a file is only counted.
pub const SCAN_COLLECT_LIMIT: usize = UNSUPPORTED_COLLECT_LIMIT;
/// A walk that found more new files than this records one summary instead.
const PER_FILE_ADDED: usize = 20;
const PER_FILE_FAILED: usize = 50;
/// New unsupported files reported per walk: a vault holding thousands of them converges over a
/// few opens instead of flooding one.
const PER_FILE_SKIPPED: usize = 500;

/// `ScanActivity`: each list keeps at most [`SCAN_COLLECT_LIMIT`] paths, its count every one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanActivity {
    pub added: Vec<String>,
    pub added_count: usize,
    pub failed: Vec<ScanFailure>,
    pub failed_count: usize,
    pub unsupported: Vec<String>,
    pub unsupported_count: usize,
    /// Files the vault already knew (Electron's `skipped`): none of them, with files added, is
    /// a first build.
    pub known: usize,
    /// New files the identity left for later.
    pub deferred: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScanFailure {
    pub path: String,
    /// `read-failed` or `index-failed`.
    pub reason: String,
    pub message: Option<String>,
}

/// `'scan' | 'rebuild'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// An open: a few new files are listed one by one.
    Scan,
    /// Every file reads as new (a first open): one summary says the index was built, and no
    /// file is listed as added, which would claim the user just put it there.
    Rebuild,
}

impl ScanActivity {
    pub fn add(&mut self, path: &str) {
        self.added_count += 1;
        if self.added.len() < SCAN_COLLECT_LIMIT {
            self.added.push(path.to_owned());
        }
    }

    pub fn fail(&mut self, path: &str, reason: &str, message: Option<String>) {
        self.failed_count += 1;
        if self.failed.len() < SCAN_COLLECT_LIMIT {
            self.failed.push(ScanFailure {
                path: path.to_owned(),
                reason: reason.to_owned(),
                message,
            });
        }
    }

    /// The identity deferred files and took none: a vault it does not index yet (an Electron
    /// vault not imported), whose files, the activity log's included, are left as they are.
    pub fn deferred_all(&self) -> bool {
        self.deferred > 0 && self.known == 0 && self.added_count == 0
    }

    /// The mode Electron's `indexVault` records an open's walk in.
    pub fn mode(&self) -> ScanMode {
        if self.known == 0 && self.added_count > 0 {
            ScanMode::Rebuild
        } else {
            ScanMode::Scan
        }
    }
}

impl ActivityLog {
    /// Records what a walk of the vault at `root` found (`recordScanActivity`). Nothing while
    /// that vault is not the open one.
    pub fn record_scan(&self, root: &Path, scan: &ScanActivity, mode: ScanMode) {
        let record = |input| self.record(root, input);
        let entry = |kind| ActivityInput::new(kind, ActivitySource::Scan);
        let added_per_file = mode == ScanMode::Scan && scan.added_count <= PER_FILE_ADDED;
        if added_per_file {
            for path in &scan.added {
                record(entry(ActivityKind::Added).path(path.as_str()));
            }
        }
        for failure in scan.failed.iter().take(PER_FILE_FAILED) {
            let mut input = entry(ActivityKind::Failed)
                .path(failure.path.as_str())
                .reason(failure.reason.as_str());
            if let Some(message) = failure.message.as_deref().filter(|m| !m.is_empty()) {
                input = input.message(message);
            }
            record(input);
        }

        let candidates: Vec<String> = scan
            .unsupported
            .iter()
            .map(|path| path.replace('\\', "/"))
            .filter(|path| is_user_content(path))
            .collect();
        let mut reported = 0;
        for path in &candidates {
            if reported >= PER_FILE_SKIPPED {
                break;
            }
            if self.record_skipped(root, path, ActivitySource::Scan) {
                reported += 1;
            }
        }
        let unreported_paths: Vec<String> = {
            let state = self.shared.state();
            let Some(skips) = reported_skips(&state, root) else {
                return;
            };
            candidates
                .into_iter()
                .filter(|path| !skips.contains(path))
                .collect()
        };
        // Past the collection cap the paths are unknown; they still count.
        let unreported = unreported_paths.len() + (scan.unsupported_count - scan.unsupported.len());

        let needs_summary = mode == ScanMode::Rebuild
            || (!added_per_file && scan.added_count > 0)
            || scan.failed_count > PER_FILE_FAILED
            || unreported > 0;
        if !needs_summary {
            return;
        }
        let counts: Vec<(String, u64)> = [
            ("added", scan.added_count),
            ("failed", scan.failed_count),
            ("unsupported", unreported),
        ]
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(name, count)| (name.to_owned(), count as u64))
        .collect();
        let items: Vec<String> = if !added_per_file && mode == ScanMode::Scan {
            scan.added.iter().take(MAX_ITEMS).cloned().collect()
        } else {
            unreported_paths.into_iter().take(MAX_ITEMS).collect()
        };
        let mut summary = entry(ActivityKind::Scan);
        if mode == ScanMode::Rebuild {
            summary = summary.reason("index-rebuilt");
        }
        summary.counts = Some(counts);
        if !items.is_empty() {
            summary.items = Some(items);
        }
        record(summary);
    }
}

fn reported_skips<'a>(
    state: &'a State,
    root: &Path,
) -> Option<&'a std::collections::HashSet<String>> {
    let log = state.log.as_ref().filter(|log| log.root == root)?;
    Some(&log.reported_skips)
}
