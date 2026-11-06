//! The plan of a date format change's renames (`journal-format-migration.ts`): which journal
//! file takes which name, and which are skipped. Pure; the pass in the parent module moves them.

use std::collections::HashSet;

use crate::vault::journal_format::{JournalDate, JournalFormat};
use crate::web::extract::utils::js;

/// One file to move, relative to the journal folder with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRename {
    pub from: String,
    pub to: String,
    pub date: JournalDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    TargetExists,
    Unrepresentable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRenameSkip {
    pub file: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalRenamePlan {
    pub renames: Vec<JournalRename>,
    pub skipped: Vec<JournalRenameSkip>,
}

/// Two-digit month and day, distinct from each other and across both dates, so a format
/// missing the year, the month or the day cannot name them both.
const PROBE_DATES: [&str; 2] = ["2026-11-28", "2031-12-31"];

/// True when every date renders to a name that parses back to the same date.
pub fn is_complete_journal_format(format: &str) -> bool {
    let format = JournalFormat::new(format);
    PROBE_DATES.iter().all(|iso| {
        let date = JournalDate::from_iso(iso).expect("a probe date");
        format.parse(&format.render(date)) == Some(date)
    })
}

/// The renames of the files of the journal folder (`/`-separated paths relative to it) from
/// `old_format` to `new_format`. Names are compared case-insensitively: on the default macOS
/// and Windows volumes two names differing only in case are one file.
pub fn plan_journal_renames(
    files: &[String],
    old_format: &str,
    new_format: &str,
) -> JournalRenamePlan {
    let (old, new) = (
        JournalFormat::new(old_format),
        JournalFormat::new(new_format),
    );
    let present: HashSet<String> = files.iter().map(|name| js::to_lower(name)).collect();
    let mut claimed = HashSet::new();
    let mut plan = JournalRenamePlan::default();
    // Electron sorts by UTF-16 units. Two names of one format differ only where their
    // tokens' ASCII is, where byte order is the same.
    let mut sorted: Vec<&String> = files.iter().collect();
    sorted.sort();
    for name in sorted {
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        let Some(date) = old.parse(stem) else {
            continue;
        };
        let stem = new.render(date);
        let target = format!("{stem}.md");
        if target == *name {
            continue;
        }
        let skip = |reason| JournalRenameSkip {
            file: name.clone(),
            reason,
        };
        if new.parse(&stem) != Some(date) {
            plan.skipped.push(skip(SkipReason::Unrepresentable));
            continue;
        }
        let key = js::to_lower(&target);
        let case_only = key == js::to_lower(name);
        if (present.contains(&key) && !case_only) || claimed.contains(&key) {
            plan.skipped.push(skip(SkipReason::TargetExists));
            continue;
        }
        claimed.insert(key);
        plan.renames.push(JournalRename {
            from: name.clone(),
            to: target,
            date,
        });
    }
    plan
}
