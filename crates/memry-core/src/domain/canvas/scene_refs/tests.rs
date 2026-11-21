//! The cases of Electron's `scene-refs.test.ts`, `summary.test.ts` and
//! `elements.test.ts`, then the untrusted-input guards: depth on a 2 MiB
//! stack, a visit bound, the input bound and properties.

use proptest::prelude::*;
use serde_json::{Value, json};

use super::*;

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

fn pairs(edges: &[CanvasEntityEdge]) -> Vec<(&str, &str, &str)> {
    edges
        .iter()
        .map(|edge| {
            (
                edge.arrow_id.as_str(),
                edge.source.entity_id.as_str(),
                edge.target.entity_id.as_str(),
            )
        })
        .collect()
}

#[test]
fn refs_of_an_empty_unparseable_or_elementless_scene_are_empty() {
    for text in [
        "",
        "{not json",
        "null",
        "[]",
        r#"{"elements":{}}"#,
        r#"{"type":"excalidraw"}"#,
    ] {
        assert!(entity_refs(text).is_empty(), "{text}");
        assert!(entity_edges(text).is_empty(), "{text}");
        assert_eq!(summarize(text), CanvasSceneSummary::default(), "{text}");
        assert_eq!(
            read_elements(text),
            CanvasSceneElements::default(),
            "{text}"
        );
    }
}

#[test]
fn refs_cover_every_card_type_deduped_in_order() {
    let mut elements: Vec<Value> = CANVAS_ENTITY_TYPES
        .iter()
        .map(|kind| card(&format!("r-{kind}"), kind, &format!("{kind}-1")))
        .collect();
    elements.push(card("again", "note", "note-1"));
    let refs = entity_refs(&scene(Value::Array(elements)));
    let expected: Vec<_> = CANVAS_ENTITY_TYPES
        .iter()
        .map(|kind| entity(kind, &format!("{kind}-1")))
        .collect();
    assert_eq!(refs, expected);
}

#[test]
fn refs_ignore_deleted_elements_non_rectangles_and_invalid_custom_data() {
    let elements = json!([
        {"id": "a", "type": "rectangle", "isDeleted": true, "customData": {"entityType": "note", "entityId": "n1"}},
        {"id": "b", "type": "ellipse", "customData": {"entityType": "note", "entityId": "n2"}},
        {"id": "c", "type": "rectangle"},
        {"id": "d", "type": "rectangle", "customData": {"entityType": "bogus", "entityId": "n3"}},
        {"id": "e", "type": "rectangle", "customData": {"entityType": "note", "entityId": ""}},
        {"id": "f", "type": "rectangle", "customData": {"entityType": "note", "entityId": 7}},
        {"id": "g", "type": "rectangle", "customData": ["entityType"]},
        {"id": "h", "type": "rectangle", "isDeleted": "true", "customData": {"entityType": "task", "entityId": "t1"}},
        "not an element",
    ]);
    assert_eq!(entity_refs(&scene(elements)), vec![entity("task", "t1")]);
}

#[test]
fn an_arrow_between_two_cards_is_an_edge_that_follows_the_arrow() {
    let elements = json!([
        card("A", "note", "n1"),
        card("B", "task", "t1"),
        arrow("x", "A", "B")
    ]);
    let edges = entity_edges(&scene(elements));
    assert_eq!(
        edges,
        vec![CanvasEntityEdge {
            arrow_id: "x".into(),
            source: entity("note", "n1"),
            target: entity("task", "t1"),
        }]
    );
}

#[test]
fn an_arrow_with_its_only_head_at_the_start_points_the_other_way() {
    let reversed = json!({"id": "r", "type": "arrow", "startBinding": {"elementId": "A"}, "endBinding": {"elementId": "B"}, "startArrowhead": "arrow", "endArrowhead": null});
    let both = json!({"id": "b", "type": "arrow", "startBinding": {"elementId": "A"}, "endBinding": {"elementId": "B"}, "startArrowhead": "arrow", "endArrowhead": "dot"});
    let elements = json!([
        card("A", "note", "n1"),
        card("B", "note", "n2"),
        reversed,
        both
    ]);
    assert_eq!(
        pairs(&entity_edges(&scene(elements))),
        vec![("r", "n2", "n1"), ("b", "n1", "n2")]
    );
}

