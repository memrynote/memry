//! Step 30c (#3547): reorder, cover framing and the legacy widget read, on a
//! real `data.db`. Electron's cases are `home-page-handlers.test.ts` and
//! `cover-service.test.ts`.

use serde_json::{Value, json};

use super::cover::{self, FramingChanges, clamp_focus, clamp_height, clamp_zoom, wash_ref};
use super::widgets::{Widget, display};
use super::{HomePagePatch, ITEM_TYPE, NewHomePage, create, get, list, reorder, update};
use crate::domain::desktop_records::testing::{DEVICE, NOW, clock, open, payload, queued};
use crate::sync::clock::get_tick;

fn board(name: &str, position: f64) -> NewHomePage<'_> {
    NewHomePage {
        name,
        icon: None,
        position,
        widgets: "[]",
        cover: None,
    }
}

#[test]
fn reorder_moves_each_board_to_its_index_and_ticks_only_the_moved_ones() {
    let (db, _dir) = open("home-page-reorder");
    db.call_blocking(|conn| {
        let a = create(conn, &board("A", 0.0), DEVICE, NOW)?.id;
        let b = create(conn, &board("B", 1.0), DEVICE, NOW)?.id;
        let c = create(conn, &board("C", 2.0), DEVICE, NOW)?.id;
        conn.execute("DELETE FROM outbox", [])
            .expect("clear the queue");

        let moved = reorder(conn, &[c.clone(), b.clone(), a.clone()], DEVICE, NOW + 5)?;

        assert_eq!(moved, vec![c.clone(), a.clone()], "B stays at 1");
        let order: Vec<String> = list(conn)?.into_iter().map(|board| board.id).collect();
        assert_eq!(order, vec![c.clone(), b.clone(), a.clone()]);
        assert_eq!(payload(conn, ITEM_TYPE, &c)["position"], json!(0));
        assert_eq!(payload(conn, ITEM_TYPE, &a)["position"], json!(2));
        assert_eq!(get_tick(&clock(conn, ITEM_TYPE, &a), DEVICE), 2);
        assert_eq!(get_tick(&clock(conn, ITEM_TYPE, &b), DEVICE), 1, "unmoved");
        assert_eq!(queued(conn, ITEM_TYPE, &a), 1);
        assert_eq!(
            queued(conn, ITEM_TYPE, &b),
            0,
            "a board in place queues nothing"
        );
        assert_eq!(get(conn, &a)?.expect("live").updated_at, NOW + 5);

        let again = reorder(conn, &[c.clone(), b, a], DEVICE, NOW + 6)?;
        assert!(again.is_empty(), "a no-op reorder moves nothing");
        Ok(())
    })
    .expect("write");
}

#[test]
fn reorder_skips_an_unknown_id_without_shifting_the_others() {
    let (db, _dir) = open("home-page-reorder-unknown");
    db.call_blocking(|conn| {
        let a = create(conn, &board("A", 0.0), DEVICE, NOW)?.id;
        let moved = reorder(conn, &["gone".to_owned(), a.clone()], DEVICE, NOW + 1)?;
        assert_eq!(moved, vec![a.clone()]);
        assert_eq!(payload(conn, ITEM_TYPE, &a)["position"], json!(1));
        Ok(())
    })
    .expect("write");
}

#[test]
fn framing_clamps_each_field_and_keeps_every_other_cover_key() {
    let (db, _dir) = open("home-page-framing");
    db.call_blocking(|conn| {
        let id = create(conn, &board("A", 0.0), DEVICE, NOW)?.id;
        let stored = json!({
            "ref": ".memry/home-covers/x/a.png",
            "attachmentId": "0123456789abcdef0123456789abcdef",
            "future": {"kept": true},
        });
        let patch = HomePagePatch {
            cover: Some(Some(&stored)),
            ..HomePagePatch::default()
        };
        update(conn, &id, &patch, DEVICE, NOW + 1)?;

        let changes = FramingChanges {
            focus_y: Some(12.5),
            zoom: Some(2.345),
            ..FramingChanges::default()
        };
        cover::set_framing(conn, &id, changes, DEVICE, NOW + 2)?;

        assert_eq!(
            payload(conn, ITEM_TYPE, &id)["cover"],
            json!({
                "ref": ".memry/home-covers/x/a.png",
                "attachmentId": "0123456789abcdef0123456789abcdef",
                "future": {"kept": true},
                "focus": 13, "focusX": 50, "zoom": 2.35, "height": 200,
            })
        );
        let later = FramingChanges {
            height: Some(999.0),
            ..FramingChanges::default()
        };
        cover::set_framing(conn, &id, later, DEVICE, NOW + 3)?;
        let cover = payload(conn, ITEM_TYPE, &id)["cover"].clone();
        assert_eq!(cover["height"], json!(480));
        assert_eq!(cover["focus"], json!(13), "an earlier change stays");
        Ok(())
    })
    .expect("write");
}

