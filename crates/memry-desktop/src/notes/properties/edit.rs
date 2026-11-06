//! What a property edit makes of a note's frontmatter, on the values the file holds
//! (`vault/frontmatter.ts`): the legacy nested envelope moved to the top level
//! (`normalizePropertiesToRoot`), and the three edits. Which keys are user properties is
//! [`user_properties`].
//!
//! - **Set** (`properties:set`): the renderer sends its whole record and the record it was
//!   shown (`base`). Only what the user changed against `base` lands: a changed or new value is
//!   written, a name `base` has and the record lacks goes. A value the user left alone keeps the
//!   file's value, so an outside edit the panel had not shown yet survives. Electron replaces the
//!   whole record with the renderer's, which writes a stale panel over such an edit.
//! - **Merge** (`properties:merge`, `patchPropertiesOnRoot`): the named keys are set, a `null`
//!   one goes, and new keys take the place of the first that went, else the end.
//! - **Rename** (`properties:rename`): the key goes, its file value comes back under the new
//!   name at the end. Electron writes the index's copy of the value instead, which turns a YAML
//!   date into a quoted string; this keeps the date.
//! - **RenameField** (the vault-wide field rename, `{ [from]: null, [to]: value }` merged): the
//!   file's value of `from` takes `to` in `from`'s place; the block edit writes the new key last,
//!   as Electron's `editFrontmatterBlock` does. A note without `from` is left; one with
//!   another key that folds to `to` (`toLowerCase`) is refused with
//!   [`NotesError::PropertyExists`] and keeps both. Every key counts there, not only the user
//!   properties: Electron's merge wrote the value over a `cover` the note had.

use memry_core::markdown::frontmatter::{YamlMap, YamlValue, json_to_yaml};
use serde_json::{Map, Value};

use crate::notes::error::NotesError;
use crate::notes::frontmatter::{is_reserved_key, is_reserved_yaml, user_properties};

/// A property edit of one note.
#[derive(Debug, Clone, PartialEq)]
pub enum PropertyEdit {
    Set {
        properties: Map<String, Value>,
        base: Map<String, Value>,
    },
    Merge(Map<String, Value>),
    Rename {
        from: String,
        to: String,
    },
    RenameField {
        from: String,
        to: String,
    },
}

/// `normalizePropertiesToRoot`: the nested envelope's keys at the top level, where a top-level
/// key of the same name wins.
fn to_root(frontmatter: &YamlMap) -> YamlMap {
    let mut out = frontmatter.clone();
    let Some(YamlValue::Map(nested)) = out.remove("properties") else {
        return frontmatter.clone();
    };
    for (name, value) in nested.iter() {
        if !is_reserved_yaml(name, value) && !out.contains_key(name) {
            out.insert(name.to_owned(), value.clone());
        }
    }
    out
}

/// The frontmatter `edit` makes of `frontmatter`.
pub fn edited(frontmatter: &YamlMap, edit: &PropertyEdit) -> Result<YamlMap, NotesError> {
    let mut next = to_root(frontmatter);
    match edit {
        PropertyEdit::Set { properties, base } => {
            for name in base.keys() {
                let gone = !properties.contains_key(name)
                    && next.get(name).is_some_and(|v| !is_reserved_yaml(name, v));
                if gone {
                    next.remove(name);
                }
            }
            for (name, value) in properties {
                if base.get(name) != Some(value) && !is_reserved_key(name, value) {
                    next.insert(name.clone(), json_to_yaml(value));
                }
            }
            Ok(next)
        }
        PropertyEdit::Merge(patch) => Ok(merged(&next, patch)),
        PropertyEdit::Rename { from, to } => {
            let held = user_properties(frontmatter);
            let Some(value) = held.get(from).cloned() else {
                return Err(NotesError::PropertyNotFound(from.clone()));
            };
            if from == to {
                return Ok(next);
            }
            // A name Memry keeps for itself would drop the value from the properties.
            if held.contains_key(to) || is_reserved_yaml(to, &value) {
                return Err(NotesError::PropertyExists(to.clone()));
            }
            next.remove(from);
            next.insert(to.clone(), value);
            Ok(next)
        }
        PropertyEdit::RenameField { from, to } => {
            let Some(value) = user_properties(frontmatter).get(from).cloned() else {
                return Ok(next);
            };
            let target = to.to_lowercase();
            let taken = next
                .iter()
                .any(|(name, _)| name != from.as_str() && name.to_lowercase() == target);
            if taken || is_reserved_yaml(to, &value) {
                return Err(NotesError::PropertyExists(to.clone()));
            }
            let mut renamed = YamlMap::new();
            for (name, held) in next.iter() {
                match name == from.as_str() {
                    true => renamed.insert(to.clone(), value.clone()),
                    false => renamed.insert(name.to_owned(), held.clone()),
                }
            }
            Ok(renamed)
        }
    }
}

