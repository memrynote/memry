//! A note's header tags, the frontmatter `tags:` list, as an app edit changes them (desktop
//! `nextHeaderTags` and `compareHeaderTags`, `vault/note-write.ts`; `applyHeaderTagEdit`,
//! `vault/frontmatter.ts`; `inlineTagEditBetween` and `applyInlineTagEdit`,
//! `tags/inline-tags.ts`).
//!
//! An edit is a delta against the list in the file ([`HeaderTagEdit`]), never a list, so a
//! caller cannot write the body's `#tags` it read into the header. A save that changes the body
//! also carries the `#tags` typed into or deleted from it: a plain tag joins or leaves the
//! header with them, and a tag with fields stays a mention in the text.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::domain::body_tags;
use crate::domain::tags::{fold, tag_key};

/// A change to a note's header tags (contracts `HeaderTagEditSchema`): removes first, then
/// renames in place, then adds the list does not hold. Names compare by tag fold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderTagEdit {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub rename: Vec<HeaderTagRename>,
    /// `Some(Inline)`: the `#tags` typed into or deleted from the body.
    #[serde(default)]
    pub source: Option<EditSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HeaderTagRename {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditSource {
    Inline,
}

/// What an edit did to the list, by tag fold; `None` when the list kept every spelling in
/// order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderTagChange {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// The note as the edit finds it.
pub struct Existing<'a> {
    /// The file's header tags as a read takes them (trimmed, folded duplicates dropped).
    pub header_tags: &'a [String],
    /// The file's body.
    pub content: &'a str,
}

/// The edit an update asks for.
#[derive(Default)]
pub struct Update<'a> {
    pub header_tags: Option<&'a HeaderTagEdit>,
    /// The agent API's whole `tags:` list, read as a delta against the header. Ignored when
    /// `header_tags` is set.
    pub tags: Option<&'a [String]>,
    /// The new body, when the update changes it.
    pub content: Option<&'a str>,
    /// The body's `#tags` do not touch the header.
    pub ignore_inline_tags: bool,
}

/// `applyHeaderTagEdit`: `current` with `edit`'s removes, renames and adds.
pub fn apply(current: &[String], edit: &HeaderTagEdit) -> Vec<String> {
    let removed: HashSet<String> = edit.remove.iter().map(|tag| tag_key(tag)).collect();
    // The last rename of a name wins, as in the `Map` desktop builds from the list.
    let renames: HashMap<String, &str> = edit
        .rename
        .iter()
        .map(|rename| (tag_key(&rename.from), rename.to.trim()))
        .collect();
    let mut held = HashSet::new();
    let mut next: Vec<String> = Vec::new();
    let mut append = |tag: &str| {
        if !tag.is_empty() && held.insert(tag_key(tag)) {
            next.push(tag.to_owned());
        }
    };
    for tag in current {
        let key = tag_key(tag);
        if removed.contains(&key) {
            continue;
        }
        append(renames.get(&key).copied().unwrap_or(tag));
    }
    for tag in &edit.add {
        append(tag.trim());
    }
    next
}

/// `nextHeaderTags`: the header tags after `update`. `with_fields` holds the keys of the tags
/// with fields, which the body's `#tags` never add or remove.
pub fn next(
    existing: &Existing<'_>,
    update: &Update<'_>,
    with_fields: &HashSet<String>,
) -> Vec<String> {
    let from_list;
    let explicit = match (update.header_tags, update.tags) {
        (Some(edit), _) => Some(edit),
        (None, Some(list)) => {
            from_list = edit_to_list(existing.header_tags, existing.content, list);
            Some(&from_list)
        }
        (None, None) => None,
    };
    let inline = explicit.is_some_and(|edit| edit.source == Some(EditSource::Inline));
    let mut tags = match explicit {
        None => existing.header_tags.to_vec(),
        Some(edit) if inline => apply_inline(existing.header_tags, edit, with_fields),
        Some(edit) => apply(existing.header_tags, edit),
    };
    if !inline
        && !update.ignore_inline_tags
        && let Some(edit) = update
            .content
            .and_then(|content| inline_edit_between(existing.content, content))
    {
        tags = apply_inline(&tags, &edit, with_fields);
    }
    tags
}

