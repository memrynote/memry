//! Object reads for tags with fields (`ipc/tag-object-handlers.ts`,
//! `packages/contracts/src/tag-objects-api.ts`): the `@` menu and relation picker search. The
//! rules live in the core ([`memry_core::domain::tag_objects`]); this checks the input as
//! Electron's zod schemas do and shapes the answer.

use memry_core::api::errors::StorageError;
use memry_core::domain::tag_objects::ObjectMatch;
use serde::{Deserialize, Serialize};

use super::{SchemaError, Schemas};

/// `SearchObjectsSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct SearchObjectsInput {
    pub query: String,
    /// Only objects of this tag and the tags that extend it (a relation's target).
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `ObjectMatch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMatchView {
    pub note_id: String,
    pub title: String,
    pub tag: String,
    pub group_tag: String,
    pub via_tag: Option<String>,
    pub subtitle: Vec<String>,
    pub modified: String,
}

impl From<ObjectMatch> for ObjectMatchView {
    fn from(found: ObjectMatch) -> Self {
        Self {
            note_id: found.note_id,
            title: found.title,
            tag: found.tag,
            group_tag: found.group_tag,
            via_tag: found.via_tag,
            subtitle: found.subtitle,
            modified: found.modified,
        }
    }
}

/// `SearchObjectsResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SearchObjectsView {
    pub matches: Vec<ObjectMatchView>,
    /// Always `true`: the note index has no row from before header tags were measured.
    pub complete: bool,
}

fn views<T, V: From<T>>(items: Vec<T>) -> Vec<V> {
    items.into_iter().map(V::from).collect()
}

fn invalid(what: &str) -> SchemaError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
    .into()
}

/// A count in `1..=max`, `default` when absent.
fn bounded(value: Option<u32>, default: u32, max: u32, what: &str) -> Result<usize, SchemaError> {
    match value.unwrap_or(default) {
        count @ 1.. if count <= max => Ok(count as usize),
        _ => Err(invalid(&format!("{what} must be 1 to {max}"))),
    }
}

impl Schemas {
    /// `tags:search-objects`.
    pub fn search_objects(
        &self,
        input: &SearchObjectsInput,
    ) -> Result<SearchObjectsView, SchemaError> {
        if input.query.encode_utf16().count() > 200 {
            return Err(invalid("a search must be at most 200 characters"));
        }
        let tag = input.tag.as_deref().map(str::trim);
        if tag.is_some_and(|tag| tag.is_empty() || tag.encode_utf16().count() > 100) {
            return Err(invalid("a tag name must be 1 to 100 characters"));
        }
        let limit = bounded(input.limit, 12, 50, "a search limit")?;
        let matches =
            self.open
                .search
                .search_objects(&self.resolved()?, &input.query, tag, limit)?;
        Ok(SearchObjectsView {
            matches: views(matches),
            complete: true,
        })
    }
}