/// `patchPropertiesOnRoot`.
fn merged(frontmatter: &YamlMap, patch: &Map<String, Value>) -> YamlMap {
    let entries: Vec<(&String, &Value)> = patch
        .iter()
        .filter(|(name, value)| !is_reserved_key(name, value))
        .collect();
    let added: Vec<(&String, &Value)> = entries
        .iter()
        .filter(|(name, value)| !value.is_null() && !frontmatter.contains_key(name))
        .copied()
        .collect();
    let add = |next: &mut YamlMap| {
        for (name, value) in &added {
            next.insert((*name).clone(), json_to_yaml(value));
        }
    };
    let mut next = YamlMap::new();
    let mut placed = false;
    for (name, value) in frontmatter.iter() {
        match entries.iter().find(|(key, _)| key.as_str() == name) {
            Some((_, patched)) if patched.is_null() => {
                if !placed {
                    add(&mut next);
                }
                placed = true;
            }
            Some((_, patched)) => next.insert(name.to_owned(), json_to_yaml(patched)),
            None => next.insert(name.to_owned(), value.clone()),
        }
    }
    if !placed {
        add(&mut next);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use memry_core::markdown::frontmatter::parse_markdown_note;
    use serde_json::json;

    fn map(yaml: &str) -> YamlMap {
        match parse_markdown_note(&format!("---\n{yaml}\n---\n"))
            .unwrap()
            .frontmatter
        {
            YamlValue::Map(map) => (*map).clone(),
            other => panic!("{other:?}"),
        }
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn keys(map: &YamlMap) -> Vec<&str> {
        map.iter().map(|(name, _)| name).collect()
    }

    #[test]
    fn a_set_lands_only_what_the_user_changed_against_what_they_were_shown() {
        // Shown {a: 1, b: x, c: old}; since then an outside edit set b to y and added d.
        let file = map("tags: [t]\na: 1\nb: y\nc: old\nd: new");
        let set = PropertyEdit::Set {
            properties: object(json!({ "a": 2, "b": "x", "e": "added" })),
            base: object(json!({ "a": 1, "b": "x", "c": "old" })),
        };
        let next = edited(&file, &set).unwrap();
        assert_eq!(keys(&next), ["tags", "a", "b", "d", "e"]);
        assert_eq!(next.get("a"), Some(&YamlValue::Number(2.0)));
        // The user left b alone: the outside edit's value stays, as does d.
        assert_eq!(next.get("b"), Some(&YamlValue::String("y".into())));
        assert_eq!(next.get("d"), Some(&YamlValue::String("new".into())));
    }

    #[test]
    fn a_set_never_writes_or_removes_a_key_memry_keeps() {
        let file = map("tags: [t]\ncover: wash:sage\na: 1");
        let set = PropertyEdit::Set {
            properties: object(json!({ "tags": ["x"], "cover": "https://example.com/c.png" })),
            base: object(json!({ "a": 1, "cover": "wash:sage", "tags": ["t"] })),
        };
        let next = edited(&file, &set).unwrap();
        assert_eq!(keys(&next), ["tags", "cover"]);
        assert_eq!(
            next.get("cover"),
            Some(&YamlValue::String("wash:sage".into()))
        );
    }

    #[test]
    fn the_nested_envelope_moves_to_the_top_level_and_the_top_level_wins() {
        let file = map("properties:\n  a: 1\n  b: 2\nb: 3");
        assert_eq!(
            user_properties(&file).get("b"),
            Some(&YamlValue::Number(3.0))
        );
        let next = edited(&file, &PropertyEdit::Merge(Map::new())).unwrap();
        assert_eq!(keys(&next), ["b", "a"]);
        assert_eq!(next.get("b"), Some(&YamlValue::Number(3.0)));
    }

    #[test]
    fn a_merge_puts_new_keys_where_the_first_removed_one_was() {
        let file = map("a: 1\nb: 2\nc: 3");
        let patch = object(json!({ "b": null, "z": "new", "c": 4, "a": null }));
        let next = edited(&file, &PropertyEdit::Merge(patch)).unwrap();
        assert_eq!(keys(&next), ["z", "c"]);
        let patch = object(json!({ "z": "end", "missing": null }));
        let next = edited(&file, &PropertyEdit::Merge(patch)).unwrap();
        assert_eq!(keys(&next), ["a", "b", "c", "z"]);
    }

    #[test]
    fn a_field_rename_takes_the_old_keys_place_and_leaves_a_note_holding_the_new_name() {
        let file = map("tags: [t]\nRole: PM\nPhone: 2026-10-07\nEmail: e");
        let rename = |file: &YamlMap, from: &str, to: &str| {
            edited(
                file,
                &PropertyEdit::RenameField {
                    from: from.into(),
                    to: to.into(),
                },
            )
        };
        let next = rename(&file, "Phone", "Mobile").unwrap();
        assert_eq!(keys(&next), ["tags", "Role", "Mobile", "Email"]);
        assert!(matches!(next.get("Mobile"), Some(YamlValue::Date(_))));
        let next = rename(&file, "Phone", "phone").unwrap();
        assert_eq!(keys(&next), ["tags", "Role", "phone", "Email"]);
        assert_eq!(rename(&file, "Fax", "Mobile").unwrap(), file);
        for (yaml, to) in [
            ("Phone: 1\nmobile: 2", "Mobile"),
            ("Phone: 1\ncover: wash:sage", "Cover"),
            ("Phone: 1", "tags"),
        ] {
            assert!(
                matches!(
                    rename(&map(yaml), "Phone", to),
                    Err(NotesError::PropertyExists(_))
                ),
                "{yaml} to {to}"
            );
        }
    }

    #[test]
    fn a_rename_keeps_the_file_value_and_refuses_a_taken_or_missing_name() {
        let file = map("due: 2026-10-07\nother: x\ntags: [t]");
        let rename = |from: &str, to: &str| {
            edited(
                &file,
                &PropertyEdit::Rename {
                    from: from.into(),
                    to: to.into(),
                },
            )
        };
        let next = rename("due", "deadline").unwrap();
        assert_eq!(keys(&next), ["other", "tags", "deadline"]);
        assert!(matches!(next.get("deadline"), Some(YamlValue::Date(_))));
        assert!(matches!(
            rename("nope", "x"),
            Err(NotesError::PropertyNotFound(_))
        ));
        assert!(matches!(
            rename("due", "other"),
            Err(NotesError::PropertyExists(_))
        ));
        assert!(matches!(
            rename("due", "tags"),
            Err(NotesError::PropertyExists(_))
        ));
    }
}
