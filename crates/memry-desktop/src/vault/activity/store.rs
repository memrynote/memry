//! The open vault's log in memory: the lines kept, what is not on disk yet, and the rules that
//! drop lines (retention, the cap) and admit new ones (dedupe, unsupported files once).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use super::disk::{Work, read_log, read_retention};
use super::entry::Line;
use super::{COMPACT_SLACK, MAX_ENTRIES};
use crate::vault::layout::CANVAS_FILE_EXT;

const DAY_MS: i64 = 86_400_000;
/// Dedupe keys kept before the expired ones are dropped.
const DEDUPE_KEYS: usize = 4096;

/// The log of the open vault.
pub(super) struct Log {
    pub(super) root: PathBuf,
    /// Tells this open apart from a later one of the same vault.
    pub(super) generation: u64,
    /// Oldest first.
    pub(super) lines: VecDeque<Line>,
    pub(super) retention_days: u32,
    /// New lines not on disk yet.
    pub(super) pending: Vec<String>,
    /// The file no longer matches `lines` minus `pending`: write it whole.
    pub(super) needs_rewrite: bool,
    /// `false` when the file could not be read at open: never rewritten.
    pub(super) readable: bool,
    /// Paths reported as unsupported, each reported once while its entry is kept.
    pub(super) reported_skips: HashSet<String>,
    /// Dedupe key -> (when it was recorded, its window), epoch ms.
    pub(super) recent_keys: HashMap<String, (i64, i64)>,
}

impl Log {
    pub(super) fn load(root: &Path, now_ms: i64) -> Self {
        let loaded = read_log(root);
        let mut log = Self {
            root: root.to_owned(),
            generation: 0,
            lines: loaded.lines.into(),
            retention_days: read_retention(root),
            pending: Vec::new(),
            needs_rewrite: false,
            readable: loaded.readable,
            reported_skips: HashSet::new(),
            recent_keys: HashMap::new(),
        };
        if loaded.dropped > 0 {
            tracing::warn!(
                scope = "vault_activity",
                dropped = loaded.dropped,
                "lines of the activity log are not JSON; the next rewrite drops them"
            );
        }
        let pruned = log.prune(now_ms);
        log.needs_rewrite = log.readable && (pruned || loaded.dropped > 0 || loaded.torn_tail);
        log.collect_skips();
        log
    }

    /// Drops lines past the retention window, then the oldest past the cap. A line whose time
    /// this build cannot read is kept by the window.
    pub(super) fn prune(&mut self, now_ms: i64) -> bool {
        let before = self.lines.len();
        let cutoff = now_ms - i64::from(self.retention_days) * DAY_MS;
        self.lines
            .retain(|line| line.at_ms.is_none_or(|at| at >= cutoff));
        if self.lines.len() > MAX_ENTRIES {
            self.lines.drain(..self.lines.len() - MAX_ENTRIES);
        }
        self.lines.len() != before
    }

    pub(super) fn collect_skips(&mut self) {
        self.reported_skips = self
            .lines
            .iter()
            .filter_map(|line| line.entry.as_ref()?.reported_skip().map(str::to_owned))
            .collect();
    }

    pub(super) fn push(&mut self, line: Line) {
        let raw = line.raw.clone();
        self.lines.push_back(line);
        if self.lines.len() > MAX_ENTRIES + COMPACT_SLACK {
            self.lines.drain(..self.lines.len() - MAX_ENTRIES);
            self.needs_rewrite = self.readable;
        }
        if !self.needs_rewrite {
            self.pending.push(raw);
            self.cap_pending();
        }
    }

    /// Appends that keep failing (a file that cannot be read is often one that cannot be
    /// written) hold no more than the log itself would.
    fn cap_pending(&mut self) {
        if self.pending.len() > MAX_ENTRIES + COMPACT_SLACK {
            self.pending.drain(..self.pending.len() - MAX_ENTRIES);
        }
    }

    pub(super) fn take_work(&mut self) -> Option<Work> {
        if self.needs_rewrite {
            self.needs_rewrite = false;
            self.pending.clear();
            return Some(Work::Rewrite(
                self.lines.iter().map(|line| line.raw.clone()).collect(),
            ));
        }
        (!self.pending.is_empty()).then(|| Work::Append(std::mem::take(&mut self.pending)))
    }

    /// Puts back a write that failed, for the next one.
    pub(super) fn restore(&mut self, work: Work) {
        match work {
            Work::Rewrite(_) => self.needs_rewrite = true,
            Work::Append(mut lines) if !self.needs_rewrite => {
                lines.append(&mut self.pending);
                self.pending = lines;
                self.cap_pending();
            }
            Work::Append(_) => {}
        }
    }

    /// `false` for a repeat of `key` inside its window.
    pub(super) fn admit(&mut self, key: &str, window: i64, now_ms: i64) -> bool {
        if self
            .recent_keys
            .get(key)
            .is_some_and(|(last, _)| now_ms - last < window)
        {
            return false;
        }
        if self.recent_keys.len() >= DEDUPE_KEYS {
            self.recent_keys
                .retain(|_, (last, window)| now_ms - *last < *window);
        }
        self.recent_keys.insert(key.to_owned(), (now_ms, window));
        true
    }
}

/// `path.extname` of a `/`-separated path, without its dot and lowercased: `""` for a name
/// with no dot past its first character.
pub(super) fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(at) if at > 0 => name[at + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Not a canvas (the canvas store owns those) nor a lock or partial file another program
/// keeps beside a document while it is open (`TRANSIENT_FILE_RE`).
pub(super) fn is_user_content(path: &str) -> bool {
    const TRANSIENT: [&str; 8] = [
        ".tmp",
        ".temp",
        ".part",
        ".partial",
        ".crdownload",
        ".download",
        ".swp",
        ".lock",
    ];
    let name = path.rsplit('/').next().unwrap_or(path);
    let ascii = name.to_ascii_lowercase();
    !(name.to_lowercase().ends_with(CANVAS_FILE_EXT)
        || name.starts_with("~$")
        || name.ends_with('~')
        || TRANSIENT.iter().any(|suffix| ascii.ends_with(suffix)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_node_s_extname_of_the_name() {
        for (path, ext) in [
            ("a/b.PDF", "pdf"),
            ("a.d/b", ""),
            ("a/.bashrc", ""),
            ("a/b.", ""),
            ("a/..x", "x"),
            ("b.tar.gz", "gz"),
        ] {
            assert_eq!(extension(path), ext, "{path}");
        }
    }

    #[test]
    fn canvases_and_lock_files_are_not_user_content() {
        for path in [
            "c/x.Excalidraw",
            "~$doc.docx",
            "doc.docx~",
            "a/b.CRDOWNLOAD",
            "x.swp",
        ] {
            assert!(!is_user_content(path), "{path}");
        }
        for path in ["a/b.docx", "a/lock", "a/b.locker"] {
            assert!(is_user_content(path), "{path}");
        }
    }
}