#[test]
fn edges_skip_plain_shapes_deleted_ends_self_loops_lines_and_repeats() {
    let elements = json!([
        card("A", "note", "n1"),
        card("B", "note", "n2"),
        card("A2", "note", "n1"),
        {"id": "S", "type": "ellipse"},
        {"id": "D", "type": "rectangle", "isDeleted": true, "customData": {"entityType": "note", "entityId": "n9"}},
        arrow("to-shape", "A", "S"),
        {"id": "loose", "type": "arrow", "startBinding": {"elementId": "A"}},
        arrow("to-deleted", "A", "D"),
        arrow("self", "A", "A2"),
        {"id": "line", "type": "line", "startBinding": {"elementId": "A"}, "endBinding": {"elementId": "B"}},
        {"id": "gone", "type": "arrow", "isDeleted": true, "startBinding": {"elementId": "A"}, "endBinding": {"elementId": "B"}},
        arrow("kept", "A", "B"),
        arrow("kept", "B", "A"),
    ]);
    assert_eq!(
        pairs(&entity_edges(&scene(elements))),
        vec![("kept", "n1", "n2")]
    );
}

#[test]
fn a_summary_holds_deduped_cards_and_trimmed_text_of_live_elements() {
    let elements = json!([
        card("A", "note", "n1"),
        card("A2", "note", "n1"),
        {"id": "t", "type": "text", "text": "  Hello \n"},
        {"id": "blank", "type": "text", "text": "   "},
        {"id": "gone", "type": "text", "text": "deleted", "isDeleted": true},
        {"id": "box", "type": "rectangle", "customData": {"entityType": "bogus", "entityId": "x"}},
    ]);
    let summary = summarize(&scene(elements));
    assert_eq!(summary.items, vec![entity("note", "n1")]);
    assert_eq!(summary.texts, vec!["Hello".to_owned()]);
    assert_eq!(summary.element_count, 5);
    assert!(!summary.texts_truncated);
}

#[test]
fn a_summary_caps_its_texts_by_count_and_by_utf16_length() {
    let many: Vec<Value> = (0..MAX_SUMMARY_TEXTS + 5)
        .map(|i| json!({"id": i.to_string(), "type": "text", "text": format!("t{i}")}))
        .collect();
    let summary = summarize(&scene(Value::Array(many)));
    assert_eq!(summary.texts.len(), MAX_SUMMARY_TEXTS);
    assert!(summary.texts_truncated);

    // Each emoji is two UTF-16 units, so 10,000 of them fill the budget alone.
    let wide = "\u{1f600}".repeat(MAX_SUMMARY_TEXT_CHARS / 2);
    let summary = summarize(&scene(json!([
        {"type": "text", "text": wide},
        {"type": "text", "text": "x"},
    ])));
    assert_eq!(summary.texts.len(), 1);
    assert!(summary.texts_truncated);
}

