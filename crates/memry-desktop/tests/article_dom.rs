//! The DOM port against the vectors generated from linkedom 0.18.12 and css-select 5.2.2
//! (`pnpm --filter @memry/article-extract vectors`): the tree the parser builds, its
//! serialization, and the result of every selector Defuddle uses plus the css-select probes.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::dom::{Document, NodeId, NodeKind};
use memry_desktop::web::extract::error::ExtractError;
use serde_json::{Map, Value, json};

fn vectors() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract")
}

fn read(path: &str) -> Value {
    let full = vectors().join(path);
    let text = fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display()));
    serde_json::from_str(&text).unwrap()
}

fn fixture_html(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/article-extract")
        .join(name)
        .join("page.html");
    // The corpus holds raw bytes; invalid UTF-8 would be replaced like TextDecoder does.
    String::from_utf8_lossy(&fs::read(path).unwrap()).into_owned()
}

fn dump(doc: &Document, id: NodeId) -> Value {
    match &doc.node(id).kind {
        NodeKind::Element(e) => json!({
            "t": "e",
            "n": e.name,
            "svg": e.svg,
            "a": e.attrs.iter().map(|a| json!([a.name, a.value])).collect::<Vec<_>>(),
            "c": dump_children(doc, id),
        }),
        NodeKind::Text(d) => json!({ "t": "x", "d": d }),
        NodeKind::CData(d) => json!({ "t": "k", "d": d }),
        NodeKind::Comment(d) => json!({ "t": "c", "d": d }),
        NodeKind::Doctype(d) => {
            json!({ "t": "d", "name": d.name, "publicId": d.public_id, "systemId": d.system_id })
        }
        other => panic!("unexpected node {other:?}"),
    }
}

fn dump_children(doc: &Document, parent: NodeId) -> Vec<Value> {
    doc.child_nodes(parent)
        .into_iter()
        .map(|c| dump(doc, c))
        .collect()
}

fn elements(doc: &Document) -> Vec<NodeId> {
    fn visit(doc: &Document, node: NodeId, out: &mut Vec<NodeId>) {
        for child in doc.child_nodes(node) {
            if doc.is_element(child) {
                out.push(child);
                visit(doc, child, out);
            }
        }
    }
    let mut out = Vec::new();
    visit(doc, doc.root(), &mut out);
    out
}

fn error_value(e: ExtractError) -> Value {
    match e {
        ExtractError::Selector(m) | ExtractError::Dom(m) => json!({ "error": m }),
    }
}

/// Ordinals of `nodes` among the document's elements, or the error object.
fn ordinals(order: &[NodeId], r: Result<Vec<NodeId>, ExtractError>) -> Value {
    match r {
        Ok(nodes) => {
            json!(
                nodes
                    .iter()
                    .map(|n| order.iter().position(|o| o == n).unwrap())
                    .collect::<Vec<_>>()
            )
        }
        Err(e) => error_value(e),
    }
}

fn is_empty_array(v: &Value) -> bool {
    v.as_array().is_some_and(Vec::is_empty)
}

