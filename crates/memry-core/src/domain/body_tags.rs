//! The `#tags` a note or journal body carries, cached in `note_body_tags`.
//!
//! Desktop indexes a note's tags as its frontmatter tags plus every inline
//! `#tag` in its body (`note-sync.ts`, `extractInlineTagsFromMarkdown`), and
//! pushes only the frontmatter half (#1471). A tag that lives only in the body
//! therefore never reaches the record payload, and so never reaches
//! `note_tags`. This module derives that half from the body document, and the
//! tag readers union it with `note_tags`.
//!
//! The table is a cache of a parse, like `note_bodies`: the search reindex
//! rewrites a document's rows each time it indexes that document.

use rusqlite::{Connection, params};
use unicode_normalization::char::is_combining_mark;

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::domain::journal_rules::is_js_whitespace;
use crate::domain::notes::failed;
use crate::domain::tags;

/// `note_tags` and `note_body_tags` as one `(note_id, tag)` relation. `UNION`
/// compares with the columns' `NOCASE`, which folds ASCII only, so one note can
/// still yield two rows of one tag (`Ünal`, `ünal`): readers match and group by
/// `tag_fold` and count distinct `note_id`s.
pub const ALL_NOTE_TAGS: &str = "(SELECT note_id, tag FROM note_tags WHERE deleted_at IS NULL \
     UNION SELECT note_id, tag FROM note_body_tags)";

/// The body's tags, as desktop's `extractInlineTagsFromMarkdown` reads them
/// from the markdown it writes: a `#` at the start of a line or after
/// whitespace, then a tag ([`tag_len`]). Code blocks and inline code are
/// skipped. A `hashTag` node is `#tag` on disk. Deduped case-insensitively,
/// first spelling kept.
pub fn extract(blocks: &[Block]) -> Vec<String> {
    let mut found = Vec::new();
    for block in blocks.iter().filter(|block| block.kind != "codeBlock") {
        let mut line = String::new();
        for run in &block.inline {
            if run.marks.iter().any(|mark| mark == "hashTag") {
                line.push('#');
                line.push_str(run.target.as_deref().unwrap_or_default());
            } else if !run.marks.iter().any(|mark| mark == "code") {
                line.push_str(&run.text);
            }
        }
        scan(&line, &mut found);
    }
    tags::dedupe(found)
}

/// The `#tags` of a markdown body, as desktop's `extractInlineTagsFromMarkdown` reads them: every
/// fenced span (three backticks to the next three) and inline code span removed, then the tags
/// of the text left. Deduped case-insensitively, first spelling kept.
pub fn extract_markdown(markdown: &str) -> Vec<String> {
    let text = without_inline_code(&without_fences(markdown));
    let mut found = Vec::new();
    scan(&text, &mut found);
    tags::dedupe(found)
}

/// `/```[\s\S]*?```/g` replaced with nothing: an opening run with no closing one ends the
/// removals, since no later opening has one either.
fn without_fences(text: &str) -> String {
    const FENCE: &str = "```";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(FENCE) {
        let Some(close) = rest[open + FENCE.len()..].find(FENCE) else {
            break;
        };
        out.push_str(&rest[..open]);
        rest = &rest[open + FENCE.len() + close + FENCE.len()..];
    }
    out.push_str(rest);
    out
}

