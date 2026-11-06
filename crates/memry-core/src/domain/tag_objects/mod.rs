//! Object reads for tags with fields (`tags/objects.ts`, `queries/tag-objects.ts`): the `@` menu
//! and relation picker search ([`search`]). Read-only.
//!
//! A note is an object of a tag through its file's header only: `note_stats.header_tags` of a
//! markdown note that is not a journal day ([`crate::api::search::Search::object_headers`]),
//! never a body `#tag`. Electron also answers `complete: false` while an older build's tag rows
//! lack a header flag; `note_stats` has no such row, so the reads here are always complete.

pub mod search;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use serde_json::Value;

use crate::domain::property_values::parse_relation_uri;
use crate::domain::tag_schema::{ResolvedTag, descendants_of};
use crate::domain::tags::tag_key;

pub use search::{ObjectMatch, fold_for_search};

/// Tag key to its resolved schema ([`crate::domain::tag_schema::resolve`]).
pub type Resolved = BTreeMap<String, ResolvedTag>;

/// The keys of every tag with fields, own or inherited (`fieldTagKeys`).
pub fn field_tags(resolved: &Resolved) -> Vec<String> {
    resolved
        .values()
        .filter(|tag| tag.has_fields)
        .map(|tag| tag.key.clone())
        .collect()
}

/// `tag` and the tags that extend it, `None` when `tag` has no fields (`familyOf`).
pub fn family_of(tag: &str, resolved: &Resolved) -> Option<Vec<String>> {
    let key = tag_key(tag);
    if !resolved.get(&key).is_some_and(|tag| tag.has_fields) {
        return None;
    }
    let descendants = descendants_of(&key, resolved);
    Some(std::iter::once(key).chain(descendants).collect())
}

/// The root of `key`'s extends chain (`rootOf`).
pub fn root_of(key: &str, resolved: &Resolved) -> String {
    resolved
        .get(key)
        .and_then(|tag| tag.ancestors.last())
        .map_or_else(|| key.to_owned(), Clone::clone)
}

/// The note ids a relation value links (`parseRelationValue`, kind `note`): a value that is not
/// a non-empty list of `memry://` links only links none.
pub fn note_refs(value: &Value) -> Vec<&str> {
    let Value::Array(items) = value else {
        return Vec::new();
    };
    let refs: Option<Vec<(&str, &str)>> = items
        .iter()
        .map(|item| item.as_str().and_then(parse_relation_uri))
        .collect();
    refs.filter(|refs| !refs.is_empty())
        .unwrap_or_default()
        .into_iter()
        .filter(|(kind, _)| *kind == "note")
        .map(|(_, id)| id)
        .collect()
}
