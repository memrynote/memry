use super::*;
use crate::storage::repositories::InboundRecord;
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
    seed(
        &db,
        "note",
        "n1",
        r#"{"title":"a","tags":["Job","ideas"],"clock":{"desk":1}}"#,
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
        "tag_definition",
        "job",
        r##"{"name":"job","color":"#ff0000","icon":"💼","clock":{"desk":1}}"##,
    );
    (db, dir)
}

fn tags_of(db: &Db, item_type: &str, id: &str) -> Vec<String> {
    db.call_blocking(|conn| current_tags(conn, item_type, id))
        .expect("tags")
}

#[test]
fn the_default_colour_matches_the_contract_hash() {
    // tag-colors.ts: defaultTagColorName('work') and ('ideas').
    assert!(PALETTE.contains(&default_color("work")));
    assert_eq!(default_color("Work"), default_color("work"));
    // Literals pinned against tag-colors.test.ts: the hash runs over the fold.
    assert_eq!(default_color("Work"), "coral");
    assert_eq!(default_color("İş"), "emerald");
    assert_eq!(default_color("iş"), "emerald");
    assert_eq!(default_color("ΟΔΟΣ"), "cyan");
    assert_eq!(default_color("οδοσ"), "cyan");
}

#[test]
fn list_counts_every_carrier_case_insensitively_and_reads_definitions() {
    let (db, _d) = vault("tags-list");
    let listed = db.call_blocking(|c| list(c)).expect("list");
    let job = listed
        .iter()
        .find(|t| tags::same_tag(&t.name, "job"))
        .expect("job");
    assert_eq!((job.notes, job.journals, job.tasks), (2, 1, 0));
    assert_eq!(job.color.as_deref(), Some("#ff0000"));
}

#[test]
fn merge_into_an_existing_tag_dedupes_and_counts_items() {
    let (db, _d) = vault("tags-merge");
    let count = db
        .call_blocking(|c| merge(c, "job", "Work", "phone", NOW + 1))
        .expect("merge");
    assert_eq!(count, 3);
    // n2 had both: one `work`, spelled as it already was.
    assert_eq!(tags_of(&db, "note", "n2"), vec!["work"]);
    assert_eq!(tags_of(&db, "note", "n1"), vec!["Work", "ideas"]);
    db.call_blocking(|c| {
        assert!(live_definition(c, "job")?.is_none());
        assert!(live_definition(c, "work")?.is_some());
        Ok(())
    })
    .expect("defs");
    assert!(
        db.call_blocking(|c| merge(c, "work", "WORK", "phone", NOW + 2))
            .is_err()
    );
}

#[test]
fn delete_removes_it_everywhere_and_colour_icon_create_a_definition() {
    let (db, _d) = vault("tags-delete");
    let count = db
        .call_blocking(|c| delete(c, "JOB", "phone", NOW + 1))
        .expect("delete");
    assert_eq!(count, 3);
    assert_eq!(tags_of(&db, "note", "n2"), vec!["work"]);
    db.call_blocking(|c| {
        set_color(c, "ideas", "sage", "phone", NOW + 2)?;
        set_icon(c, "ideas", Some("💡"), "phone", NOW + 3)?;
        let def = live_definition(c, "ideas")?.expect("ideas");
        assert_eq!(def["color"], json!("sage"));
        assert_eq!(def["colorAuthored"], json!(true));
        assert_eq!(def["icon"], json!("💡"));
        set_icon(c, "ideas", None, "phone", NOW + 4)?;
        assert_eq!(
            live_definition(c, "ideas")?.expect("ideas")["icon"],
            Value::Null
        );
        Ok(())
    })
    .expect("defs");
}

#[test]
fn unicode_variants_count_as_one_tag_and_their_definitions_converge() {
    let dir = temp_dir("tags-unicode-defs");
    let db = open_data(&dir.path().join("data.db")).expect("open");
    seed(
        &db,
        "note",
        "n1",
        r#"{"title":"a","tags":["Ünal","İş"],"clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "note",
        "n2",
        r#"{"title":"b","tags":["ünal","iş"],"clock":{"desk":1}}"#,
    );
    // An older desktop keyed `İş` by `toLowerCase`, a newer one by the fold.
    // The higher schema `t` survives; on a tie the older `createdAt` does.
    seed(
        &db,
        "tag_definition",
        "i\u{0307}ş",
        r#"{"name":"i̇ş","color":"rose","schema":{"t":2},"createdAt":"2026-01-02T00:00:00.000Z","clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "tag_definition",
        "iş",
        r#"{"name":"iş","color":"teal","schema":{"t":1},"createdAt":"2026-01-01T00:00:00.000Z","clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "tag_definition",
        "ünal",
        r#"{"name":"ünal","color":"sage","createdAt":"2026-01-02T00:00:00.000Z","clock":{"desk":1}}"#,
    );
    seed(
        &db,
        "tag_definition",
        "Ünal",
        r#"{"name":"Ünal","color":"plum","createdAt":"2026-01-01T00:00:00.000Z","clock":{"desk":1}}"#,
    );

    let listed = db.call_blocking(|c| list(c)).expect("list");
    assert_eq!(listed.len(), 2, "{listed:?}");
    let is = listed
        .iter()
        .find(|t| tags::same_tag(&t.name, "İş"))
        .expect("iş");
    assert_eq!((is.notes, is.color.as_deref()), (2, Some("rose")));
    let unal = listed
        .iter()
        .find(|t| tags::same_tag(&t.name, "ünal"))
        .expect("ünal");
    assert_eq!((unal.notes, unal.color.as_deref()), (2, Some("plum")));

    db.call_blocking(|c| {
        set_color(c, "İŞ", "amber", "phone", NOW + 1)?;
        assert_eq!(
            live_definition(c, "i\u{0307}ş")?.expect("survivor")["color"],
            json!("amber")
        );
        assert_eq!(
            live_definition(c, "iş")?.expect("loser")["color"],
            json!("teal")
        );
        assert_eq!(delete(c, "ÜNAL", "phone", NOW + 2)?, 2);
        assert!(live_definition(c, "ünal")?.is_none());
        assert!(live_definition(c, "Ünal")?.is_none());
        Ok(())
    })
    .expect("converge");
    assert_eq!(tags_of(&db, "note", "n1"), vec!["İş"]);
}
