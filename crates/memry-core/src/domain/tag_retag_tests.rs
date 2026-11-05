use super::*;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{current_tags, definitions};
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

/// `n1` pins `Job` beside its child; `n2` holds the target already; `j1` is a day; `t1` a task.
fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open");
    seed(
        &db,
        "note",
        "n1",
        r#"{"title":"a","tags":["Job","job/lead","ideas"],"pinnedTags":["Job"],"clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "note",
        "n2",
        r#"{"title":"b","tags":["work","JOB"],"clock":{"desk":1}}"#,
    );
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
        r#"{"title":"t","tags":["job","job/lead"],"clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "tag_definition",
        "job",
        r##"{"name":"job","color":"#ff0000","clock":{"desk":1}}"##,
    );
    (db, dir)
}

fn tags_of(db: &Db, item_type: &str, id: &str) -> Vec<String> {
    db.call_blocking(|conn| current_tags(conn, item_type, id))
        .expect("tags")
}

fn pins_of(db: &Db, id: &str) -> Option<Vec<String>> {
    db.call_blocking(|conn| tags::lists(conn, id))
        .expect("lists")
        .expect("live")
        .1
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

/// One note at a time: the tag itself moves, its child stays, a pin follows it, a target the
/// note holds keeps its spelling, and a second run writes nothing.
#[test]
fn a_retag_moves_the_tag_itself_with_its_pin_once() {
    let (db, _d) = vault("tags-retag-merge");
    let wrote = db
        .call_blocking(|c| {
            Ok([
                retag(c, "n1", "job", Some("Work"), "phone", NOW + 1)?,
                retag(c, "n2", "job", Some("Work"), "phone", NOW + 1)?,
                retag(c, "n1", "job", Some("Work"), "phone", NOW + 2)?,
            ])
        })
        .expect("retag");
    assert_eq!(wrote, [true, true, false]);
    assert_eq!(tags_of(&db, "note", "n1"), ["Work", "job/lead", "ideas"]);
    assert_eq!(pins_of(&db, "n1"), Some(vec!["Work".to_owned()]));
    assert_eq!(tags_of(&db, "note", "n2"), ["work"]);
    assert_eq!(pins_of(&db, "n2"), None, "no pins key is added");
    assert_eq!(upserts(&db, "n1"), 1);
}

/// A delete, one note or day at a time, takes the tag and its pin, never its child.
#[test]
fn a_retag_with_no_target_drops_the_tag_and_its_pin() {
    let (db, _d) = vault("tags-retag-delete");
    db.call_blocking(|c| {
        retag(c, "n1", "JOB", None, "phone", NOW + 1)?;
        retag(c, "j1", "JOB", None, "phone", NOW + 1)
    })
    .expect("retag");
    assert_eq!(tags_of(&db, "note", "n1"), ["job/lead", "ideas"]);
    assert_eq!(pins_of(&db, "n1"), Some(Vec::new()));
    assert!(tags_of(&db, "journal", "j1").is_empty());
}

/// The holders are the notes and days carrying the tag itself in the record, and the notes
/// whose file header does: not a child, and not a day's header (#3931).
#[test]
fn holders_are_the_notes_and_days_that_carry_the_tag_itself() {
    let (db, _d) = vault("tags-retag-holders");
    seed(
        &db,
        "note",
        "n3",
        r#"{"title":"c","tags":["job/x"],"clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "journal",
        "j2",
        r#"{"date":"2026-09-25","tags":[],"clock":{"desk":1}}"#,
    );
    let headers = [
        ("n3".to_owned(), vec!["ideas".to_owned()]),
        ("n4".to_owned(), vec!["Job".to_owned()]),
        ("j2".to_owned(), vec!["job".to_owned()]),
    ];
    seed(
        &db,
        "note",
        "n4",
        r#"{"title":"d","tags":[],"clock":{"desk":1}}"#,
    );
    let held = db
        .call_blocking(move |c| holders_of(c, headers, "job"))
        .expect("holders");
    let ids: Vec<(&str, bool)> = held.iter().map(|h| (h.id.as_str(), h.day)).collect();
    assert_eq!(
        ids,
        [("j1", true), ("n1", false), ("n2", false), ("n4", false)]
    );
}

/// The shared part of a merge: the task retagged, the source's definition gone, the target's
/// made, the notes and days left to their files.
#[test]
fn a_merges_shared_part_leaves_the_notes_and_days() {
    let (db, _d) = vault("tags-retag-merge-shared");
    let tasks = db
        .call_blocking(|c| merge_shared(c, "job", "Work", "phone", NOW + 1))
        .expect("merge");
    assert_eq!(tasks, 1);
    assert_eq!(tags_of(&db, "task", "t1"), ["Work", "job/lead"]);
    assert_eq!(tags_of(&db, "note", "n1"), ["Job", "job/lead", "ideas"]);
    assert_eq!(tags_of(&db, "journal", "j1"), ["job"]);
    let names: Vec<String> = db
        .call_blocking(|c| definitions(c))
        .expect("definitions")
        .into_values()
        .map(|d| d.id)
        .collect();
    assert_eq!(names, ["Work"]);
    let refused = db.call_blocking(|c| merge_shared(c, "job", " JOB ", "phone", NOW + 2));
    assert!(
        matches!(refused, Err(StorageError::Invalid { .. })),
        "{refused:?}"
    );
}

/// The shared part of a delete: the task loses the tag, the definition goes, the notes and
/// days are left to their files.
#[test]
fn a_deletes_shared_part_leaves_the_notes_and_days() {
    let (db, _d) = vault("tags-retag-delete-shared");
    let tasks = db
        .call_blocking(|c| delete_shared(c, "JOB", "phone", NOW + 1))
        .expect("delete");
    assert_eq!(tasks, 1);
    assert_eq!(tags_of(&db, "task", "t1"), ["job/lead"]);
    assert_eq!(tags_of(&db, "note", "n2"), ["work", "JOB"]);
    assert!(
        db.call_blocking(|c| definitions(c))
            .expect("definitions")
            .is_empty()
    );
}
