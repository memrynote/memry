//! The edge index against a real `index.db` and `data.db` (Electron's
//! `canvas-edges.test.ts` and `edge-index.test.ts` outcomes): refs and edges
//! come from the scene, and every read drops the rows of canvases that are no
//! longer live.

use serde_json::{Value, json};

use super::*;
use crate::domain::canvas::{NewCanvas, create, delete};
use crate::storage::{open_data, open_index, test_support::temp_dir};

const VAULT_ID: &str = "vault-1";
const DEVICE: &str = "device-LOCAL";
const NOW: i64 = 1_760_000_000_000;

fn scene(elements: Value) -> String {
    json!({"type": "excalidraw", "version": 2, "elements": elements}).to_string()
}

fn card(id: &str, entity_type: &str, entity_id: &str) -> Value {
    json!({"id": id, "type": "rectangle", "customData": {"entityType": entity_type, "entityId": entity_id}})
}

fn arrow(id: &str, from: &str, to: &str) -> Value {
    json!({"id": id, "type": "arrow", "startBinding": {"elementId": from}, "endBinding": {"elementId": to}, "endArrowhead": "arrow"})
}

fn entity(entity_type: &str, entity_id: &str) -> CanvasEntityRef {
    CanvasEntityRef {
        entity_type: entity_type.into(),
        entity_id: entity_id.into(),
    }
}

fn pairs(edges: &[CanvasEdge]) -> Vec<(&str, &str, &str)> {
    edges
        .iter()
        .map(|edge| {
            (
                edge.canvas_title.as_deref().unwrap_or_default(),
                edge.source.entity_id.as_str(),
                edge.target.entity_id.as_str(),
            )
        })
        .collect()
}

#[test]
fn a_rewrite_indexes_the_scene_and_reads_drop_deleted_canvases() {
    let dir = temp_dir("canvas-edges");
    let data = open_data(&dir.path().join("data.db")).expect("data.db");
    let index = open_index(&dir.path().join("index.db"))
        .expect("index.db")
        .db;

    let plan = scene(json!([
        card("A", "note", "n1"),
        card("B", "task", "t1"),
        card("C", "note", "n2"),
        arrow("a1", "A", "B"),
        arrow("a2", "A", "B"),
        arrow("a3", "B", "C"),
    ]));
    let other = scene(json!([
        card("A", "note", "n1"),
        card("B", "task", "t1"),
        arrow("x1", "A", "B"),
    ]));
    let (plan_id, other_id) = data
        .call_blocking(|conn| {
            let make = |title, scene: &str| {
                let canvas = NewCanvas {
                    title: Some(title),
                    scene: Some(scene),
                    ..NewCanvas::default()
                };
                create(conn, &canvas, VAULT_ID, DEVICE, NOW).map(|saved| saved.canvas.id)
            };
            Ok((make("Plan", &plan)?, make("Other", &other)?))
        })
        .expect("canvases");

    index
        .call_blocking(|index| {
            rewrite(index, &plan_id, &plan)?;
            rewrite(index, &other_id, &other)?;
            // A second rewrite replaces, never appends.
            rewrite(index, &plan_id, &plan)
        })
        .expect("rewrite");

    let read = |entity_id: Option<&str>| {
        data.call_blocking(|data| {
            index.call_blocking(|index| match entity_id {
                None => list(data, index),
                Some(id) => for_entity(data, index, "task", id),
            })
        })
        .expect("read")
    };

    // Two arrows joining the same cards on one canvas are one connection; the
    // same pair on another canvas stays its own.
    let all = read(None);
    let mut seen = pairs(&all);
    seen.sort();
    assert_eq!(
        seen,
        [
            ("Other", "n1", "t1"),
            ("Plan", "n1", "t1"),
            ("Plan", "t1", "n2")
        ]
    );
    assert_eq!(all[0].source, entity("note", "n1"));
    assert_eq!(read(Some("t1")).len(), 3);

    let counts = index
        .call_blocking(|index| item_counts(index))
        .expect("counts");
    assert_eq!(counts.get(&plan_id), Some(&3));
    assert_eq!(counts.get(&other_id), Some(&2));

    data.call_blocking(|conn| delete(conn, &plan_id, DEVICE, NOW + 1))
        .expect("delete");
    assert_eq!(
        pairs(&read(None)),
        [("Other", "n1", "t1")],
        "a deleted canvas's rows drop out before the index is cleared"
    );

    index
        .call_blocking(|index| {
            clear(index, &other_id)?;
            rewrite(index, &plan_id, &scene(json!([])))
        })
        .expect("clear");
    assert!(read(None).is_empty());
    let counts = index
        .call_blocking(|index| item_counts(index))
        .expect("counts");
    assert!(counts.is_empty(), "{counts:?}");
}
