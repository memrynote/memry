//! Oracle-free properties of the checklist marking (`markdown::shared::checklist_plain`) over
//! generated markdown: it is idempotent, keeps every line and its line ending, changes a line
//! only by appending ` {check}` after its trimmed end, and leaves a body it is written over
//! as it was. The comparison with the TypeScript is `checklist_plain_vectors.rs`.

#![cfg(feature = "markdown")]

use memry_core::markdown::shared::checklist_plain::mark_added_checklist_lines_plain;
use memry_test_kit::{DEFAULT_CASES, proptest_config};
use proptest::prelude::*;

const MARKER: &str = " {check}";

fn config() -> ProptestConfig {
    ProptestConfig {
        failure_persistence: None,
        ..proptest_config(DEFAULT_CASES)
    }
}

/// A line built from the pieces the rules look at: indents, list markers, checkboxes, task
/// suffixes, markers, Obsidian fields, fences, white space of every kind, and `\r`.
fn line() -> impl Strategy<Value = String> {
    let indent = prop_oneof![
        Just(""),
        Just("  "),
        Just("    "),
        Just("\t"),
        Just("\u{3000}"),
        Just("\u{feff}")
    ];
    let marker = prop_oneof![
        Just("- "),
        Just("* "),
        Just("+ "),
        Just("1. "),
        Just("-  "),
        Just("-"),
        Just("> - "),
        Just("```"),
        Just("~~~"),
        Just("")
    ];
    let checkbox = prop_oneof![
        Just("[ ] "),
        Just("[x] "),
        Just("[X] "),
        Just("[ ]"),
        Just("[y] "),
        Just("[ ]\t"),
        Just("")
    ];
    let text = prop_oneof![
        Just(String::new()),
        "[a-zA-Z ]{1,12}",
        Just("Buy milk {task:abc}".to_owned()),
        Just("Plain {check}".to_owned()),
        Just("Due 📅 2026-11-01".to_owned()),
        Just("Blocked 🆔 abc123".to_owned()),
        Just("Linked ^b-1".to_owned()),
        Just("é日本😀".to_owned()),
        Just("mid\rline".to_owned()),
        Just("sep\u{2028}line".to_owned())
    ];
    let tail = prop_oneof![
        Just(""),
        Just("  "),
        Just("\t"),
        Just("\u{a0}"),
        Just("\u{3000}"),
        Just("\u{85}"),
        Just("\r"),
        Just("\r\r")
    ];
    (indent, marker, checkbox, text, tail).prop_map(|(indent, marker, checkbox, text, tail)| {
        format!("{indent}{marker}{checkbox}{text}{tail}")
    })
}

fn markdown() -> impl Strategy<Value = String> {
    prop::collection::vec(line(), 0..16).prop_map(|lines| lines.join("\n"))
}

/// `after` is `before`, or `before` without its `\r` ending and trailing white space, then
/// ` {check}`, then the `\r` again.
fn changed_only_by_the_marker(before: &str, after: &str) -> bool {
    if after == before {
        return true;
    }
    let (line, eol) = match before.strip_suffix('\r') {
        Some(line) => (line, "\r"),
        None => (before, ""),
    };
    let Some(kept) = after
        .strip_suffix(eol)
        .and_then(|rest| rest.strip_suffix(MARKER))
    else {
        return false;
    };
    line.strip_prefix(kept).is_some_and(|trimmed| {
        trimmed
            .chars()
            .all(|c| c.is_whitespace() || c == '\u{feff}')
    })
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn marking_twice_marks_nothing_more(markdown in markdown()) {
        let once = mark_added_checklist_lines_plain(&markdown, "");
        prop_assert_eq!(mark_added_checklist_lines_plain(&once, ""), once);
    }

    #[test]
    fn every_line_and_its_ending_stays_and_changes_only_by_the_marker(markdown in markdown()) {
        let marked = mark_added_checklist_lines_plain(&markdown, "");
        let (before, after): (Vec<&str>, Vec<&str>) =
            (markdown.split('\n').collect(), marked.split('\n').collect());
        prop_assert_eq!(before.len(), after.len());
        for (before, after) in before.iter().zip(&after) {
            prop_assert_eq!(before.ends_with('\r'), after.ends_with('\r'));
            prop_assert!(changed_only_by_the_marker(before, after), "{:?} -> {:?}", before, after);
        }
    }

    #[test]
    fn a_body_written_over_itself_stays_as_it_was(markdown in markdown()) {
        prop_assert_eq!(mark_added_checklist_lines_plain(&markdown, &markdown), markdown);
    }
}
