//! The open vault's log in memory: the lines kept, what is not on disk yet, and the rules that
//! drop lines (retention, the cap) and admit new ones (dedupe, unsupported files once).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use super::disk::{DEFAULT_RETENTION_DAYS, Failed, Work, cutoff, read_log, read_retention};
use super::entry::Line;
use super::{COMPACT_SLACK, MAX_ENTRIES};
use crate::vault::layout::CANVAS_FILE_EXT;

/// Dedupe keys kept before the expired ones are first dropped.
const DEDUPE_KEYS: usize = 4096;

/// The log of the open vault.
pub(super) struct Log {
    pub(super) root: PathBuf,
    /// Tells this open apart from a later one of the same vault.
    pub(super) generation: u64,
    /// Oldest first.
    pub(super) lines: VecDeque<Line>,
    /// `None` for a retention the settings file names and this build does not know: no entry
    /// goes for its age, only past the cap.
    pub(super) retention_days: Option<u32>,
    /// New lines not on disk yet, oldest first; also in `lines` while those keep them.
    pub(super) pending: Vec<String>,
    /// The file no longer matches `lines` minus `pending`: write it whole.
    pub(super) needs_rewrite: bool,
    /// The file's last line has no newline, so an append starts on a line of its own.
    pub(super) torn_tail: bool,
    /// `false` when the file could not be read at open: never rewritten.
    pub(super) readable: bool,
    /// Paths reported as unsupported, each reported once while its entry is kept.
    pub(super) reported_skips: HashSet<String>,
    /// Dedupe key -> (when it was recorded, its window), epoch ms.
    pub(super) recent_keys: HashMap<String, (i64, i64)>,
    /// Size of `recent_keys` at which the expired keys are dropped: twice what the last drop
    /// left, so each drop is paid for by as many inserts.
    purge_at: usize,
}

impl Log {
    pub(super) fn load(root: &Path, now_ms: i64) -> Self {
        let retention_days = read_retention(root);
        let loaded = read_log(root, cutoff(retention_days, now_ms));
        if loaded.dropped > 0 {
            tracing::warn!(
                scope = "vault_activity",
                dropped = loaded.dropped,
                "lines of the activity log are not JSON; the next rewrite drops them"
            );
        }
        let mut log = Self {
            root: root.to_owned(),
            generation: 0,
            lines: loaded.lines,
            retention_days,
            pending: Vec::new(),
            needs_rewrite: loaded.readable
                && (loaded.pruned > 0 || loaded.dropped > 0 || loaded.torn_tail),
            torn_tail: loaded.torn_tail,
            readable: loaded.readable,
            reported_skips: HashSet::new(),
            recent_keys: HashMap::new(),
            purge_at: DEDUPE_KEYS,
        };
        log.collect_skips();
        log
    }

    /// The retention the renderer shows: an unknown one as the default.
    pub(super) fn shown_retention(&self) -> u32 {
        self.retention_days.unwrap_or(DEFAULT_RETENTION_DAYS)
    }

    /// Drops lines past the retention window, then the oldest past the cap. A line whose time
    /// this build cannot read is kept by the window.
    pub(super) fn prune(&mut self, now_ms: i64) -> bool {
        let before = self.lines.len();
        if let Some(cutoff) = cutoff(self.retention_days, now_ms) {
            self.lines
                .retain(|line| line.at_ms.is_none_or(|at| at >= cutoff));
        }
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
        self.pending.push(line.raw.clone());
        self.cap_pending();
        self.lines.push_back(line);
        if self.lines.len() > MAX_ENTRIES + COMPACT_SLACK {
            self.lines.drain(..self.lines.len() - MAX_ENTRIES);
            self.needs_rewrite = self.readable;
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
        let unwritten = std::mem::take(&mut self.pending);
        if self.needs_rewrite {
            self.needs_rewrite = false;
            let lines = self.lines.iter().map(|line| line.raw.clone()).collect();
            return Some(Work::Rewrite {
                lines,
                unwritten,
                separate: self.torn_tail,
            });
        }
        (!unwritten.is_empty()).then_some(Work::Append {
            lines: unwritten,
            separate: self.torn_tail,
        })
    }

    /// The write reached the disk: the file ends with a newline.
    pub(super) fn wrote(&mut self) {
        self.torn_tail = false;
    }

    /// Puts back what a failed write owes, ahead of the lines recorded since. A failed rewrite
    /// stays owed (a clear or a compaction), and its new lines with it unless they were
    /// appended instead; the rewrite writes them again, as part of `lines`, not twice.
    pub(super) fn restore(&mut self, work: Work, failed: &Failed) {
        let mut lines = match work {
            Work::Append { lines, .. } => lines,
            Work::Rewrite { unwritten, .. } => {
                self.needs_rewrite = true;
                if failed.appended {
                    self.wrote();
                    Vec::new()
                } else {
                    unwritten
                }
            }
        };
        lines.append(&mut self.pending);
        self.pending = lines;
        self.cap_pending();
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
        if self.recent_keys.len() >= self.purge_at {
            self.recent_keys
                .retain(|_, (last, window)| now_ms - *last < *window);
            self.purge_at = DEDUPE_KEYS.max(2 * self.recent_keys.len());
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
    use crate::vault::activity::parse::{Read, read_line};

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

    fn line(id: &str) -> Line {
        let raw = format!(
            r#"{{"v":1,"id":"{id}","at":"2026-10-30T11:00:00.000Z","kind":"added","source":"watcher"}}"#
        );
        let Read::Line(parsed) = read_line(&raw) else {
            panic!("not a line: {raw}");
        };
        parsed.into_line(raw)
    }

    fn failed(appended: bool) -> Failed {
        Failed {
            error: super::super::DiskError::Write {
                file: super::super::LOG_FILE,
                source: std::io::Error::other("refused"),
            },
            appended,
        }
    }

    /// The new lines the next write carries, and whether it rewrites the file.
    fn next(log: &mut Log) -> (Vec<String>, bool) {
        match log.take_work() {
            Some(Work::Append { lines, .. }) => (lines, false),
            Some(Work::Rewrite { unwritten, .. }) => (unwritten, true),
            None => (Vec::new(), false),
        }
    }

    /// A line recorded while a write was out reaches the disk after the lines that write held;
    /// a failed rewrite stays owed, without the lines it appended instead.
    #[test]
    fn a_failed_write_s_lines_go_back_ahead_of_the_ones_recorded_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        for (rewrite, appended) in [(false, false), (true, false), (true, true)] {
            let mut log = Log::load(dir.path(), 0);
            log.needs_rewrite = rewrite;
            let (a, b) = (line("a"), line("b"));
            let (a_raw, b_raw) = (a.raw.clone(), b.raw.clone());
            log.push(a);
            let out = log.take_work().unwrap();
            log.push(b);
            log.restore(out, &failed(appended));
            let expected = if appended {
                vec![b_raw]
            } else {
                vec![a_raw, b_raw]
            };
            assert_eq!(
                next(&mut log),
                (expected, rewrite),
                "rewrite: {rewrite}, appended: {appended}"
            );
        }
    }
}
