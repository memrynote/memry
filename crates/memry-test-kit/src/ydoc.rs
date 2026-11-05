//! A Yjs document as JSON, for tests that compare two documents built two ways.

use serde_json::{Value, json};
use yrs::types::ToJson as _;
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode as _;
use yrs::{Any, Doc, ReadTxn, Text as _, Transact as _, Update, Xml as _, XmlFragment, XmlOut};

/// The body's fragment root (`memry_core::crdt::BODY_FRAGMENT`).
const BODY_FRAGMENT: &str = "prosemirror";

/// Every root of the document the `updates` build, as JSON, block ids aside: a conversion
/// gives each block a random one, and two conversions of one text under one client id differ
/// in nothing else. (Their bytes also differ in the order of a record's keys.) The body's
/// fragment is its elements with their attributes and its text runs with their marks; every
/// other root (the markdown source, CriticMarkup marks, link references, the writing tools'
/// roots) is its value.
pub fn doc_json(updates: &[Vec<u8>]) -> Value {
    let doc = Doc::new();
    for update in updates {
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).expect("an update"))
            .expect("apply");
    }
    let names: Vec<String> = doc
        .transact()
        .root_refs()
        .map(|(name, _)| name.to_owned())
        .collect();
    let mut roots = serde_json::Map::new();
    for name in names {
        let value = match name.as_str() {
            BODY_FRAGMENT => {
                let fragment = doc.get_or_insert_xml_fragment(BODY_FRAGMENT);
                Value::Array(xml_children(&fragment, &doc.transact()))
            }
            "markdownSource" => {
                let map = doc.get_or_insert_map("markdownSource");
                any_json(&map.to_json(&doc.transact()))
            }
            _ => {
                let array = doc.get_or_insert_array(name.as_str());
                any_json(&array.to_json(&doc.transact()))
            }
        };
        roots.insert(name, value);
    }
    Value::Object(roots)
}

fn any_json(any: &Any) -> Value {
    serde_json::to_value(any).expect("JSON")
}

fn xml_children<F: XmlFragment, T: ReadTxn>(parent: &F, txn: &T) -> Vec<Value> {
    parent
        .children(txn)
        .map(|child| match child {
            XmlOut::Element(element) => {
                let mut attributes: Vec<(String, Value)> = element
                    .attributes(txn)
                    .filter(|(name, _)| *name != "id")
                    .map(|(name, value)| (name.to_owned(), any_json(&value.to_json(txn))))
                    .collect();
                attributes.sort_by(|a, b| a.0.cmp(&b.0));
                json!({
                    "tag": element.tag().as_ref(),
                    "attributes": attributes,
                    "children": xml_children(&element, txn),
                })
            }
            XmlOut::Text(text) => Value::Array(
                text.diff(txn, YChange::identity)
                    .into_iter()
                    .map(|chunk| {
                        let mut marks: Vec<(String, Value)> = chunk
                            .attributes
                            .iter()
                            .flat_map(|attrs| attrs.iter())
                            .map(|(name, value)| (name.to_string(), any_json(value)))
                            .collect();
                        marks.sort_by(|a, b| a.0.cmp(&b.0));
                        json!({ "insert": any_json(&chunk.insert.to_json(txn)), "marks": marks })
                    })
                    .collect(),
            ),
            XmlOut::Fragment(fragment) => Value::Array(xml_children(&fragment, txn)),
        })
        .collect()
}
