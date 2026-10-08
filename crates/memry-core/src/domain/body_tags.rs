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

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::domain::notes::failed;
use crate::domain::tags;

/// `note_tags` and `note_body_tags` as one `(note_id, tag)` relation. `UNION`
/// compares with `note_tags.tag`'s `NOCASE`, so a tag both halves carry is one
/// row.
pub const ALL_NOTE_TAGS: &str = "(SELECT note_id, tag FROM note_tags WHERE deleted_at IS NULL \
     UNION SELECT note_id, tag FROM note_body_tags)";

/// The body's tags, as desktop's `extractInlineTagsFromMarkdown` reads them
/// from the markdown it writes: a `#` at the start of a line or after
/// whitespace, then a letter, then tag characters, with `/` nesting. Code
/// blocks and inline code are skipped. A `hashTag` node is `#tag` on disk.
/// Deduped case-insensitively, first spelling kept.
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

fn scan(line: &str, found: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut at = 0;
    while at < chars.len() {
        let starts = chars[at] == '#'
            && (at == 0 || chars[at - 1].is_whitespace())
            && chars.get(at + 1).is_some_and(char::is_ascii_alphabetic);
        if !starts {
            at += 1;
            continue;
        }
        let mut end = at + 1;
        while end < chars.len() && word(chars[end]) {
            end += 1;
        }
        // A `/` continues the tag only when a segment follows it.
        while chars.get(end) == Some(&'/')
            && chars.get(end + 1).is_some_and(char::is_ascii_alphanumeric)
        {
            end += 1;
            while end < chars.len() && word(chars[end]) {
                end += 1;
            }
        }
        found.push(chars[at + 1..end].iter().collect());
        at = end;
    }
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
                vec![run("#Books and a#not, #9no #area/sub-1 #work", &[], None)],
            ),
            block("paragraph", vec![run("", &["hashTag"], Some("chip"))]),
            block(
                "paragraph",
                vec![run("#inline", &["code"], None), run(" #books", &[], None)],
            ),
            block("codeBlock", vec![run("#literal", &[], None)]),
        ];
        assert_eq!(extract(&blocks), ["Books", "area/sub-1", "work", "chip"]);
    }
}
