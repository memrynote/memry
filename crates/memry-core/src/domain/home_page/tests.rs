//! `home_page` on a real `data.db` (Step 16, #3533): what a board write
//! queues, and Electron's apply rules (`home-page-handler.ts`) through the real
//! pull apply step.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{HomePagePatch, ITEM_TYPE, NewHomePage, create, delete, get, list, update};
use crate::api::errors::StorageError;
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, iso, open, payload, pull, queued, remote, remote_delete,
};
use crate::storage::repositories::projectors::home_pages::is_readable_cover;
use crate::storage::repositories::sync_items;
use crate::sync::clock::clock_of;

const ID: &str = "board-1";

fn board<'a>(name: &'a str, position: f64) -> NewHomePage<'a> {
    NewHomePage {
        name,
        icon: None,
        position,
        widgets: "[]",
        cover: None,
    }
}

fn cover_column(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT cover FROM home_pages WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("row")
}

fn updated_at(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT updated_at FROM home_pages WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("row")
}

/// A board this device made, with an icon and a cover, at clock
/// `{device-a: 1}`.
fn local_board(conn: &Connection) -> Result<String, StorageError> {
    let cover = json!({"ref": "unsplash:abc", "focus": 40});
    let made = create(
        conn,
        &NewHomePage {
            name: "Home",
            icon: Some("house"),
            position: 1.0,
            widgets: r#"[{"type":"inbox"}]"#,
            cover: Some(&cover),
        },
        DEVICE,
        NOW,
    )?;
    Ok(made.id)
}