#[test]
fn an_element_read_reports_geometry_bindings_entities_and_links() {
    let elements = json!([
        {"id": "c", "type": "rectangle", "x": 10, "y": 20.5, "width": 260, "height": 168, "angle": 0.5,
         "strokeColor": "#000", "backgroundColor": "", "frameId": "f", "name": "Box",
         "customData": {"entityType": "note", "entityId": "n1"}},
        {"id": "m", "type": "rectangle", "x": "NaN", "customData": {"memryHref": "memry://note/n2"}},
        {"id": "l", "type": "rectangle", "link": "https://a.example", "customData": {"memryHref": "memry://x"}},
        {"id": "bogus", "type": "rectangle", "customData": {"entityType": "bogus", "entityId": "x"}},
        {"id": "a", "type": "arrow", "angle": 0, "startBinding": {"elementId": "c"}, "endBinding": {"elementId": "m"}},
        {"id": "cap", "type": "text", "text": "Chapter 3", "containerId": "c"},
        {"id": "free", "type": "text", "text": "Loose"},
        {"id": "x", "type": "ellipse", "isDeleted": true},
    ]);
    let read = read_elements(&scene(elements));
    assert_eq!(read.element_count, 7);
    assert!(!read.truncated);
    let ids: Vec<&str> = read.elements.iter().map(|view| view.id.as_str()).collect();
    assert_eq!(ids, ["c", "m", "l", "bogus", "a", "free"]);
    let by_id = |id: &str| read.elements.iter().find(|view| view.id == id).expect(id);
    let card = by_id("c");
    assert_eq!(
        (card.x, card.y, card.width, card.height),
        (10.0, 20.5, 260.0, 168.0)
    );
    assert_eq!(card.angle, Some(0.5));
    assert_eq!(card.entity_type.as_deref(), Some("note"));
    assert_eq!(card.entity_id.as_deref(), Some("n1"));
    assert_eq!(card.label.as_deref(), Some("Chapter 3"));
    assert_eq!(card.stroke_color.as_deref(), Some("#000"));
    assert_eq!(card.background_color, None);
    assert_eq!(card.frame_id.as_deref(), Some("f"));
    assert_eq!(card.name.as_deref(), Some("Box"));
    assert_eq!(by_id("m").x, 0.0);
    assert_eq!(by_id("m").link.as_deref(), Some("memry://note/n2"));
    assert_eq!(by_id("l").link.as_deref(), Some("https://a.example"));
    assert_eq!(by_id("bogus").entity_type, None);
    let arrow = by_id("a");
    assert_eq!(arrow.angle, None);
    assert_eq!(arrow.start_element_id.as_deref(), Some("c"));
    assert_eq!(arrow.end_element_id.as_deref(), Some("m"));
    assert_eq!(by_id("free").text.as_deref(), Some("Loose"));
}

#[test]
fn an_element_read_caps_at_its_limit_and_says_so() {
    let many: Vec<Value> = (0..MAX_ELEMENT_VIEWS + 1)
        .map(|i| json!({"id": format!("e{i}"), "type": "ellipse"}))
        .collect();
    let read = read_elements(&scene(Value::Array(many)));
    assert_eq!(read.elements.len(), MAX_ELEMENT_VIEWS);
    assert_eq!(read.element_count, MAX_ELEMENT_VIEWS + 1);
    assert!(read.truncated);
}

