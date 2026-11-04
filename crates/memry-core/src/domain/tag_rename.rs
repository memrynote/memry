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
//!
//! Desktop, whose note files hold the tags too, renames in parts: [`rename_shared`] for what no
//! file holds, then each of the [`holders`] with its file, one at a time ([`tags::rename`] for
//! the record). The rename in progress is recorded ([`begin`]) so that an interrupted one is
//! finished at the next open; every part does nothing the second time.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{
    carriers, definition_for, delete_definitions, item_count, live_definition, refuse, rewrite,
    rewrite_of, upsert_definition,
};
use crate::domain::tag_body_rename::renamed_tag;
use crate::domain::{body_tags, tag_body_rename, tag_schema_refs, tags};

/// The `meta` key of the rename in progress (desktop's `tags.renameJob` setting); an older
/// build ignores it.
const JOB: &str = "tags.rename_job";

/// A rename in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameJob {
    pub from: String,
    pub to: String,
    pub run_id: String,
}

/// A live note or journal day a rename reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub id: String,
    pub day: bool,
}

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

/// Records `job` as the rename in progress. Another rename recorded (other names) is answered
/// and nothing is written; the same one is recorded again under the new run.
pub fn begin(conn: &Connection, job: &RenameJob) -> Result<Option<RenameJob>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(recorded) = recorded(&tx)?
        && (recorded.from != job.from || recorded.to != job.to)
    {
        return Ok(Some(recorded));
    }
    let value = serde_json::to_string(job).map_err(|error| StorageError::Failed {
        what: format!("a tag rename will not serialise: {error}"),
    })?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![JOB, value],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)?;
    Ok(None)
}

/// The rename in progress. A value that does not read is an error, which [`finish`] clears.
pub fn recorded(conn: &Connection) -> Result<Option<RenameJob>, StorageError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [JOB], |row| {
            row.get(0)
        })
        .optional()
        .map_err(failed)?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| StorageError::Failed {
            what: format!("the recorded tag rename does not read: {error}"),
        })
    })
    .transpose()
}

/// No rename is in progress.
pub fn finish(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [JOB])
        .map_err(failed)?;
    Ok(())
}

/// The part of [`rename`] that no file holds: the tasks' tags, the definitions and the schema
/// references, for desktop.
pub fn rename_shared(
    conn: &Connection,
    old: &str,
    new: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let new = new.trim();
    if new.is_empty() {
        return Err(refuse("a tag name cannot be empty"));
    }
    for (from, to) in pairs(conn, old, new)? {
        rewrite_of(conn, &["task"], &from, Some(&to), device_id, now_ms)?;
        move_definition(conn, &from, &to, device_id, now_ms)?;
        tag_schema_refs::rewrite_definitions(conn, &from, Some(&to), device_id, now_ms)?;
    }
    Ok(())
}

