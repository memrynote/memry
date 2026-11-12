//! The body snippet under a search hit (#4316).
//!
//! Desktop shows `snippet(fts_notes, 2, '<mark>', '</mark>', '...', 20)` under
//! each hit. This asks FTS5 for the same window over the same column (notes
//! and journals: `content`; tasks: `description`), with 20 tokens and a `...`
//! ellipsis, and hands the shell **segments** instead of markup: a shell never
//! parses a highlight out of text.
//!
//! FTS5 marks a match with two strings of our choosing. These are private-use
//! code points, which no keyboard types and `extract_text` never produces, so
//! splitting on them cannot cut a word the user wrote. The `content` column is
//! `extract_text` output, one line per block with `# ` and `- ` markers; a
//! snippet is one line of secondary text, so each line's block marker is
//! dropped and every whitespace run becomes one space.
//!
//! A hit that matched only its title still gets the column's opening words, as
//! plain unhighlighted segments. An empty column is an empty list.

/// Opens a highlight inside the SQL `snippet()` output.
const OPEN: char = '\u{E000}';
/// Closes a highlight inside the SQL `snippet()` output.
const CLOSE: char = '\u{E001}';

/// One run of snippet text. `highlighted` runs are the query's matches.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SnippetSegment {
    pub text: String,
    pub highlighted: bool,
}

/// The `snippet()` call over `column` of `table`: a 20-token window, `...`
/// where it cuts, and the private sentinels around each match.
pub(super) fn snippet_sql(table: &str, column: usize) -> String {
    format!("snippet({table}, {column}, '{OPEN}', '{CLOSE}', '...', 20)")
}

/// Splits raw `snippet()` output into segments, block markers and whitespace
/// collapsed.
pub(super) fn segments(raw: &str) -> Vec<SnippetSegment> {
    let flat = raw
        .split('\n')
        .map(without_block_marker)
        .collect::<Vec<_>>()
        .join(" ");
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");

    let mut out: Vec<SnippetSegment> = Vec::new();
    let mut text = String::new();
    let mut highlighted = false;
    for character in flat.chars() {
        let switch_to = match character {
            OPEN => Some(true),
            CLOSE => Some(false),
            _ => None,
        };
        match switch_to {
            Some(next) => {
                push(&mut out, std::mem::take(&mut text), highlighted);
                highlighted = next;
            }
            None => text.push(character),
        }
    }
    push(&mut out, text, highlighted);
    out
}

/// Appends a run, merging it into the previous one when both share a style.
fn push(out: &mut Vec<SnippetSegment>, text: String, highlighted: bool) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(last) if last.highlighted == highlighted => last.text.push_str(&text),
        _ => out.push(SnippetSegment { text, highlighted }),
    }
}

/// One `extract_text` line without its heading or list marker
/// (`text_extract.rs`: `# ` through `###### `, `- `, `1. `). A highlight
/// sentinel may follow the marker; it is kept.
fn without_block_marker(line: &str) -> &str {
    let trimmed = line.trim_start();
    let hashes = trimmed.len() - trimmed.trim_start_matches('#').len();
    if (1..=6).contains(&hashes)
        && let Some(rest) = trimmed[hashes..].strip_prefix(' ')
    {
        return rest;
    }
    trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("1. "))
        .unwrap_or(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> SnippetSegment {
        SnippetSegment {
            text: text.to_owned(),
            highlighted: false,
        }
    }

    fn marked(text: &str) -> SnippetSegment {
        SnippetSegment {
            text: text.to_owned(),
            highlighted: true,
        }
    }

    #[test]
    fn markers_and_line_breaks_read_as_one_line() {
        let raw = format!("# Keys\n- the {OPEN}password{CLOSE} is\n\n1. under   the mat...");
        assert_eq!(
            segments(&raw),
            vec![
                plain("Keys the "),
                marked("password"),
                plain(" is under the mat..."),
            ]
        );
    }

    #[test]
    fn a_match_right_after_a_marker_keeps_its_highlight() {
        let raw = format!("## {OPEN}Password{CLOSE} list");
        assert_eq!(segments(&raw), vec![marked("Password"), plain(" list")]);
    }

    #[test]
    fn adjacent_matches_stay_separate_runs() {
        let raw = format!("{OPEN}a{CLOSE} {OPEN}b{CLOSE}");
        assert_eq!(segments(&raw), vec![marked("a"), plain(" "), marked("b")]);
    }

    #[test]
    fn nothing_in_is_nothing_out() {
        assert_eq!(segments(""), Vec::new());
        assert_eq!(segments(" \n "), Vec::new());
    }
}