#[test]
fn a_board_writes_the_eight_schema_keys_and_an_integer_position_as_an_integer() {
    let (db, _dir) = open("home-page-write");
    db.call_blocking(|conn| {
        let made = create(conn, &board("Home", 2.0), DEVICE, NOW)?;
        let created = iso(NOW);
        assert_eq!(
            payload(conn, ITEM_TYPE, &made.id),
            json!({
                "name": "Home", "icon": null, "position": 2, "widgets": "[]", "cover": null,
                "clock": {"device-a": 1}, "createdAt": created, "updatedAt": created,
            })
        );
        let raw = sync_items::push_payload(conn, ITEM_TYPE, &made.id)?.expect("a record");
        assert!(raw.contains(r#""position":2,"#), "{raw}");
        assert_eq!(queued(conn, ITEM_TYPE, &made.id), 1);

        let half = create(conn, &board("Half", 2.5), DEVICE, NOW)?;
        assert_eq!(payload(conn, ITEM_TYPE, &half.id)["position"], json!(2.5));
        Ok(())
    })
    .expect("write");
}

#[test]
fn a_board_without_a_name_or_with_widgets_that_are_not_an_array_is_refused() {
    let (db, _dir) = open("home-page-invalid");
    db.call_blocking(|conn| {
        assert!(create(conn, &board("", 0.0), DEVICE, NOW).is_err());
        let mut object = board("Home", 0.0);
        object.widgets = "{}";
        assert!(create(conn, &object, DEVICE, NOW).is_err());
        assert!(list(conn)?.is_empty());

        let made = create(conn, &board("Home", 0.0), DEVICE, NOW)?;
        let empty = HomePagePatch {
            name: Some(""),
            ..HomePagePatch::default()
        };
        assert!(update(conn, &made.id, &empty, DEVICE, NOW + 1).is_err());
        assert_eq!(
            queued(conn, ITEM_TYPE, &made.id),
            1,
            "a refusal queues nothing"
        );
        Ok(())
    })
    .expect("invalid");
}

#[test]
fn an_update_ticks_the_clock_and_clears_what_it_names() {
    let (db, _dir) = open("home-page-update");
    db.call_blocking(|conn| {
        let id = local_board(conn)?;
        let patch = HomePagePatch {
            icon: Some(None),
            cover: Some(None),
            position: Some(0.5),
            ..HomePagePatch::default()
        };
        let updated = update(conn, &id, &patch, DEVICE, NOW + 1)?;
        assert_eq!((updated.icon, updated.cover), (None, None));
        let stored = payload(conn, ITEM_TYPE, &id);
        assert_eq!(stored["name"], json!("Home"), "unnamed fields stay");
        assert_eq!(stored["widgets"], json!(r#"[{"type":"inbox"}]"#));
        assert_eq!(stored["icon"], Value::Null);
        assert_eq!(stored["position"], json!(0.5));
        assert_eq!(stored["updatedAt"], json!(iso(NOW + 1)));
        assert_eq!(stored["createdAt"], json!(iso(NOW)));
        assert_eq!(clock(conn, ITEM_TYPE, &id), clock_of([("device-a", 2)]));

        assert!(delete(conn, &id, DEVICE, NOW + 2)?);
        assert!(!delete(conn, &id, DEVICE, NOW + 3)?);
        assert!(get(conn, &id)?.is_none());
        assert!(update(conn, &id, &HomePagePatch::default(), DEVICE, NOW + 4).is_err());
        Ok(())
    })
    .expect("update");
}

#[test]
fn boards_list_by_position_then_created_at_then_id() {
    let (db, _dir) = open("home-page-list");
    db.call_blocking(|conn| {
        create(conn, &board("Late", 1.0), DEVICE, NOW + 1)?;
        create(conn, &board("Early", 1.0), DEVICE, NOW)?;
        create(conn, &board("First", 0.0), DEVICE, NOW + 2)?;
        let names: Vec<String> = list(conn)?.into_iter().map(|b| b.name).collect();
        assert_eq!(names, ["First", "Early", "Late"]);
        Ok(())
    })
    .expect("list");
}

#[test]
fn widgets_that_are_not_array_text_are_skipped_before_the_clock() {
    let (db, _dir) = open("home-page-remote-widgets");
    db.call_blocking(|conn| {
        let id = local_board(conn)?;
        let before = payload(conn, ITEM_TYPE, &id);
        for widgets in [json!("{}"), json!("not json"), Value::Null] {
            let body = json!({"widgets": widgets, "clock": {"device-a": 1, "peer": 1}});
            assert_eq!(pull(conn, vec![remote(ITEM_TYPE, &id, &body)])?.skipped, 1);
            assert_eq!(payload(conn, ITEM_TYPE, &id), before, "{body}");
        }
        // The same clock with readable widgets still wins.
        let body = json!({"widgets": "[]", "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, &id, &body)])?.applied, 1);
        assert_eq!(payload(conn, ITEM_TYPE, &id)["widgets"], json!("[]"));

        // Widgets that are not text at all are not a board this build reads.
        let body = json!({"name": "X", "widgets": 5, "clock": {"peer": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.corrupt, 1);
        Ok(())
    })
    .expect("widgets");
}

#[test]
fn a_remote_create_needs_a_name_and_keeps_every_key_it_carried() {
    let (db, _dir) = open("home-page-remote-create");
    db.call_blocking(|conn| {
        for body in [
            json!({"widgets": "[]", "clock": {"peer": 1}}),
            json!({"name": "", "clock": {"peer": 1}}),
            json!({"name": null, "clock": {"peer": 1}}),
        ] {
            assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.skipped, 1);
            assert!(sync_items::load(conn, ITEM_TYPE, ID)?.is_none(), "{body}");
        }
        let body = json!({
            "name": "Theirs", "icon": null, "position": 3, "widgets": "[]",
            "cover": {"ref": "", "focus": 500}, "clock": {"peer": 1},
            "createdAt": iso(NOW), "updatedAt": iso(NOW), "id": ID, "syncedAt": iso(NOW),
        });
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.applied, 1);
        assert_eq!(
            sync_items::push_payload(conn, ITEM_TYPE, ID)?,
            Some(body.to_string())
        );
        assert_eq!(
            cover_column(conn, ID),
            None,
            "an unreadable cover is absent"
        );
        assert_eq!(queued(conn, ITEM_TYPE, ID), 0);
        Ok(())
    })
    .expect("remote create");
}

#[test]
fn a_remote_update_keeps_what_it_leaves_out_and_clears_what_it_nulls() {
    let (db, _dir) = open("home-page-remote-update");
    db.call_blocking(|conn| {
        let id = local_board(conn)?;
        let local_cover = payload(conn, ITEM_TYPE, &id)["cover"].clone();

        // `name` and `position` null, the rest left out (a `null` widgets is
        // skipped as unreadable).
        let silent = json!({"name": null, "position": null,
                            "createdAt": iso(1), "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, &id, &silent)])?.applied,
            1
        );
        let stored = payload(conn, ITEM_TYPE, &id);
        assert_eq!(stored["name"], json!("Home"), "null name keeps");
        assert_eq!(stored["position"], json!(1), "null position keeps");
        assert_eq!(
            stored["widgets"],
            json!(r#"[{"type":"inbox"}]"#),
            "absent widgets keep"
        );
        assert_eq!(stored["icon"], json!("house"), "absent icon keeps");
        assert_eq!(stored["cover"], local_cover, "absent cover keeps");
        assert_eq!(
            stored["createdAt"],
            json!(iso(NOW)),
            "createdAt stays local"
        );
        assert_eq!(
            updated_at(conn, &id),
            NOW + 10,
            "absent updatedAt: apply time"
        );

        // An unreadable cover keeps the local one.
        let unreadable = json!({"cover": {"ref": 7}, "clock": {"device-a": 1, "peer": 2}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, &id, &unreadable)])?.applied,
            1
        );
        assert_eq!(payload(conn, ITEM_TYPE, &id)["cover"], local_cover);
        assert!(cover_column(conn, &id).is_some());

        // `null` clears icon and cover.
        let clear = json!({"icon": null, "cover": null, "clock": {"device-a": 1, "peer": 3}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, &id, &clear)])?.applied, 1);
        let board = get(conn, &id)?.expect("live");
        assert_eq!((board.icon, board.cover), (None, None));
        assert_eq!(queued(conn, ITEM_TYPE, &id), 1, "an apply queues nothing");
        Ok(())
    })
    .expect("remote update");
}

#[test]
fn an_unreadable_cover_over_a_board_without_one_is_left_out() {
    let (db, _dir) = open("home-page-remote-cover-absent");
    db.call_blocking(|conn| {
        let body = json!({"name": "Theirs", "clock": {"peer": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.applied, 1);
        let update = json!({"cover": {"ref": ""}, "clock": {"peer": 2}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &update)])?.applied, 1);
        let stored = payload(conn, ITEM_TYPE, ID);
        assert!(stored.get("cover").is_none(), "{stored}");
        Ok(())
    })
    .expect("cover");
}

#[test]
fn a_stale_remote_is_skipped_and_a_concurrent_one_wins_under_the_merged_clock() {
    let (db, _dir) = open("home-page-remote-clock");
    db.call_blocking(|conn| {
        let id = local_board(conn)?;
        let rename = HomePagePatch {
            name: Some("Mine"),
            ..HomePagePatch::default()
        };
        update(conn, &id, &rename, DEVICE, NOW + 1)?;
        let stale = json!({"name": "Old", "clock": {"device-a": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, &id, &stale)])?.skipped, 1);
        assert_eq!(payload(conn, ITEM_TYPE, &id)["name"], json!("Mine"));

        let concurrent = json!({"name": "Theirs", "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, &id, &concurrent)])?.applied,
            1
        );
        assert_eq!(payload(conn, ITEM_TYPE, &id)["name"], json!("Theirs"));
        assert_eq!(
            clock(conn, ITEM_TYPE, &id),
            clock_of([("device-a", 2), ("peer", 1)])
        );
        Ok(())
    })
    .expect("clocks");
}

#[test]
fn a_remote_delete_removes_the_board_unless_the_local_clock_is_after_it() {
    let (db, _dir) = open("home-page-remote-delete");
    db.call_blocking(|conn| {
        let id = local_board(conn)?;
        update(conn, &id, &HomePagePatch::default(), DEVICE, NOW + 1)?;
        let older = remote_delete(ITEM_TYPE, &id, clock_of([("device-a", 1)]));
        assert_eq!(pull(conn, vec![older])?.skipped, 1);
        assert!(get(conn, &id)?.is_some());

        let newer = remote_delete(ITEM_TYPE, &id, clock_of([("device-a", 2), ("peer", 1)]));
        assert_eq!(pull(conn, vec![newer])?.deleted, 1);
        assert!(list(conn)?.is_empty());
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_cover_is_readable_as_the_cover_schema_reads_it() {
    for (cover, readable) in [
        (json!({"ref": "unsplash:a"}), true),
        (
            json!({"ref": "a", "focus": 0, "credit": "x", "creditUrl": "y"}),
            true,
        ),
        (
            json!({"ref": "a", "focus": 100, "zoom": "junk", "attachmentId": 3}),
            true,
        ),
        (json!({"ref": ""}), false),
        (json!({"ref": 1}), false),
        (json!({"ref": "a", "focus": 101}), false),
        (json!({"ref": "a", "focus": "50"}), false),
        (json!({"ref": "a", "credit": 1}), false),
        (json!("unsplash:a"), false),
    ] {
        assert_eq!(is_readable_cover(&cover), readable, "{cover}");
    }
}
