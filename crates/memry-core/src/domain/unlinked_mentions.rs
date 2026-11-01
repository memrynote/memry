//! Unlinked mentions (#3320): notes and journal days whose body spells another
//! note's title or alias as plain text, without linking to it.
//!
//! Desktop's `packages/shared/src/unlinked-mentions.ts` is the reference,
//! pinned by the `unlinked-mentions` vectors (chapter 12 §12.7.3):
//!
//!   * a name shorter than [`MIN_MENTION_NAME_LENGTH`] characters is skipped;
//!   * each character folds on its own with the tag fold, so matching is
//!     case-insensitive the way names are;
//!   * a match is whole-word: the characters on both sides are not letters,
//!     digits or `_`;
//!   * at one position the longest name wins, and the scan resumes after it.
//!
//! The core's bodies are `extract_text` output, not markdown, so there is no
//! code or link syntax to mask here. A source that already links to the note
//! is a backlink and is left out whole.

use std::collections::HashSet;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::api::search::BacklinkOrder;
use crate::domain::journal_ops::links;
use crate::domain::notes::failed;
use crate::domain::notes::names::{js_trim, parse_stored};
use crate::domain::tags;

pub const MIN_MENTION_NAME_LENGTH: usize = 3;

/// One mention in a scanned text. Offsets are byte offsets, `end` exclusive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlainMention {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// One note or journal day that mentions the target without linking to it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct UnlinkedMention {
    pub source_id: String,
    /// The note's title, or the journal's date.
    pub source_title: String,
    /// `note` or `journal`.
    pub source_kind: String,
    /// The journal's date, `None` for a note source.
    pub source_date: Option<String>,
    /// Each mention as written, in body order.
    pub mentions: Vec<String>,
}

fn is_word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// Every whole-word mention of `names` in `text`, in order.
pub fn find_plain_mentions(text: &str, names: &[String]) -> Vec<PlainMention> {
    let mut seen = HashSet::new();
    let mut folded: Vec<Vec<String>> = Vec::new();
    for name in names {
        let chars: Vec<String> = js_trim(name)
            .chars()
            .map(|c| tags::fold(c.encode_utf8(&mut [0; 4])))
            .collect();
        if chars.len() < MIN_MENTION_NAME_LENGTH || !seen.insert(chars.concat()) {
            continue;
        }
        folded.push(chars);
    }
    if folded.is_empty() {
        return Vec::new();
    }
    folded.sort_by_key(|chars| std::cmp::Reverse(chars.len()));

    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let folded_text: Vec<String> = chars
        .iter()
        .map(|(_, c)| tags::fold(c.encode_utf8(&mut [0; 4])))
        .collect();
    let offset = |at: usize| chars.get(at).map_or(text.len(), |(byte, _)| *byte);
    let char_at = |at: usize| chars.get(at).map(|(_, c)| *c);

    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let preceded = at > 0 && is_word_char(char_at(at - 1));
        let name = (!preceded)
            .then(|| {
                folded.iter().find(|name| {
                    name.iter()
                        .enumerate()
                        .all(|(k, c)| folded_text.get(at + k) == Some(c))
                        && !is_word_char(char_at(at + name.len()))
                })
            })
            .flatten();
        let Some(name) = name else {
            at += 1;
            continue;
        };
        let (start, end) = (offset(at), offset(at + name.len()));
        out.push(PlainMention {
            start,
            end,
            text: text[start..end].to_owned(),
        });
        at += name.len();
    }
    out
}

/// Every live note or journal day mentioning `target_id`'s title or an alias
/// without linking to it, ordered by source title. Empty when the id names
/// nothing live.
///
/// Candidates come from the FTS index (a phrase query per name, over the body
/// column) and are then matched exactly; a name with no letter or digit has no
/// FTS token and finds nothing.
pub fn unlinked_mentions(
    data: &Connection,
    index: &Connection,
    target_id: &str,
) -> Result<Vec<UnlinkedMention>, StorageError> {
    let names = target_names(data, target_id)?;
    let phrases: Vec<String> = names
        .iter()
        .filter(|name| name.chars().any(char::is_alphanumeric))
        .map(|name| format!("\"{}\"", js_trim(name).replace('"', "\"\"")))
        .collect();
    if phrases.is_empty() {
        return Ok(Vec::new());
    }
    let linked: HashSet<String> = links::backlinks(data, index, target_id, BacklinkOrder::Title)?
        .into_iter()
        .map(|row| row.source_id)
        .collect();

    let mut statement = index
        .prepare("SELECT id, content FROM fts_notes WHERE fts_notes MATCH ?1")
        .map_err(failed)?;
    let query = format!("content : ({})", phrases.join(" OR "));
    let candidates = statement
        .query_map(params![query], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;

    let mut found = Vec::new();
    for candidate in candidates {
        let (source_id, content) = candidate.map_err(failed)?;
        if source_id == target_id || linked.contains(&source_id) {
            continue;
        }
        let mentions = find_plain_mentions(&content, &names);
        if !mentions.is_empty() {
            found.push((source_id, mentions));
        }
    }
    // One read for every source, not one per source.
    let sources = links::live_items(data, found.iter().map(|(id, _)| id.as_str()))?;
    let mut out = Vec::new();
    for (source_id, mentions) in found {
        let Some(source) = sources.get(&source_id) else {
            continue;
        };
        let (source_title, source_kind, source_date) = source.named();
        out.push(UnlinkedMention {
            source_id,
            source_title,
            source_kind: source_kind.to_owned(),
            source_date,
            mentions: mentions.into_iter().map(|mention| mention.text).collect(),
        });
    }
    out.sort_by(|a, b| {
        a.source_title
            .to_lowercase()
            .cmp(&b.source_title.to_lowercase())
            .then_with(|| a.source_id.cmp(&b.source_id))
    });
    Ok(out)
}

/// The target's title (a day's date) and aliases.
fn target_names(data: &Connection, target_id: &str) -> Result<Vec<String>, StorageError> {
    let row: Option<(String, Option<String>)> = data
        .query_row(
            "SELECT title, aliases FROM notes WHERE id = ?1 AND deleted_at IS NULL \
             UNION ALL \
             SELECT j.date, a.aliases FROM journal_entries j \
             LEFT JOIN journal_aliases a ON a.journal_id = j.id \
             WHERE j.id = ?1 AND j.deleted_at IS NULL",
            params![target_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            error => Err(failed(error)),
        })?;
    let Some((title, aliases)) = row else {
        return Ok(Vec::new());
    };
    let aliases = parse_stored(aliases).map_err(|error| StorageError::Failed {
        what: format!("`{target_id}` has unreadable `aliases`: {error}"),
    })?;
    Ok(std::iter::once(title).chain(aliases).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(text: &str, names: &[&str]) -> Vec<String> {
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        find_plain_mentions(text, &names)
            .into_iter()
            .map(|mention| mention.text)
            .collect()
    }

    #[test]
    fn whole_word_case_insensitive_longest_first() {
        assert_eq!(
            texts(
                "The project plan, planning, and PROJECT PLAN.",
                &["Plan", "Project Plan"]
            ),
            ["project plan", "PROJECT PLAN"]
        );
    }

    #[test]
    fn short_names_are_skipped() {
        assert!(texts("AI and ML", &["AI", "ML"]).is_empty());
    }
}
