use super::*;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::{open_data, test_support::temp_dir};

const NOW: i64 = 1_760_000_000_000;

fn stage(options: &str) -> DefinitionRecord {
    DefinitionRecord {
        name: "Stage".into(),
        type_name: "select".into(),
        options: Some(options.into()),
        default_value: None,
        color: None,
    }
}

/// A peer's edit of `Stage`, applied as the pull stores it.
fn pull(conn: &Connection, options: &str, deleted_at: Option<i64>) {
    let record = InboundRecord {
        item_type: ITEM_TYPE.into(),
        item_id: "Stage".into(),
        payload_json: json!({ "name": "Stage", "type": "select", "options": options }).to_string(),
        server_cursor: None,
        signer_device_id: Some("peer".into()),
        updated_at: NOW,
        deleted_at,
    };
    sync_items::apply_remote(conn, &record, NOW).unwrap();
}

#[test]
fn a_record_the_file_has_not_taken_is_pulled_until_it_is() {
    let dir = temp_dir("props-mirror");
    let db = open_data(&dir.path().join("data.db")).unwrap();
    db.call_blocking(|c| {
        // Written here apart from the file: the file wins, until the file takes it.
        put(c, &stage(r#"[{"value":"A","color":"sky"}]"#), "me", NOW)?;
        let first = snapshot(c)?;
        let pulled = first.pulled();
        assert_eq!(pulled.len(), 1);
        assert!(pulled[0].file_wins);
        take(c, &first)?;
        assert!(snapshot(c)?.pulled().is_empty());

        // The same options in another spelling are no change.
        pull(c, r#"[ {"color":"sky","value":"A"} ]"#, None);
        assert!(snapshot(c)?.pulled().is_empty());

        // A peer's change is pulled, and seen.
        pull(
            c,
            r#"[{"value":"A","color":"sky"},{"value":"Done","color":"green"}]"#,
            None,
        );
        let pulled = snapshot(c)?.pulled();
        assert_eq!(pulled.len(), 1);
        assert!(!pulled[0].file_wins);
        assert_eq!(
            pulled[0].record.as_ref().and_then(|r| r.options.as_deref()),
            Some(r#"[{"value":"A","color":"sky"},{"value":"Done","color":"green"}]"#)
        );

        // A peer's delete is pulled with no record.
        let before = snapshot(c)?;
        take(c, &before)?;
        pull(c, "[]", Some(NOW));
        let pulled = snapshot(c)?.pulled();
        assert_eq!(pulled.len(), 1);
        assert_eq!(pulled[0].record, None);
        Ok(())
    })
    .unwrap();
}

#[test]
fn a_write_over_a_record_that_moved_writes_nothing() {
    let dir = temp_dir("props-mirror-moved");
    let db = open_data(&dir.path().join("data.db")).unwrap();
    db.call_blocking(|c| {
        let ours = Edit::Put(stage(r#"[{"value":"A","color":"rose"}]"#));
        let empty = snapshot(c)?;
        assert_eq!(write(c, &empty, "Stage", &ours, "me", NOW)?, Written::Done);
        let read = snapshot(c)?;
        assert!(
            read.pulled().is_empty(),
            "a write records what the file holds"
        );

        pull(c, r#"[{"value":"Done","color":"green"}]"#, None);
        let edit = Edit::Put(stage(r#"[{"value":"B","color":"rose"}]"#));
        assert_eq!(
            write(c, &read, "Stage", &edit, "me", NOW + 1)?,
            Written::Moved
        );
        let pulled = snapshot(c)?.pulled();
        assert_eq!(
            pulled[0].record.as_ref().and_then(|r| r.options.as_deref()),
            Some(r#"[{"value":"Done","color":"green"}]"#),
            "the pulled record is kept"
        );

        // A remove is recorded as the file's `null`.
        let read = snapshot(c)?;
        assert_eq!(
            write(c, &read, "Stage", &Edit::Remove, "me", NOW + 2)?,
            Written::Done
        );
        assert!(snapshot(c)?.pulled().is_empty());
        Ok(())
    })
    .unwrap();
}

/// #4099: a record or a delete the pull stored wins over a file that never took the name, though a
/// `/sync/pull` item carries no `serverCursor`. Only a live record written here lets the file win.
#[test]
fn a_pull_the_file_never_took_wins_and_only_a_record_written_here_lets_the_file_win() {
    let dir = temp_dir("props-mirror-first");
    let db = open_data(&dir.path().join("data.db")).unwrap();
    db.call_blocking(|c| {
        pull(c, r#"[{"value":"A","color":"sky"}]"#, None);
        let pulled = snapshot(c)?.pulled();
        assert_eq!(pulled.len(), 1);
        assert!(!pulled[0].file_wins, "a pulled record");

        crate::sync::store::mark_deleted(c, ITEM_TYPE, "Gone", NOW, None, NOW)?;
        let pulled = snapshot(c)?.pulled();
        let gone = pulled.iter().find(|p| p.name == "Gone").unwrap();
        assert_eq!(gone.record, None);
        assert!(!gone.file_wins, "a pulled delete of a name never held here");

        let mut mine = stage("[]");
        mine.name = "Mine".into();
        put(c, &mine, "me", NOW)?;
        let pulled = snapshot(c)?.pulled();
        let mine = pulled.iter().find(|p| p.name == "Mine").unwrap();
        assert!(mine.file_wins, "a record written here");
        Ok(())
    })
    .unwrap();
}