/// Nesting far past `serde_json`'s recursion limit reads as empty on a 2 MiB
/// stack instead of overflowing it.
#[test]
fn a_deeply_nested_scene_reads_as_empty_on_a_small_stack() {
    memry_test_kit::on_small_stack(|| {
        let depth = 100_000;
        let nested = format!(
            r#"{{"elements":[{{"id":"a","type":"rectangle","customData":{}1{}}}]}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        assert!(entity_refs(&nested).is_empty());
        assert!(entity_edges(&nested).is_empty());
        assert_eq!(summarize(&nested), CanvasSceneSummary::default());
        assert_eq!(read_elements(&nested).element_count, 0);
    });
}

/// The values beside `elements` are skipped without a parse, at any depth.
#[test]
fn deep_nesting_beside_the_elements_leaves_them_readable_on_a_small_stack() {
    memry_test_kit::on_small_stack(|| {
        let depth = 100_000;
        let card_json = card("A", "note", "n1").to_string();
        let nested = format!(
            r#"{{"elements":[{card_json}],"files":{}1{}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        assert_eq!(entity_refs(&nested), vec![entity("note", "n1")]);
    });
}

type CountedRead = fn(&str, &mut usize);

/// Every read walks the elements at most twice, whatever they hold: one
/// thousand arrows between two hundred cards cost no pairwise work.
#[test]
fn each_read_visits_each_element_at_most_twice() {
    let mut elements: Vec<Value> = (0..200)
        .map(|i| card(&format!("c{i}"), "note", &format!("n{i}")))
        .collect();
    elements.extend((0..1000).map(|i| {
        arrow(
            &format!("a{i}"),
            &format!("c{}", i % 200),
            &format!("c{}", (i + 1) % 200),
        )
    }));
    let text = scene(Value::Array(elements));
    let count = 1200;
    let reads: [(&str, CountedRead); 4] = [
        ("refs", |s, v| drop(entity_refs_counted(s, v))),
        ("edges", |s, v| drop(entity_edges_counted(s, v))),
        ("summary", |s, v| drop(summarize_counted(s, v))),
        ("elements", |s, v| drop(read_elements_counted(s, v))),
    ];
    for (what, read) in reads {
        let mut visits = 0;
        read(&text, &mut visits);
        assert!(
            visits <= 2 * count,
            "{what}: {visits} visits for {count} elements"
        );
    }
}

/// The bound counts the `elements` array only: inline image `files` past it
/// still leave every link readable.
#[test]
fn only_elements_over_the_parse_bound_read_as_empty() {
    let card_json = card("A", "note", "n1").to_string();
    let padding = "x".repeat(MAX_SCENE_BYTES);
    let big_files =
        format!(r#"{{"elements":[{card_json}],"files":{{"f1":{{"dataURL":"{padding}"}}}}}}"#);
    assert!(big_files.len() > MAX_SCENE_BYTES);
    assert_eq!(entity_refs(&big_files), vec![entity("note", "n1")]);
    let big_elements = format!(r#"{{"elements":[{card_json},{{"pad":"{padding}"}}]}}"#);
    assert!(entity_refs(&big_elements).is_empty());
}

fn element() -> impl Strategy<Value = Value> {
    let id = prop_oneof![
        Just("A".to_owned()),
        Just("B".to_owned()),
        Just(String::new()),
        "[a-c]{1,2}"
    ];
    let kind = prop_oneof![Just("rectangle"), Just("arrow"), Just("text"), Just("line")];
    let entity_type = prop_oneof![Just("note"), Just("task"), Just("bogus")];
    (
        id.clone(),
        kind,
        entity_type,
        id.clone(),
        id,
        any::<bool>(),
        "[ a-z]{0,4}",
    )
        .prop_map(|(id, kind, entity_type, from, to, deleted, text)| {
            json!({
                "id": id, "type": kind, "isDeleted": deleted, "text": text, "containerId": from,
                "customData": {"entityType": entity_type, "entityId": to},
                "startBinding": {"elementId": from}, "endBinding": {"elementId": to},
            })
        })
}

proptest! {
    #![proptest_config(memry_test_kit::proptest_config(memry_test_kit::DEFAULT_CASES))]

    /// Any text reads without a panic, and no read reports more than the
    /// scene holds.
    #[test]
    fn any_text_reads_without_panicking(text in ".{0,200}") {
        prop_assert!(entity_refs(&text).len() <= text.len());
        prop_assert!(entity_edges(&text).len() <= text.len());
        prop_assert!(summarize(&text).element_count <= text.len());
        prop_assert!(read_elements(&text).elements.len() <= text.len());
    }

    /// Outputs are bounded by the elements they came from, and every edge
    /// joins two cards the refs read reports.
    #[test]
    fn outputs_are_bounded_by_the_scene(elements in prop::collection::vec(element(), 0..40)) {
        let count = elements.len();
        let text = scene(Value::Array(elements));
        let refs = entity_refs(&text);
        prop_assert!(refs.len() <= count);
        let edges = entity_edges(&text);
        prop_assert!(edges.len() <= count);
        for edge in &edges {
            prop_assert!(refs.contains(&edge.source) && refs.contains(&edge.target));
            prop_assert_ne!(&edge.source, &edge.target);
        }
        let summary = summarize(&text);
        prop_assert!(summary.items.len() + summary.texts.len() <= summary.element_count);
        let read = read_elements(&text);
        prop_assert!(read.elements.len() <= read.element_count && read.element_count <= count);
    }
}
