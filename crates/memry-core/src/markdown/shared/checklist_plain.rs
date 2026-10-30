//! Port of `markChecklistLinesPlain`, `linesAlreadyIn` and `markAddedChecklistLinesPlain` from
//! `apps/desktop/src/main/import/_shared/checklist-tasks.ts`: a write that should leave
//! checklists as checklists marks each checkbox line the editor would turn into a task with
//! the plain marker (`{check}`).
//!
//! The editor converts a `- [ ] …` line to a task when it opens the note. An import that keeps
//! the file's checklists as they were (an import with `plainChecklists`) marks the lines
//! instead, so the editor keeps them as checkboxes. The marking skips:
//! - lines inside a code fence;
//! - lines that are not a `-`, `*` or `+` bullet with a checkbox;
//! - lines already carrying a `{task:<id>}` suffix or the marker;
//! - lines the Obsidian Tasks rules forbid rewriting (a block link, a task id, a dependency).
//!
//! An empty checkbox is marked too: one arriving in an open editor would show as a draft task.

use std::collections::{HashMap, HashSet};

use super::block_colors::js_value::js_trim_end;
use super::markdown_fences::FenceTracker;
use super::obsidian_tasks::obsidian_task_import_blocker;
use super::plain_checkbox::{PLAIN_CHECKBOX_MARKER, has_plain_checkbox_marker};
use super::task_block::parse_task_block_suffix;
use crate::markdown::frontmatter::js::js_trim;

/// The text after a checkbox, `(checkbox[2] ?? '').trim()`, when `line` matches the TypeScript
/// patterns `^([ \t]*)([-*+]|\d+[.)]) +(.*)$` with a bullet marker and then
/// `^\[([ xX])\](?: +(.*))?$`. JavaScript's `.` stops at `\r`, `\u{2028}` and `\u{2029}`, so a
/// line holding one never matches.
fn checkbox_text(line: &str) -> Option<&str> {
    if line.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let rest = line.trim_start_matches([' ', '\t']);
    let rest = rest.strip_prefix(['-', '*', '+'])?;
    let after_spaces = rest.trim_start_matches(' ');
    if after_spaces.len() == rest.len() {
        return None;
    }
    let bytes = after_spaces.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'[' || !matches!(bytes[1], b' ' | b'x' | b'X') {
        return None;
    }
    if bytes[2] != b']' {
        return None;
    }
    let tail = &after_spaces[3..];
    if !tail.is_empty() && !tail.starts_with(' ') {
        return None;
    }
    Some(js_trim(tail))
}

/// `markChecklistLinesPlain`: every line `keep_line` does not name and the editor would convert
/// gets ` {check}` after its trimmed end, before a `\r` line ending.
fn mark_checklist_lines_plain(markdown: &str, keep_line: impl Fn(usize) -> bool) -> String {
    let mut fence = FenceTracker::new();
    let mut lines: Vec<String> = markdown.split('\n').map(str::to_owned).collect();
    for (index, raw) in lines.iter_mut().enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw.as_str());
        if fence.consume(line) || keep_line(index) {
            continue;
        }
        let Some(text) = checkbox_text(line) else {
            continue;
        };
        if parse_task_block_suffix(text).is_some() || has_plain_checkbox_marker(text) {
            continue;
        }
        if !text.is_empty() && obsidian_task_import_blocker(text).is_some() {
            continue;
        }
        let eol = if raw.ends_with('\r') { "\r" } else { "" };
        *raw = format!("{} {PLAIN_CHECKBOX_MARKER}{eol}", js_trim_end(line));
    }
    lines.join("\n")
}

/// `linesAlreadyIn`: the indexes of `markdown`'s lines whose text `previous` holds, each line of
/// `previous` matched once.
fn lines_already_in(markdown: &str, previous: &str) -> HashSet<usize> {
    let mut left: HashMap<&str, usize> = HashMap::new();
    for line in previous.split('\n') {
        *left.entry(line).or_default() += 1;
    }
    let mut kept = HashSet::new();
    for (index, line) in markdown.split('\n').enumerate() {
        if let Some(count) = left.get_mut(line).filter(|count| **count > 0) {
            *count -= 1;
            kept.insert(index);
        }
    }
    kept
}

/// `markAddedChecklistLinesPlain`: the marking for a write that replaces `previous`. Lines the
/// body already held stay as they were, and only added checkbox lines get the marker. A new file
/// passes `""`.
pub fn mark_added_checklist_lines_plain(markdown: &str, previous: &str) -> String {
    let kept = lines_already_in(markdown, previous);
    mark_checklist_lines_plain(markdown, |index| kept.contains(&index))
}
