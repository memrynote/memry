//! The file's values reaching the record against its baseline ([`super::super::file`]).

use super::*;

const PULLED: &str = concat!(
    r#"{"title":"t","properties":{"stage":"Done","effort":3},"#,
    r#""clock":{"device-a":2}}"#,
);

/// The record holds a pulled `stage` the file does not hold yet; the file's `Draft` is older.
#[test]
fn a_file_takes_what_it_changed_since_the_baseline_and_fills_without_one() {
    let (db, _dir) = open("props-taken", PULLED);
    db.call_blocking(|conn| {
        // Found: no baseline, no reading; the record keeps every key it holds.
        let file = object(json!({ "stage": "Draft", "effort": 3, "owner": "Kaan" }));
        assert!(taken(conn, "note-1", None, file, DEVICE, NOW + 1)?);
        let want = json!({ "stage": "Done", "effort": 3, "owner": "Kaan" });
        assert_eq!(pushed(conn)["properties"], want);
        // Edited outside: what it changed since the baseline, and no other key.
        let file = object(json!({ "stage": "Draft", "effort": 4, "owner": "Kaan" }));
        assert!(taken(conn, "note-1", None, file, DEVICE, NOW + 2)?);
        assert_eq!(pushed(conn)["properties"]["stage"], json!("Done"));
        assert_eq!(pushed(conn)["properties"]["effort"], json!(4));
        // An app edit moves the baseline, so a pull of the key after it is not reverted.
        let before = object(json!({ "stage": "Draft", "effort": 4, "owner": "Kaan" }));
        let after = object(json!({ "stage": "Draft", "effort": 4, "owner": "Ada" }));
        assert!(mirror_file(
            conn,
            "note-1",
            &before,
            after,
            DEVICE,
            NOW + 3
        )?);
        set(
            conn,
            "note",
            "note-1",
            "owner",
            json!("Bo"),
            DEVICE,
            NOW + 4,
        )
        .expect("pulled");
        let file = object(json!({ "stage": "Draft", "effort": 4, "owner": "Ada", "x": 1 }));
        assert!(taken(conn, "note-1", None, file, DEVICE, NOW + 5)?);
        let want = json!({ "stage": "Done", "effort": 4, "owner": "Bo", "x": 1 });
        assert_eq!(pushed(conn)["properties"], want);
        assert!(!taken(conn, "nobody", None, Map::new(), DEVICE, NOW + 6)?);
        // The row goes, and the baseline with it.
        let baselines = |conn: &Connection| -> i64 {
            let sql = "SELECT COUNT(*) FROM meta WHERE key LIKE 'note.file_properties:%'";
            conn.query_row(sql, [], |row| row.get(0)).expect("meta")
        };
        assert_eq!(baselines(conn), 1);
        crate::domain::note_files::remove(conn, "note-1")?;
        assert_eq!(baselines(conn), 0);
        Ok(())
    })
    .expect("taken");
}

/// An app edit leaves its file's values as the baseline, so a note made in the app has one.
#[test]
fn an_app_edit_gives_a_file_with_none_its_baseline() {
    let (db, _dir) = open("props-app-baseline", PULLED);
    db.call_blocking(|conn| {
        let before = object(json!({ "stage": "Draft", "effort": 3 }));
        let after = object(json!({ "stage": "Draft", "effort": 4 }));
        assert!(mirror_file(
            conn,
            "note-1",
            &before,
            after,
            DEVICE,
            NOW + 1
        )?);
        // Edited outside before anything read the file again: the pulled `stage` stays.
        let file = object(json!({ "stage": "Draft", "effort": 5, "owner": "Kaan" }));
        assert!(taken(conn, "note-1", None, file, DEVICE, NOW + 2)?);
        let want = json!({ "stage": "Done", "effort": 5, "owner": "Kaan" });
        assert_eq!(pushed(conn)["properties"], want);
        Ok(())
    })
    .expect("mirror");
}

/// Without a baseline, the index's reading of the replaced file stands in.
#[test]
fn a_file_with_no_baseline_is_measured_against_the_index_reading() {
    let (db, _dir) = open("props-taken-indexed", PULLED);
    db.call_blocking(|conn| {
        let indexed = object(json!({ "stage": "Draft", "effort": 3 }));
        let file = object(json!({ "stage": "Draft", "effort": 5 }));
        assert!(taken(conn, "note-1", Some(indexed), file, DEVICE, NOW + 1)?);
        assert_eq!(
            pushed(conn)["properties"],
            json!({ "stage": "Done", "effort": 5 })
        );
        Ok(())
    })
    .expect("taken");
}

#[test]
fn a_day_takes_none_of_the_reserved_journal_keys() {
    let (db, _dir) = open("props-taken-day", NOTE);
    seed(
        &db,
        "journal",
        "day-1",
        r#"{"date":"2026-10-07","properties":{"created":"kept"},"clock":{"device-a":1}}"#,
    );
    db.call_blocking(|conn| {
        let file = object(json!({
            "id": "j2026-10-07", "date": "2026-10-07", "created": "now", "modified": "now",
            "emoji": "x", "mood": 2
        }));
        assert!(taken(conn, "day-1", None, file, DEVICE, NOW + 1)?);
        let want = json!({ "created": "kept", "mood": 2 });
        assert_eq!(values(conn, "journal", "day-1")?, object(want));
        Ok(())
    })
    .expect("taken");
}
