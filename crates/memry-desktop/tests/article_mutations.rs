//! Tree edits replayed against linkedom 0.18.12 (`dom-mutations.json`).

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::dom::{Document, NodeId};
use serde_json::{Value, json};

fn fragment(doc: &mut Document, html: &str) -> Vec<NodeId> {
    let holder = doc.create_element("div");
    doc.set_inner_html(holder, html).unwrap();
    doc.child_nodes(holder)
}

fn ordinal(doc: &Document, node: NodeId) -> usize {
    doc.query_selector_all(doc.root(), "*")
        .unwrap()
        .iter()
        .position(|n| *n == node)
        .unwrap()
}

fn play(html: &str, ops: &[Value]) -> Value {
    let mut doc = Document::parse_html(html);
    let mut log = Vec::new();
    for step in ops {
        let op = step["op"].as_str().unwrap();
        let Some(target) = doc
            .query_selector(doc.root(), step["sel"].as_str().unwrap())
            .unwrap()
        else {
            log.push(json!({ "op": op, "miss": step["sel"] }));
            continue;
        };
        let s = |k: &str| step[k].as_str().unwrap_or_default().to_owned();
        let tokens: Vec<String> = step["tokens"]
            .as_array()
            .map(|t| t.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default();
        let token_refs: Vec<&str> = tokens.iter().map(String::as_str).collect();
        match op {
            "remove" => doc.remove(target),
            "replaceWith" => {
                let nodes = fragment(&mut doc, &s("html"));
                doc.replace_with(target, &nodes).unwrap();
            }
            "replaceWithSelf" => doc.replace_with(target, &[target]).unwrap(),
            "before" => {
                let nodes = fragment(&mut doc, &s("html"));
                doc.before(target, &nodes).unwrap();
            }
            "after" => {
                let nodes = fragment(&mut doc, &s("html"));
                doc.after(target, &nodes).unwrap();
            }
            "prepend" => {
                for node in fragment(&mut doc, &s("html")).into_iter().rev() {
                    doc.prepend(target, node).unwrap();
                }
            }
            "append" => {
                for node in fragment(&mut doc, &s("html")) {
                    doc.append_child(target, node).unwrap();
                }
            }
            "setAttribute" => doc.set_attribute(target, &s("name"), &s("value")),
            "removeAttribute" => doc.remove_attribute(target, &s("name")),
            "textContent" => doc.set_text_content(target, &s("value")).unwrap(),
            "innerHTML" => doc.set_inner_html(target, &s("value")).unwrap(),
            "cloneAfter" => {
                let copy = doc.clone_node(target, step["deep"].as_bool().unwrap());
                doc.after(target, &[copy]).unwrap();
            }
            "classAdd" => doc.class_list_add(target, &token_refs),
            "classRemove" => doc.class_list_remove(target, &token_refs),
            "classToggle" => {
                let value = doc.class_list_toggle(target, &s("token"), step["force"].as_bool());
                log.push(json!({ "op": op, "value": value }));
            }
            "moveInto" => {
                let into = doc.query_selector(doc.root(), &s("into")).unwrap().unwrap();
                doc.append_child(into, target).unwrap();
            }
            "insertBefore" => {
                let reference = doc
                    .query_selector(doc.root(), &s("before"))
                    .unwrap()
                    .unwrap();
                let parent = doc.parent_node(reference).unwrap();
                doc.insert_before(parent, target, Some(reference)).unwrap();
            }
            "normalize" => doc.normalize(target),
            "get" => log.push(json!({ "op": op, "value": doc.get_attribute(target, &s("name")) })),
            "text" => log.push(json!({ "op": op, "value": doc.text_content(target) })),
            "html" => log.push(json!({ "op": op, "value": doc.inner_html(target) })),
            "outer" => log.push(json!({ "op": op, "value": doc.outer_html(target) })),
            "query" => {
                let found = doc.query_selector_all(target, &s("query")).unwrap();
                let ordinals: Vec<usize> = found.iter().map(|n| ordinal(&doc, *n)).collect();
                log.push(json!({ "op": op, "value": ordinals }));
            }
            other => panic!("unknown op {other}"),
        }
    }
    json!({ "log": log, "document": doc.serialize(doc.root()) })
}

#[test]
fn edits_match_linkedom() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract/dom-mutations.json");
    let scenarios: Vec<Value> = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert!(scenarios.len() >= 10);
    for scenario in scenarios {
        let got = play(
            scenario["html"].as_str().unwrap(),
            scenario["ops"].as_array().unwrap(),
        );
        assert_eq!(got, scenario["expected"], "{}", scenario["name"]);
    }
}