/// `` /`[^`]+`/g `` replaced with nothing.
fn without_inline_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('`') {
        let after = &rest[open + 1..];
        match after.find('`') {
            // At least one character between the two backticks.
            Some(close) if close > 0 => {
                out.push_str(&rest[..open]);
                rest = &after[close + 1..];
            }
            Some(_) => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn scan(line: &str, found: &mut Vec<String>) {
    for (start, end) in tag_spans(line, None) {
        found.push(line[start..end].to_owned());
    }
}

/// A character inside a tag segment, desktop's `TAG_CHAR` in
/// `@memry/shared/inline-tags`: `[\p{Alphabetic}\p{M}\p{N}_-]`. The marks
/// carry Hindi's virama and Thai's tone marks.
pub(crate) fn is_tag_char(c: char) -> bool {
    c.is_alphabetic() || is_combining_mark(c) || c.is_numeric() || c == '_' || c == '-'
}

/// Length in chars of the tag `chars` starts with, `#` excluded, or `None`:
/// `/`-separated segments, each a letter or digit followed by tag characters,
/// and at least one letter in the whole tag, so `2024` is prose and `2024년`
/// and `퓨리` are tags.
pub(crate) fn tag_len(chars: &[char]) -> Option<usize> {
    let starts_segment = |at: usize| {
        chars
            .get(at)
            .is_some_and(|c| c.is_alphabetic() || c.is_numeric())
    };
    if !starts_segment(0) {
        return None;
    }
    let mut end = 0;
    loop {
        end += 1;
        while chars.get(end).is_some_and(|&c| is_tag_char(c)) {
            end += 1;
        }
        // A `/` continues the tag only when a segment follows it.
        if chars.get(end) == Some(&'/') && starts_segment(end + 1) {
            end += 1;
        } else {
            break;
        }
    }
    chars[..end]
        .iter()
        .any(|c| c.is_alphabetic())
        .then_some(end)
}

pub(crate) fn tag_spans(line: &str, char_before_line: Option<char>) -> Vec<(usize, usize)> {
    let offsets: Vec<usize> = line.char_indices().map(|(offset, _)| offset).collect();
    let chars: Vec<char> = line.chars().collect();
    let byte = |at: usize| offsets.get(at).copied().unwrap_or(line.len());
    let mut spans = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let preceding = if at == 0 {
            char_before_line
        } else {
            chars.get(at - 1).copied()
        };
        // JavaScript's `\s`, which the desktop grammar tests: U+FEFF starts a tag, U+0085 does not.
        let len = (chars[at] == '#' && preceding.is_none_or(is_js_whitespace))
            .then(|| tag_len(&chars[at + 1..]))
            .flatten();
        match len {
            Some(len) => {
                spans.push((byte(at + 1), byte(at + 1 + len)));
                at += 1 + len;
            }
            None => at += 1,
        }
    }
    spans
}

/// Replaces one document's cached body tags.
pub fn write(data: &Connection, doc_id: &str, body_tags: &[String]) -> Result<(), StorageError> {
    clear(data, doc_id)?;
    for tag in body_tags {
        data.execute(
            "INSERT OR IGNORE INTO note_body_tags (note_id, tag) VALUES (?1, ?2)",
            params![doc_id, tag],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Drops one document's cached body tags.
pub fn clear(data: &Connection, doc_id: &str) -> Result<(), StorageError> {
    data.execute(
        "DELETE FROM note_body_tags WHERE note_id = ?1",
        params![doc_id],
    )
    .map_err(failed)?;
    Ok(())
}

/// Runs `rewrite`, which replaces a document's cached body tags, as one commit. The tag readers
/// (`used_tags`, `tag_counts`, `tags::gone`) run on their own connections and see the last
/// commit, so a [`clear`] and a [`write`] in autocommit show a body that carries no tags between
/// them. A savepoint, so it also nests in the caller's transaction.
pub(crate) fn replaced_as_one<T>(
    data: &Connection,
    rewrite: impl FnOnce() -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    data.execute_batch("SAVEPOINT body_tags_rewrite")
        .map_err(failed)?;
    match rewrite() {
        Ok(value) => {
            data.execute_batch("RELEASE body_tags_rewrite")
                .map_err(failed)?;
            Ok(value)
        }
        Err(error) => match data
            .execute_batch("ROLLBACK TO body_tags_rewrite; RELEASE body_tags_rewrite")
        {
            Ok(()) => Err(error),
            Err(rollback) => Err(StorageError::Failed {
                what: format!("{error}; the body tags it wrote were not rolled back: {rollback}"),
            }),
        },
    }
}

/// `(item_type, item_id, tag)` for each body tag on a live note or journal.
pub fn carriers(conn: &Connection) -> Result<Vec<(String, String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT s.item_type, b.note_id, b.tag FROM note_body_tags b
               JOIN sync_items s ON s.item_id = b.note_id
              WHERE s.item_type IN ('note', 'journal') AND s.deleted_at IS NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::crdt::blocks::InlineRun;

    fn run(text: &str, marks: &[&str], target: Option<&str>) -> InlineRun {
        InlineRun {
            text: text.to_owned(),
            marks: marks.iter().map(|m| (*m).to_owned()).collect(),
            mark_attrs: HashMap::new(),
            target: target.map(str::to_owned),
        }
    }

    fn block(kind: &str, inline: Vec<InlineRun>) -> Block {
        Block {
            id: None,
            kind: kind.to_owned(),
            depth: 0,
            props: Vec::new(),
            inline,
        }
    }

    #[test]
    fn reads_tags_as_desktop_indexes_them() {
        let blocks = vec![
            block(
                "paragraph",
                vec![run(
                    "#Books and a#not, #9no #2024 #area/sub-1 #work",
                    &[],
                    None,
                )],
            ),
            block("paragraph", vec![run("", &["hashTag"], Some("chip"))]),
            block(
                "paragraph",
                vec![run("#inline", &["code"], None), run(" #books", &[], None)],
            ),
            block("codeBlock", vec![run("#literal", &[], None)]),
        ];
        assert_eq!(
            extract(&blocks),
            ["Books", "9no", "area/sub-1", "work", "chip"]
        );
    }

    #[test]
    fn reads_tags_in_every_script() {
        let text = "#퓨리 #привет, #タグ。 #हिन्दी #ภาษาไทย #عربي #İş/alt #café #2024년 日本語#タグ #\u{301}a";
        let blocks = vec![block("paragraph", vec![run(text, &[], None)])];
        assert_eq!(
            extract(&blocks),
            [
                "퓨리",
                "привет",
                "タグ",
                "हिन्दी",
                "ภาษาไทย",
                "عربي",
                "İş/alt",
                "café",
                "2024년"
            ]
        );
    }
}