/// `compareHeaderTags`.
pub fn compare(before: &[String], after: &[String]) -> Option<HeaderTagChange> {
    if before == after {
        return None;
    }
    let keys = |list: &[String]| list.iter().map(|tag| fold(tag)).collect::<HashSet<_>>();
    let (before_keys, after_keys) = (keys(before), keys(after));
    let missing = |list: &[String], keys: &HashSet<String>| {
        list.iter()
            .filter(|tag| !keys.contains(&fold(tag)))
            .cloned()
            .collect()
    };
    Some(HeaderTagChange {
        added: missing(after, &before_keys),
        removed: missing(before, &after_keys),
    })
}

/// `headerTagEditToList`: the delta that makes `header` the list `next`, leaving out a tag the
/// body already holds as a `#tag`.
fn edit_to_list(header: &[String], body: &str, next: &[String]) -> HeaderTagEdit {
    let have: HashSet<String> = header.iter().map(|tag| fold(tag)).collect();
    let want: HashSet<String> = next.iter().map(|tag| fold(tag)).collect();
    let inline: HashSet<String> = body_tags::extract_markdown(body)
        .iter()
        .map(|tag| fold(tag))
        .collect();
    HeaderTagEdit {
        add: next
            .iter()
            .filter(|tag| !have.contains(&fold(tag)) && !inline.contains(&fold(tag)))
            .cloned()
            .collect(),
        remove: header
            .iter()
            .filter(|tag| !want.contains(&fold(tag)))
            .cloned()
            .collect(),
        ..HeaderTagEdit::default()
    }
}

/// `inlineTagEditBetween`: the `#tags` a body change typed or deleted.
fn inline_edit_between(previous: &str, next: &str) -> Option<HeaderTagEdit> {
    let before = body_tags::extract_markdown(previous);
    let after = body_tags::extract_markdown(next);
    let keys = |tags: &[String]| tags.iter().map(|tag| fold(tag)).collect::<HashSet<_>>();
    let (before_keys, after_keys) = (keys(&before), keys(&after));
    let add: Vec<String> = after
        .iter()
        .filter(|tag| !before_keys.contains(&fold(tag)))
        .cloned()
        .collect();
    let remove: Vec<String> = before
        .into_iter()
        .filter(|tag| !after_keys.contains(&fold(tag)))
        .collect();
    (!add.is_empty() || !remove.is_empty()).then(|| HeaderTagEdit {
        add,
        remove,
        rename: Vec::new(),
        source: Some(EditSource::Inline),
    })
}

/// `applyInlineTagEdit`: the adds and removes of the plain tags only.
fn apply_inline(
    current: &[String],
    edit: &HeaderTagEdit,
    with_fields: &HashSet<String>,
) -> Vec<String> {
    let plain = |tags: &[String]| {
        tags.iter()
            .filter(|tag| !with_fields.contains(&tag_key(tag)))
            .cloned()
            .collect()
    };
    let edit = HeaderTagEdit {
        add: plain(&edit.add),
        remove: plain(&edit.remove),
        ..HeaderTagEdit::default()
    };
    apply(current, &edit)
}

#[cfg(feature = "markdown")]
pub use frontmatter::set_tags;

#[cfg(feature = "markdown")]
mod frontmatter {
    use std::sync::Arc;

    use super::HeaderTagChange;
    use crate::markdown::frontmatter::{YamlMap, YamlValue};

    /// The `tags` key of the next frontmatter (`nextNoteFrontmatter`): left as the file has it
    /// when the list did not change, else the list, or no key for an empty one.
    pub fn set_tags(frontmatter: &mut YamlMap, tags: &[String], change: Option<&HeaderTagChange>) {
        if change.is_none() {
            return;
        }
        if tags.is_empty() {
            frontmatter.remove("tags");
        } else {
            let list = tags.iter().cloned().map(YamlValue::String).collect();
            frontmatter.insert("tags".to_owned(), YamlValue::Seq(Arc::new(list)));
        }
    }
}
