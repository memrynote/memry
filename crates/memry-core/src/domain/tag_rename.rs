//! Tag rename, after desktop's `renameTagEverywhere`
//! (`apps/desktop/src/main/tags/rename-tag.ts`).
//!
//! Renaming `old` to `new` renames every `old/…` child too, each to `new/…`:
//! the payload tags of notes, journals and tasks ([`tag_admin::rewrite`]), the
//! `tag_definition` items, the schema references of other tags
//! ([`tag_schema_refs`]) and the body `#tags` ([`tag_body_rename`]). A new name
//! that already exists merges, as `tags:merge` does: the items join it and its
//! definition is kept, the renamed one tombstoned. Children go first, so
//! renaming `a` to `a/b` moves an existing `a/b` to `a/b/b` before `a` lands
//! on `a/b`.

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{
    carriers, definition_for, delete_definitions, item_count, live_definition, refuse, rewrite,
    upsert_definition,
};
use crate::domain::{body_tags, tag_body_rename, tag_schema_refs, tags};

fn pairs(conn: &Connection, old: &str, new: &str) -> Result<Vec<(String, String)>, StorageError> {
    let old_key = tags::fold(old.trim());
    let mut names: Vec<String> = carriers(conn, None)?
        .into_iter()
        .chain(body_tags::carriers(conn)?)
        .map(|(_, _, tag)| tag)
        .collect();
    let mut statement = conn
        .prepare("SELECT name FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    for row in rows {
        names.push(row.map_err(failed)?);
    }
    let mut seen = BTreeSet::from([old_key.clone()]);
    let mut out = vec![(old_key.clone(), new.to_owned())];
    for name in names {
        let name = name.trim();
        let key = tags::fold(name);
        // Segment-wise, never at `old_key.len()`: the fold can change length.
        let depth = old_key.split('/').count();
        let segments: Vec<&str> = name.split('/').collect();
        let child = segments.len() > depth && tags::fold(&segments[..depth].join("/")) == old_key;
        if child && seen.insert(key.clone()) {
            out.push((key, format!("{new}/{}", segments[depth..].join("/"))));
        }
    }
    out.sort_by_key(|(from, _)| std::cmp::Reverse(from.matches('/').count()));
    Ok(out)
}

fn move_definition(
    conn: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if tags::same_tag(from.trim(), to.trim()) {
        return Ok(());
    }
    let Some(from_id) = definition_for(conn, from)? else {
        return Ok(());
    };
    let Some(mut template) = live_definition(conn, &from_id)? else {
        return Ok(());
    };
    if let Some(map) = template.as_object_mut() {
        map.remove("clock");
    }
    if definition_for(conn, to)?.is_none() {
        upsert_definition(conn, to, Some(&template), Vec::new(), device_id, now_ms)?;
    }
    delete_definitions(conn, from, device_id, now_ms)
}