#[test]
fn framing_a_board_without_a_cover_writes_nothing() {
    let (db, _dir) = open("home-page-framing-none");
    db.call_blocking(|conn| {
        let id = create(conn, &board("A", 0.0), DEVICE, NOW)?.id;
        let before = clock(conn, ITEM_TYPE, &id);
        let changes = FramingChanges {
            zoom: Some(2.0),
            ..FramingChanges::default()
        };
        let answered = cover::set_framing(conn, &id, changes, DEVICE, NOW + 1)?;
        assert_eq!(answered.cover, None);
        assert_eq!(clock(conn, ITEM_TYPE, &id), before);
        assert!(cover::set_framing(conn, "gone", changes, DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("write");
}

#[test]
fn clamps_round_as_javascript_does() {
    assert_eq!(clamp_focus(12.5), 13.0);
    assert_eq!(clamp_focus(-0.5), 0.0);
    assert_eq!(clamp_focus(101.0), 100.0);
    assert_eq!(clamp_focus(f64::NAN), 50.0);
    assert_eq!(clamp_zoom(0.2), 1.0);
    assert_eq!(clamp_zoom(1.005), 1.0, "1.005 * 100 is 100.49999");
    assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
    assert_eq!(clamp_height(100.0), 120.0);
    assert_eq!(clamp_height(250.5), 251.0);
}

#[test]
fn only_the_picker_washes_have_a_ref() {
    assert_eq!(wash_ref("sage").as_deref(), Some("wash:sage"));
    assert_eq!(wash_ref("plum").as_deref(), Some("wash:plum"));
    assert_eq!(wash_ref("neon"), None);
    assert_eq!(wash_ref(""), None);
}

fn widget(id: &str, kind: &str, [x, y, w, h]: [f64; 4], config: Value) -> Widget {
    Widget {
        id: id.to_owned(),
        kind: kind.to_owned(),
        x,
        y,
        w,
        h,
        config: config.as_object().cloned().expect("an object"),
    }
}

#[test]
fn legacy_size_widgets_are_placed_in_one_column_with_a_running_y() {
    let text = json!([
        {"id": "a", "type": "inbox", "size": "S", "config": {"limit": 3}},
        {"id": "b", "type": "tasks", "size": "L"},
        {"id": "c", "type": "journal", "size": "XL"},
        {"id": "d", "type": "notes", "x": 4, "y": 1, "w": 2, "h": 3, "config": {}},
    ])
    .to_string();
    assert_eq!(
        display(&text),
        Some(vec![
            widget("a", "inbox", [0.0, 0.0, 2.0, 2.0], json!({"limit": 3})),
            widget("b", "tasks", [0.0, 2.0, 8.0, 4.0], json!({})),
            widget("c", "journal", [0.0, 6.0, 4.0, 4.0], json!({})),
            widget("d", "notes", [4.0, 1.0, 2.0, 3.0], json!({})),
        ])
    );
}

#[test]
fn a_widget_of_an_unknown_type_survives_and_bad_text_reads_as_none() {
    let text =
        r#"[{"id":"z","type":"from-a-newer-build","x":0,"y":0,"w":1,"h":1,"config":{"k":[1]}}, 7]"#;
    assert_eq!(
        display(text),
        Some(vec![widget(
            "z",
            "from-a-newer-build",
            [0.0, 0.0, 1.0, 1.0],
            json!({"k": [1]})
        )])
    );
    assert_eq!(display("{not json"), None);
    assert_eq!(display(r#"{"id":"a"}"#), None);
}
