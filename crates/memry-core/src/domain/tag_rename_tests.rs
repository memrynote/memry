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
            crate::domain::body_write::append_markdown(c, "n2", markdown, "desk", NOW).map_err(
                |e| StorageError::Failed {
                    what: e.to_string()
                }
            )?
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

/// Electron keeps a locked note's tags (`keepLockedNoteTags`, Step 14e-2): its
/// body is never written by a rename.
#[cfg(feature = "markdown")]
#[test]
fn rename_leaves_a_locked_notes_body_alone() {
    let (db, _d) = vault("tags-rename-body-locked");
    db.call_blocking(|c| {
        crate::domain::body_write::append_markdown(c, "n2", "Met #job.", "desk", NOW).map_err(
            |e| StorageError::Failed {
                what: e.to_string(),
            },
        )?;
        let logged = || -> Result<i64, StorageError> {
            c.query_row(
                "SELECT COUNT(*) FROM yjs_updates WHERE doc_id = 'n2'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        };
        let before = logged()?;
        crate::domain::vault_locks::set(
            c,
            crate::domain::vault_locks::TargetKind::Note,
            "n2",
            true,
            NOW,
        )?;
        rename(c, "job", "career", "phone", NOW + 1)?;
        let blocks = crate::domain::reads::note_blocks(c, "n2")
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?
            .expect("body");
        assert_eq!(body_tags::extract(&blocks), vec!["job"]);
        assert_eq!(logged()?, before, "no update row");
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

fn job(from: &str, to: &str) -> RenameJob {
    RenameJob {
        from: from.into(),
        to: to.into(),
        run_id: "run".into(),
    }
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
        begin(c, &job("job", "career"), Vec::new())?;
        rename_shared(c, "phone", NOW + 1)?;
        rename_shared(c, "phone", NOW + 2)
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
    // A day's header is its author's text: `j2` carries `job` there only.
    seed(
        &db,
        "journal",
        "j2",
        r#"{"date":"2026-09-25","tags":["ideas"],"clock":{"desk":1}}"#,
    );
    let headers = [
        ("n2".to_owned(), vec!["JOB/x".to_owned()]),
        ("gone".to_owned(), vec!["job".to_owned()]),
        ("j2".to_owned(), vec!["job".to_owned()]),
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
        assert_eq!(begin(c, &job("job", "r1"), Vec::new())?, None);
        assert_eq!(begin(c, &job("job", "r2"), Vec::new())?, None);
        assert_eq!(recorded(c)?.map(|plan| plan.job), Some(job("job", "r2")));
        let other = begin(c, &job("work", "r3"), Vec::new())?;
        assert_eq!(other, Some(job("job", "r2")));
        finish(c)?;
        assert_eq!(recorded(c)?, None);
        c.execute("INSERT INTO meta (key, value) VALUES (?1, 'x')", [JOB])
            .map_err(failed)?;
        assert!(recorded(c).is_err());
        // A row an earlier head of this branch wrote, with no plan, does not read either.
        let old = r#"{"from":"job","to":"career","runId":"r1"}"#;
        c.execute("UPDATE meta SET value = ?2 WHERE key = ?1", [JOB, old])
            .map_err(failed)?;
        assert!(recorded(c).is_err());
        // Nor one with its holders inline (#3948's layout), whose holders this layout would
        // not see: read as nothing left, it would be finished with its notes unrenamed.
        let inline = r#"{"from":"job","to":"career","runId":"r1","pairs":[],"holders":[]}"#;
        c.execute("UPDATE meta SET value = ?2 WHERE key = ?1", [JOB, inline])
            .map_err(failed)?;
        assert!(matches!(read(c)?, Some(Recorded::Unreadable(_))));
        finish(c)?;
        assert_eq!(read(c)?, None);
        Ok(())
    })
    .expect("job");
}

#[test]
fn rename_to_a_name_not_writable_inline_keeps_body_tags() {
    let (db, _d) = vault("tags-rename-body-skip");
    db.call_blocking(|c| {
        assert!(
            crate::domain::body_write::append_markdown(c, "n2", "Met #job.", "desk", NOW).map_err(
                |e| StorageError::Failed {
                    what: e.to_string()
                }
            )?
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

/// A new name under the old one (`a` to `a/b`) renames each item once, however often the
/// rename runs: one stopped after part of it and resumed, its shared part stopped before a pair
/// was struck off, and the parts run again over every item it listed, never make `a/b/b` of
/// what became `a/b`. An `a/b` the vault held before is renamed as a child, once.
#[test]
fn a_rename_under_the_old_name_lands_once_however_often_it_runs() {
    let (db, _d) = vault("tags-rename-under");
    let seeds = [
        ("note", "n5", r#"["a"]"#),
        ("note", "n6", r#"["a/b"]"#),
        ("task", "t5", r#"["a"]"#),
    ];
    for (item_type, id, tags) in seeds {
        let payload = format!(r#"{{"title":"{id}","tags":{tags},"clock":{{"desk":1}}}}"#);
        seed(&db, item_type, id, &payload);
    }
    let listed = db
        .call_blocking(|c| {
            let listed = holders(c, Vec::new(), "a")?;
            assert_eq!(begin(c, &job("a", "a/b"), listed.clone())?, None);
            let plan = recorded(c)?.expect("plan");
            rename_shared(c, "phone", NOW + 1)?;
            // Stopped after the last pair ran and before it was struck off.
            let last = plan.pairs.last().cloned().expect("a pair");
            let mut stopped = stored(c)?.expect("job");
            stopped.pairs = vec![last];
            save(c, &stopped)?;
            assert!(rename_holder(c, "n5", "phone", NOW + 2)?);
            Ok(listed)
        })
        .expect("first part");
    let ids: Vec<&str> = listed.iter().map(|holder| holder.id.as_str()).collect();
    assert_eq!(ids, ["n5", "n6"]);

    db.call_blocking(move |c| {
        // The next open: what is left, then every part again over all it listed.
        rename_shared(c, "phone", NOW + 3)?;
        for holder in recorded(c)?.expect("plan").holders {
            assert!(rename_holder(c, &holder.id, "phone", NOW + 4)?);
        }
        rename_shared(c, "phone", NOW + 5)?;
        for holder in &listed {
            assert!(!rename_holder(c, &holder.id, "phone", NOW + 6)?);
        }
        finish(c)
    })
    .expect("resume");
    assert_eq!(tags_of(&db, "note", "n5"), vec!["a/b"]);
    assert_eq!(tags_of(&db, "note", "n6"), vec!["a/b/b"]);
    assert_eq!(tags_of(&db, "task", "t5"), vec!["a/b"]);
    assert_eq!(upserts(&db, "n5"), 1);
}

/// A file edit begun and not written is forgotten for that holder only, which stays listed; a
/// holder no longer listed records none.
#[test]
fn an_unwritten_file_edit_is_forgotten_and_its_holder_stays_listed() {
    let (db, _d) = vault("tags-rename-unstart");
    db.call_blocking(|c| {
        let listed = holders(c, Vec::new(), "job")?;
        begin(c, &job("job", "career"), listed.clone())?;
        start_holder(c, "n1", "b", "a")?;
        unstart_holder(c, "n2")?;
        let begun = started(c, "n1")?.expect("started");
        let snapshot: Vec<&str> = begun.tags.iter().map(String::as_str).collect();
        assert_eq!(
            (begun.before.as_str(), begun.after.as_str(), snapshot),
            ("b", "a", vec!["Job", "job/Lead", "ideas"])
        );
        unstart_holder(c, "n1")?;
        assert_eq!(started(c, "n1")?, None);
        assert_eq!(recorded(c)?.expect("plan").holders, listed);

        assert!(rename_holder(c, "n1", "phone", NOW + 1)?);
        start_holder(c, "n1", "b", "a")?;
        assert_eq!(started(c, "n1")?, None, "n1 is no longer listed");
        Ok(())
    })
    .expect("unstart");
}

/// With its file edit begun, a holder's record takes what the rename made of its lists then,
/// with what an edit changed since: untouched, it is renamed; carried the new name by its
/// renamed header (a note), it is unchanged; changed in the old name's terms (a day's header,
/// which keeps the old name), it is renamed and keeps the change, a tag added or removed.
#[test]
fn a_begun_holders_record_keeps_what_an_edit_changed_since_the_edit_began() {
    let (db, _d) = vault("tags-rename-begun");
    let ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    for id in ids {
        let payload = format!(r#"{{"title":"{id}","tags":["a","x"],"clock":{{"desk":1}}}}"#);
        seed(&db, "note", id, &payload);
    }
    db.call_blocking(|c| {
        let listed = holders(c, Vec::new(), "a")?;
        begin(c, &job("a", "a/b"), listed)?;
        for id in ids {
            start_holder(c, id, "b", "a")?;
        }
        let set = |c: &Connection, id: &str, list: &[&str]| {
            let list: Vec<String> = list.iter().map(|tag| (*tag).to_owned()).collect();
            tags::set(c, "note", id, &list, "desk", NOW + 1).map(|_| ())
        };
        set(c, "s2", &["a/b", "x"])?;
        set(c, "s3", &["a/b", "x", "y"])?;
        set(c, "s4", &["a", "x", "y"])?;
        set(c, "s5", &["a"])?;
        // Pinned since: the pin follows its tag to the new name.
        tags::set_pinned(c, "s6", "a", true, "desk", NOW + 1)?;
        let renamed: Vec<bool> = ids
            .iter()
            .map(|id| rename_holder(c, id, "phone", NOW + 2))
            .collect::<Result<_, _>>()?;
        assert_eq!(renamed, [true, false, false, true, true, true]);
        let pins = tags::lists(c, "s6")?.expect("live").1;
        assert_eq!(pins, Some(vec!["a/b".to_owned()]));
        assert!(
            recorded(c)?
                .expect("plan")
                .holders
                .iter()
                .all(|h| !ids.contains(&h.id.as_str()))
        );
        for id in ids {
            assert_eq!(started(c, id)?, None);
        }
        Ok(())
    })
    .expect("begun");
    assert_eq!(tags_of(&db, "note", "s1"), ["a/b", "x"]);
    assert_eq!(tags_of(&db, "note", "s3"), ["a/b", "x", "y"]);
    assert_eq!(tags_of(&db, "note", "s4"), ["a/b", "x", "y"]);
    assert_eq!(tags_of(&db, "note", "s5"), ["a/b"]);
}

/// A merge into a name the holder holds (`a` to `b` of `[a, b]`), its file edit begun and its
/// record changed since (`a` gone with the renamed header, `x` added): the record keeps `b`,
/// which a still-held tag stands for, and the added tag.
#[test]
fn a_begun_holder_merged_into_a_name_it_holds_keeps_that_name() {
    let (db, _d) = vault("tags-rename-begun-merge");
    for id in ["m1", "m2"] {
        let payload = format!(r#"{{"title":"{id}","tags":["a","b"],"clock":{{"desk":1}}}}"#);
        seed(&db, "note", id, &payload);
    }
    db.call_blocking(|c| {
        let listed = holders(c, Vec::new(), "a")?;
        begin(c, &job("a", "b"), listed)?;
        for id in ["m1", "m2"] {
            start_holder(c, id, "b", "a")?;
        }
        let list = vec!["b".to_owned(), "x".to_owned()];
        tags::set(c, "note", "m1", &list, "desk", NOW + 1)?;
        assert!(!rename_holder(c, "m1", "phone", NOW + 2)?);
        assert!(rename_holder(c, "m2", "phone", NOW + 2)?);
        Ok(())
    })
    .expect("merge");
    assert_eq!(tags_of(&db, "note", "m1"), ["b", "x"]);
    assert_eq!(tags_of(&db, "note", "m2"), ["b"]);
}