/// The live notes and journal days carrying `old` or a child of it, by id: in the record's
/// tags, the body's `#tags`, or the header tags the index last read from the file (`headers`,
/// by note id), the only place a file the open adopted carries them (#3825).
pub fn holders(
    conn: &Connection,
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
    old: &str,
) -> Result<Vec<Holder>, StorageError> {
    let under = |tag: &str| renamed_tag(tag, old, old).is_some();
    let mut ids: BTreeSet<String> = carriers(conn, None)?
        .into_iter()
        .chain(body_tags::carriers(conn)?)
        .filter(|(item_type, _, tag)| item_type != "task" && under(tag))
        .map(|(_, id, _)| id)
        .collect();
    ids.extend(
        headers
            .into_iter()
            .filter(|(_, tags)| tags.iter().any(|tag| under(tag)))
            .map(|(id, _)| id),
    );
    let mut statement = conn
        .prepare(
            "SELECT item_type FROM sync_items WHERE item_id = ?1 AND deleted_at IS NULL
                AND item_type IN ('note', 'journal')",
        )
        .map_err(failed)?;
    let mut out = Vec::new();
    for id in ids {
        let item_type: Option<String> = statement
            .query_row([&id], |row| row.get(0))
            .optional()
            .map_err(failed)?;
        if let Some(item_type) = item_type {
            let day = item_type == "journal";
            out.push(Holder { id, day });
        }
    }
    Ok(out)
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
    fn rename_refreshes_cached_body_tags_without_reindex() {
        let (db, _d) = vault("tags-rename-body-cache");
        db.call_blocking(|c| {
            let to_storage = |e: crate::crdt::errors::CrdtError| StorageError::Failed {
                what: e.to_string(),
            };
            assert!(
                crate::domain::body_write::append_markdown(c, "n2", "Met #job.", "desk", NOW)
                    .map_err(to_storage)?
            );
            let blocks = crate::domain::reads::note_blocks(c, "n2")
                .map_err(to_storage)?
                .expect("body");
            body_tags::write(c, "n2", &body_tags::extract(&blocks))?;
            rename(c, "job", "career", "phone", NOW + 1)?;
            let cached: Vec<String> = c
                .prepare("SELECT tag FROM note_body_tags WHERE note_id = 'n2'")
                .map_err(failed)?
                .query_map([], |row| row.get(0))
                .map_err(failed)?
                .collect::<Result<_, _>>()
                .map_err(failed)?;
            assert_eq!(cached, vec!["career"]);
            Ok(())
        })
        .expect("cache");
    }

    fn upserts(db: &Db, id: &str) -> i64 {
        let id = id.to_owned();
        db.call_blocking(move |c| {
            c.query_row(
                "SELECT COUNT(*) FROM outbox WHERE op = 'upsert' AND item_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("outbox")
    }

    /// Desktop's parts: the shared one leaves notes and days to their files, an item's rename
    /// carries its pins in the list's spelling with one outbox row, and a second run of either
    /// writes nothing.
    #[test]
    fn the_desktop_parts_rename_once_and_leave_notes_to_their_files() {
        let (db, _d) = vault("tags-rename-parts");
        seed(
            &db,
            "note",
            "n4",
            r#"{"title":"n4","tags":["job","Career"],"pinnedTags":["job"],"clock":{"desk":1}}"#,
        );
        db.call_blocking(|c| {
            rename_shared(c, "job", "career", "phone", NOW + 1)?;
            rename_shared(c, "job", "career", "phone", NOW + 2)
        })
        .expect("shared");
        assert_eq!(tags_of(&db, "task", "t1"), vec!["career/Lead"]);
        assert_eq!(tags_of(&db, "note", "n1"), vec!["Job", "job/Lead", "ideas"]);
        assert_eq!(upserts(&db, "t1"), 1);
        db.call_blocking(|c| {
            assert!(live_definition(c, "job")?.is_none());
            assert!(live_definition(c, "career")?.is_some());
            Ok(())
        })
        .expect("defs");

        let renamed = db
            .call_blocking(|c| {
                let first = tags::rename(c, "n4", "job", "career", "phone", NOW + 3)?;
                let again = tags::rename(c, "n4", "job", "career", "phone", NOW + 4)?;
                let gone = tags::rename(c, "none", "job", "career", "phone", NOW + 4)?;
                Ok((first, again, gone))
            })
            .expect("item");
        assert_eq!(renamed, (true, false, false));
        assert_eq!(tags_of(&db, "note", "n4"), vec!["career"]);
        assert_eq!(upserts(&db, "n4"), 1);
        let pins: String = db
            .call_blocking(|c| {
                c.query_row(
                    "SELECT json_extract(payload, '$.pinnedTags') FROM sync_items \
                     WHERE item_id = 'n4'",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)
            })
            .expect("pins");
        assert_eq!(pins, r#"["career"]"#);
    }

    #[test]
    fn holders_are_the_live_notes_and_days_that_carry_the_tag_or_a_child() {
        let (db, _d) = vault("tags-rename-holders");
        let headers = [
            ("n2".to_owned(), vec!["JOB/x".to_owned()]),
            ("gone".to_owned(), vec!["job".to_owned()]),
        ];
        let holders = db
            .call_blocking(move |c| holders(c, headers, "Job"))
            .expect("holders");
        let note = |id: &str| Holder {
            id: id.into(),
            day: false,
        };
        let day = Holder {
            id: "j1".into(),
            day: true,
        };
        assert_eq!(holders, vec![day, note("n1"), note("n2")]);
    }

    #[test]
    fn a_recorded_rename_refuses_another_until_it_is_finished() {
        let (db, _d) = vault("tags-rename-job");
        let job = |from: &str, run: &str| RenameJob {
            from: from.into(),
            to: "career".into(),
            run_id: run.into(),
        };
        db.call_blocking(move |c| {
            assert_eq!(begin(c, &job("job", "r1"))?, None);
            assert_eq!(begin(c, &job("job", "r2"))?, None);
            assert_eq!(recorded(c)?, Some(job("job", "r2")));
            assert_eq!(begin(c, &job("work", "r3"))?, Some(job("job", "r2")));
            finish(c)?;
            assert_eq!(recorded(c)?, None);
            c.execute("INSERT INTO meta (key, value) VALUES (?1, 'x')", [JOB])
                .map_err(failed)?;
            assert!(recorded(c).is_err());
            Ok(())
        })
        .expect("job");
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