/// Renames a tag and its children everywhere. Returns the number of items
/// whose tags were rewritten.
pub fn rename(
    conn: &Connection,
    old: &str,
    new: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let new = new.trim();
    if new.is_empty() {
        return Err(refuse("a tag name cannot be empty"));
    }
    let mut items = BTreeSet::new();
    for (from, to) in pairs(conn, old, new)? {
        items.extend(rewrite(conn, &from, Some(&to), device_id, now_ms)?);
        move_definition(conn, &from, &to, device_id, now_ms)?;
        tag_schema_refs::rewrite_definitions(conn, &from, Some(&to), device_id, now_ms)?;
    }
    tag_body_rename::rewrite_bodies(conn, old, new, device_id, now_ms);
    Ok(item_count(items.len()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::domain::tag_admin::current_tags;
    use crate::storage::repositories::{InboundRecord, sync_items};
    use crate::storage::{Db, open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn seed(db: &Db, item_type: &str, id: &str, payload: &str) {
        db.call_blocking(|conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: item_type.into(),
                    item_id: id.into(),
                    payload_json: payload.into(),
                    server_cursor: Some(1),
                    signer_device_id: Some("desk".into()),
                    updated_at: NOW,
                    deleted_at: None,
                },
                NOW,
            )?;
            Ok(())
        })
        .expect("seed");
    }

    fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open");
        let note = |id: &str, tags: &str| {
            seed(
                &db,
                "note",
                id,
                &format!(r#"{{"title":"{id}","tags":{tags},"clock":{{"desk":1}}}}"#),
            );
        };
        note("n1", r#"["Job","job/Lead","ideas"]"#);
        note("n2", r#"["work","career/lead"]"#);
        seed(
            &db,
            "journal",
            "j1",
            r#"{"date":"2026-09-24","tags":["job"],"clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "task",
            "t1",
            r#"{"title":"t","tags":["job/lead"],"clock":{"desk":1}}"#,
        );
        for (name, color) in [
            ("job", "#ff0000"),
            ("job/lead", "amber"),
            ("career/lead", "teal"),
        ] {
            seed(
                &db,
                "tag_definition",
                name,
                &format!(r#"{{"name":"{name}","color":"{color}","clock":{{"desk":1}}}}"#),
            );
        }
        (db, dir)
    }

    fn tags_of(db: &Db, item_type: &str, id: &str) -> Vec<String> {
        db.call_blocking(|conn| current_tags(conn, item_type, id))
            .expect("tags")
    }

    #[test]
    fn rename_carries_children_and_merges_into_existing_names() {
        let (db, _d) = vault("tags-rename");
        let count = db
            .call_blocking(|c| rename(c, "job", "career", "phone", NOW + 1))
            .expect("rename");
        assert_eq!(count, 3);
        assert_eq!(
            tags_of(&db, "note", "n1"),
            vec!["career", "career/Lead", "ideas"]
        );
        assert_eq!(tags_of(&db, "journal", "j1"), vec!["career"]);
        assert_eq!(tags_of(&db, "task", "t1"), vec!["career/Lead"]);
        db.call_blocking(|c| {
            assert!(live_definition(c, "job")?.is_none());
            assert!(live_definition(c, "job/lead")?.is_none());
            assert_eq!(
                live_definition(c, "career")?.expect("career")["color"],
                json!("#ff0000")
            );
            assert_eq!(
                live_definition(c, "career/lead")?.expect("career/lead")["color"],
                json!("teal")
            );
            Ok(())
        })
        .expect("defs");
    }

    #[test]
    fn rename_keeps_a_child_suffix_whose_fold_changes_length() {
        let (db, _d) = vault("tags-rename-unicode");
        seed(
            &db,
            "note",
            "n3",
            r#"{"title":"n3","tags":["İş/Plan","ünal"],"clock":{"desk":1}}"#,
        );
        db.call_blocking(|c| rename(c, "iş", "work", "phone", NOW + 1))
            .expect("rename");
        assert_eq!(tags_of(&db, "note", "n3"), vec!["work/Plan", "ünal"]);
        db.call_blocking(|c| rename(c, "ÜNAL", "Name", "phone", NOW + 2))
            .expect("rename");
        assert_eq!(tags_of(&db, "note", "n3"), vec!["work/Plan", "Name"]);
    }

    #[test]
    fn rename_rewrites_body_tags_whole_tags_only() {
        let (db, _d) = vault("tags-rename-body");
        db.call_blocking(|c| {
            let markdown = "Met #job and #Job/lead, not #jobs.\n\n`#job`";
            assert!(
                crate::domain::body_write::append_markdown(c, "n2", markdown, "desk", NOW)
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string()
                    })?
            );
            rename(c, "job", "career", "phone", NOW + 1)?;
            let blocks = crate::domain::reads::note_blocks(c, "n2")
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })?
                .expect("body");
            assert_eq!(
                body_tags::extract(&blocks),
                vec!["career", "career/lead", "jobs"]
            );
            let code = blocks
                .iter()
                .flat_map(|b| &b.inline)
                .find(|r| r.marks.iter().any(|m| m == "code"));
            assert_eq!(code.map(|r| r.text.as_str()), Some("#job"));
            Ok(())
        })
        .expect("body");
    }

    #[test]
    fn rename_to_a_name_not_writable_inline_keeps_body_tags() {
        let (db, _d) = vault("tags-rename-body-skip");
        db.call_blocking(|c| {
            assert!(
                crate::domain::body_write::append_markdown(c, "n2", "Met #job.", "desk", NOW)
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string()
                    })?
            );
            rename(c, "job", "my job", "phone", NOW + 1)?;
            let blocks = crate::domain::reads::note_blocks(c, "n2")
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })?
                .expect("body");
            assert_eq!(body_tags::extract(&blocks), vec!["job"]);
            Ok(())
        })
        .expect("body");
    }
}