#[test]
fn dom_matches_linkedom_on_every_fixture() {
    let selectors = read("selectors.json");
    let defuddle: Vec<&str> = selectors["defuddle"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    let probes: Vec<&str> = selectors["probes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    let all: Vec<&str> = defuddle.iter().chain(probes.iter()).copied().collect();
    let probe_base = defuddle.len();

    let index = read("index.json");
    let fixtures = index.as_array().unwrap();
    assert!(fixtures.len() >= 20, "corpus too small: {}", fixtures.len());
    for fixture in fixtures {
        let name = fixture["name"].as_str().unwrap();
        let expected = read(&format!("dom/{name}.json"));
        let html = fixture_html(name);
        let doc = Document::parse_html(&html);
        let order = elements(&doc);

        let tree: Vec<Value> = dump_children(&doc, doc.root());
        assert_eq!(Value::Array(tree), expected["tree"], "{name}: tree");
        assert_eq!(
            json!(order.len()),
            expected["elementCount"],
            "{name}: element count"
        );
        assert_eq!(
            json!(doc.serialize(doc.root())),
            expected["document"],
            "{name}: document"
        );

        let mut by_document = Map::new();
        for (i, selector) in all.iter().enumerate() {
            let got = ordinals(&order, doc.query_selector_all(doc.root(), selector));
            if !is_empty_array(&got) {
                by_document.insert(i.to_string(), got);
            }
        }
        compare_maps(
            name,
            "document",
            by_document,
            &expected["queries"]["document"],
        );

        let mut matching = Map::new();
        for (i, selector) in probes.iter().enumerate() {
            let mut hits = Vec::new();
            let mut failure = None;
            for (ordinal, &el) in order.iter().enumerate() {
                match doc.matches(el, selector) {
                    Ok(true) => hits.push(ordinal),
                    Ok(false) => {}
                    Err(e) => {
                        failure = Some(error_value(e));
                        break;
                    }
                }
            }
            let got = failure.unwrap_or_else(|| json!(hits));
            if !is_empty_array(&got) {
                matching.insert((probe_base + i).to_string(), got);
            }
        }
        compare_maps(name, "matches", matching, &expected["queries"]["matches"]);

        let sample: Vec<usize> = (0..order.len()).filter(|o| o % 5 == 0).take(16).collect();
        assert_eq!(
            json!(sample),
            expected["queries"]["sample"],
            "{name}: sample"
        );
        let mut scoped = Map::new();
        let mut closest = Map::new();
        for &ordinal in &sample {
            let el = order[ordinal];
            let mut scoped_here = Map::new();
            let mut closest_here = Map::new();
            for (i, selector) in probes.iter().enumerate() {
                let key = (probe_base + i).to_string();
                if let Ok(nodes) = doc.query_selector_all(el, selector)
                    && !nodes.is_empty()
                {
                    scoped_here.insert(key.clone(), ordinals(&order, Ok(nodes)));
                }
                if let Ok(Some(found)) = doc.closest(el, selector) {
                    closest_here
                        .insert(key, json!(order.iter().position(|o| *o == found).unwrap()));
                }
            }
            if !scoped_here.is_empty() {
                scoped.insert(ordinal.to_string(), Value::Object(scoped_here));
            }
            if !closest_here.is_empty() {
                closest.insert(ordinal.to_string(), Value::Object(closest_here));
            }
        }
        assert_eq!(
            Value::Object(scoped),
            expected["queries"]["scoped"],
            "{name}: scoped"
        );
        assert_eq!(
            Value::Object(closest),
            expected["queries"]["closest"],
            "{name}: closest"
        );

        let mut fresh = Document::parse_html(&html);
        let head_body = if fresh.head().is_some() && fresh.body().is_some() {
            json!(fresh.serialize(fresh.root()))
        } else {
            // linkedom throws on a document without elements.
            expected["headBody"].clone()
        };
        assert_eq!(head_body, expected["headBody"], "{name}: head and body");
    }
}

fn compare_maps(name: &str, what: &str, got: Map<String, Value>, expected: &Value) {
    let expected = expected.as_object().unwrap();
    let mut keys: Vec<&String> = got.keys().chain(expected.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        assert_eq!(
            got.get(key),
            expected.get(key),
            "{name}: {what} selector #{key}"
        );
    }
}

/// Seeded random token soups: the parser's tree and serialization match linkedom's on input no
/// page-shaped fixture would write.
#[test]
fn parser_matches_linkedom_on_random_markup() {
    let cases = read("dom-fuzz.json");
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 600);
    for (i, case) in cases.iter().enumerate() {
        let html = case["html"].as_str().unwrap();
        let doc = Document::parse_html(html);
        let tree = Value::Array(dump_children(&doc, doc.root()));
        assert_eq!(tree, case["tree"], "case {i}: {html:?}");
        assert_eq!(
            json!(doc.serialize(doc.root())),
            case["document"],
            "case {i}: {html:?}"
        );
    }
}
