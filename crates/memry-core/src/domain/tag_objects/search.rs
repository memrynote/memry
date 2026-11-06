//! `searchObjects` (`tags/objects.ts`): the objects whose title matches a query, ranked, each
//! with the tag it lists under and a subtitle drawn from its fields.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization as _;
use unicode_normalization::char::is_combining_mark;

use crate::domain::tag_schema::ResolvedTag;
use crate::domain::tags::tag_key;
use crate::markdown::frontmatter::js::{js_trim, number_to_string};

use super::{Resolved, note_refs, root_of};

/// One object a search found (`ObjectMatch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMatch {
    pub note_id: String,
    pub title: String,
    /// The note's primary object tag key, within the searched family when one was given.
    pub tag: String,
    /// The root of `tag`'s extends chain: the group the match lists under.
    pub group_tag: String,
    /// `tag` when it differs from `group_tag`.
    pub via_tag: Option<String>,
    /// The first filled text-like field, then the first filled relation's title (else the
    /// second text-like field).
    pub subtitle: Vec<String>,
    /// ISO time.
    pub modified: String,
}

/// An object the search may list: a live note whose header carries a candidate tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    /// ISO time.
    pub modified: String,
    /// The first candidate tag key of its header.
    pub tag: String,
}

/// Each note's first header tag among `tags` (by key), for the notes with one (`headerMembers`).
pub fn members(headers: Vec<(String, Vec<String>)>, tags: &[String]) -> HashMap<String, String> {
    let tags: HashSet<&str> = tags.iter().map(String::as_str).collect();
    headers
        .into_iter()
        .filter_map(|(id, header)| {
            let first = header
                .iter()
                .map(|tag| tag_key(tag))
                .find(|key| tags.contains(key.as_str()))?;
            Some((id, first))
        })
        .collect()
}

/// Lowercase with diacritics removed, so "ahm" finds "Ahmet" and "s" finds "ş"
/// (`foldForSearch`). Turkish dotted and dotless i both fold to "i".
pub fn fold_for_search(text: &str) -> String {
    let dotted: String = text
        .chars()
        .map(|c| {
            if matches!(c, 'İ' | 'I' | 'ı') {
                'i'
            } else {
                c
            }
        })
        .collect();
    dotted
        .to_lowercase()
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect()
}

static WORD_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").expect("a valid pattern"));

/// 0 for a title that starts with `query` (or any title for an empty query), 1 for one with a
/// word that does, 2 for one that holds it, `None` otherwise (`matchRank`). `query` is folded.
fn match_rank(title: &str, query: &str) -> Option<u8> {
    if query.is_empty() {
        return Some(0);
    }
    let folded = fold_for_search(title);
    if folded.starts_with(query) {
        Some(0)
    } else if WORD_BREAK
        .split(&folded)
        .any(|word| word.starts_with(query))
    {
        Some(1)
    } else {
        folded.contains(query).then_some(2)
    }
}

/// The candidates matching `query` by rank, then newest first, at most `limit` of them.
pub fn ranked(candidates: Vec<Candidate>, query: &str, limit: usize) -> Vec<Candidate> {
    let query = fold_for_search(js_trim(query));
    let mut ranked: Vec<(u8, Candidate)> = candidates
        .into_iter()
        .filter_map(|candidate| Some((match_rank(&candidate.title, &query)?, candidate)))
        .collect();
    ranked.sort_by(|(rank_a, a), (rank_b, b)| {
        rank_a
            .cmp(rank_b)
            .then_with(|| Reverse(&a.modified).cmp(&Reverse(&b.modified)))
            .then_with(|| a.id.cmp(&b.id))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, candidate)| candidate)
        .collect()
}

const TEXT_LIKE: [&str; 4] = ["text", "url", "select", "status"];

/// A string with text or a number, as the subtitle shows it (`filled`, `String(value)`).
fn filled(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !js_trim(text).is_empty() => Some(text.clone()),
        Value::Number(number) => number.as_f64().map(number_to_string),
        _ => None,
    }
}

/// The match's subtitle (`subtitleFor`): the first filled text-like field of `entry`'s fields,
/// then the title of the first note a relation field links (else the second text-like field).
pub fn subtitle(
    values: &HashMap<String, Value>,
    entry: Option<&ResolvedTag>,
    title_of: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut texts = Vec::new();
    let mut relation = None;
    for field in entry
        .map(|tag| tag.effective_fields.as_slice())
        .unwrap_or_default()
    {
        let Some(value) = values.get(&field.name) else {
            continue;
        };
        if field.type_name == "relation" {
            if relation.is_none() {
                relation = note_refs(value).into_iter().find_map(&title_of);
            }
        } else if TEXT_LIKE.contains(&field.type_name.as_str())
            && let Some(text) = filled(value)
        {
            texts.push(text);
        }
    }
    let mut texts = texts.into_iter();
    texts
        .next()
        .into_iter()
        .chain(relation.or_else(|| texts.next()))
        .collect()
}

/// The match a candidate makes.
pub fn matched(candidate: Candidate, subtitle: Vec<String>, resolved: &Resolved) -> ObjectMatch {
    let group_tag = root_of(&candidate.tag, resolved);
    ObjectMatch {
        note_id: candidate.id,
        title: candidate.title,
        via_tag: (candidate.tag != group_tag).then(|| candidate.tag.clone()),
        tag: candidate.tag,
        group_tag,
        subtitle,
        modified: candidate.modified,
    }
}
