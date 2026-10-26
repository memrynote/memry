//! The Y.Doc half of the `markdown-convert` class: building the document a
//! case states, and reading it back as the vectors state it (canonical
//! fragment without block ids, side roots as JSON, writing tools anchors as
//! the run and index they resolve to).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::markdown::bn::block_to_node::IdSource;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::convert::restore::SerializeOptions;
use memry_core::markdown::schema::callout_types::{CalloutTypeDefinition, CalloutTypes};
use memry_core::markdown::shared::writing_tools::read_writing_frontmatter;
use serde_json::{Map, Value as Json, json};
use yrs::branch::Branch;
use yrs::types::text::YChange;
use yrs::{
    Any, Array as _, Assoc, ClientID, ID, IndexScope, Map as _, Out, ReadTxn, StickyIndex,
    Text as _, WriteTxn, XmlFragment, XmlOut, XmlTextRef,
};

pub const FRAGMENT: &str = "prosemirror";

/// Ids from a counter, so a run does not depend on chance (vectors never compare ids).
pub struct CounterIds(AtomicU64);

impl CounterIds {
    pub fn new() -> Self {
        Self(AtomicU64::new(0))
    }
}

impl IdSource for CounterIds {
    fn next_id(&self) -> String {
        format!("id-{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
}

pub struct Files(pub HashMap<String, String>);

impl EmbedResolver for Files {
    fn resolve(&self, target: &str, _note_path: Option<&str>) -> Option<String> {
        self.0.get(target).cloned()
    }
}

pub fn files_of(input: &Json) -> Files {
    Files(
        input["embedFiles"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub fn converter_for(input: &Json) -> Converter {
    let defs: Vec<CalloutTypeDefinition> = input["calloutTypes"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| serde_json::from_value(d.clone()).expect("definition"))
                .collect()
        })
        .unwrap_or_default();
    Converter::with_ids(CalloutTypes::new(defs), Box::new(CounterIds::new()))
}

pub fn open_document() -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-doc-case", sink);
    registry.get_or_open("abc123def456").expect("open")
}

/// The document a case states: seeded from `markdown` or built from an update,
/// then edited. `Err` when the seed fails or an edit has nothing to act on,
/// which is where the TypeScript throws or answers null.
pub fn build_document(
    converter: &Converter,
    input: &Json,
    files: &Files,
) -> Result<Arc<Document>, String> {
    let document = open_document();
    if let Some(hex) = input["updateHex"].as_str() {
        document
            .apply_durable_update(&hex::decode(hex).expect("hex"))
            .map_err(|e| format!("apply: {e}"))?;
    } else {
        let writing = input.get("writing").and_then(read_writing_frontmatter);
        let ok = converter.seed_body(
            &document,
            input["markdown"].as_str().unwrap_or(""),
            input["notePath"].as_str(),
            writing,
            files,
        );
        if !ok {
            return Err("seed failed".into());
        }
    }
    for edit in input["edits"].as_array().into_iter().flatten() {
        apply_edit(&document, edit)?;
    }
    Ok(document)
}

fn text_runs<F: XmlFragment, T: ReadTxn>(parent: &F, txn: &T, runs: &mut Vec<XmlTextRef>) {
    for child in parent.children(txn) {
        match child {
            XmlOut::Text(text) => runs.push(text),
            XmlOut::Element(element) => text_runs(&element, txn, runs),
            XmlOut::Fragment(_) => {}
        }
    }
}

fn apply_edit(document: &Document, edit: &Json) -> Result<(), String> {
    let kind = edit["kind"].as_str().unwrap_or("");
    document
        .write(|txn| -> Result<(), String> {
            let fragment = txn.get_or_insert_xml_fragment(FRAGMENT);
            match kind {
                "insert-start" | "insert-end" => {
                    let mut runs = Vec::new();
                    text_runs(&fragment, &*txn, &mut runs);
                    let run = runs
                        .get(edit["run"].as_u64().unwrap_or(0) as usize)
                        .ok_or("the edit has no text run to act on")?;
                    let at = if kind == "insert-start" {
                        0
                    } else {
                        run.len(&*txn)
                    };
                    run.insert(txn, at, edit["text"].as_str().unwrap_or(""));
                }
                "clear-source" => {
                    txn.get_or_insert_map("markdownSource")
                        .remove(txn, "record");
                }
                "set-source" => {
                    let record = json!({
                        "source": edit["source"], "htmlComments": edit["htmlComments"]
                    });
                    txn.get_or_insert_map("markdownSource").insert(
                        txn,
                        "record",
                        memry_core::markdown::pm::model::json_to_any(&record),
                    );
                }
                "clear-critic" => {
                    let array = txn.get_or_insert_array("criticMarkupMarks");
                    let len = array.len(&*txn);
                    array.remove_range(txn, 0, len);
                }
                "delete-fragment" => {
                    let len = fragment.len(&*txn);
                    fragment.remove_range(txn, 0, len);
                }
                other => return Err(format!("unknown edit {other}")),
            }
            Ok(())
        })
        .map_err(|e| format!("write: {e}"))?
}

/// `canonicalFragment` with the random `id` attribute removed.
pub fn fragment_text(document: &Document) -> String {
    canonical_fragment(document)
        .expect("canonical")
        .split('\n')
        .map(|line| match line.find(" id=\"") {
            Some(at) => match line[at + 5..].find('"') {
                Some(end) => format!("{}{}", &line[..at], &line[at + 5 + end + 1..]),
                None => line.to_owned(),
            },
            None => line.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn plain_of<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> String {
    text.diff(txn, YChange::identity)
        .into_iter()
        .map(|c| match c.insert {
            Out::Any(Any::String(s)) => s.to_string(),
            _ => "\u{fffc}".to_owned(),
        })
        .collect()
}

fn anchor_json<T: ReadTxn>(txn: &T, runs: &[XmlTextRef], anchor: &Json) -> Json {
    let id = |v: &Json| -> Option<ID> {
        Some(ID::new(
            ClientID::new(v["client"].as_f64()? as u64),
            v["clock"].as_f64()? as u32,
        ))
    };
    let scope = if let Some(item) = anchor.get("item").and_then(id) {
        IndexScope::Relative(item)
    } else if let Some(name) = anchor.get("tname").and_then(Json::as_str) {
        IndexScope::Root(name.into())
    } else if let Some(t) = anchor.get("type").and_then(id) {
        IndexScope::Nested(t)
    } else {
        return Json::Null;
    };
    let assoc_value = anchor["assoc"].as_f64().unwrap_or(0.0);
    let assoc = if assoc_value >= 0.0 {
        Assoc::After
    } else {
        Assoc::Before
    };
    let Some(offset) = StickyIndex::new(scope, assoc).get_offset(txn) else {
        return Json::Null;
    };
    let branch: &Branch = &offset.branch;
    let Some(run) = runs
        .iter()
        .position(|r| std::ptr::eq(AsRef::<Branch>::as_ref(r), branch))
    else {
        return Json::Null;
    };
    // `get_offset` answers in bytes; the vectors count UTF-16 units.
    let plain = plain_of(txn, &runs[run]);
    let index = plain
        .get(..offset.index as usize)
        .map_or(offset.index as usize, |s| s.encode_utf16().count());
    json!({"run": run, "index": index, "assoc": assoc_value})
}

fn json_array<T: ReadTxn>(txn: &T, name: &str) -> Vec<Json> {
    memry_core::markdown::convert::roots::read_array_json(txn, name)
}

/// The side roots as the vectors state them.
pub fn roots_json(document: &Document) -> Json {
    document
        .read(|txn| {
            let mut runs = Vec::new();
            if let Some(fragment) = txn.get_xml_fragment(FRAGMENT) {
                text_runs(&fragment, txn, &mut runs);
            }
            let anchored = |name: &str| -> Json {
                Json::Array(
                    json_array(txn, name)
                        .into_iter()
                        .map(|mut record| {
                            if let Some(map) = record.as_object_mut() {
                                for key in ["anchorStart", "anchorEnd"] {
                                    if let Some(value) = map.get(key).cloned() {
                                        map.insert(key.into(), anchor_json(txn, &runs, &value));
                                    }
                                }
                            }
                            record
                        })
                        .collect(),
                )
            };
            let source = txn
                .get_map("markdownSource")
                .and_then(|m| m.get(txn, "record"))
                .map_or(Json::Null, |v| {
                    memry_core::markdown::convert::roots::out_json(v, txn)
                });
            json!({
                "markdownSource": source,
                "criticMarkupMarks": json_array(txn, "criticMarkupMarks"),
                "linkReferenceDefinitions": json_array(txn, "linkReferenceDefinitions"),
                "linkReferenceUsages": json_array(txn, "linkReferenceUsages"),
                "writingAlternatives": anchored("writingAlternatives"),
                "writingGhosts": anchored("writingGhosts"),
                "writingOverflow": json_array(txn, "writingOverflow"),
            })
        })
        .expect("read")
}

/// Recursively sorted keys, so two JSON values compare regardless of key order.
pub fn sorted(value: &Json) -> Json {
    match value {
        Json::Array(items) => Json::Array(items.iter().map(sorted).collect()),
        Json::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), sorted(&map[key]));
            }
            Json::Object(out)
        }
        other => other.clone(),
    }
}

/// Everything the read side answers for one document, as the vectors state it.
pub fn serialized(converter: &Converter, document: &Document, input: &Json, files: &Files) -> Json {
    let file_body = input.get("fileBody").cloned();
    let read = move || -> Result<Option<String>, String> {
        match &file_body {
            Some(Json::String(s)) if s == "throw" => Err("unreadable".to_owned()),
            Some(Json::String(s)) => Ok(Some(s.clone())),
            _ => Ok(None),
        }
    };
    let unreadable = std::cell::Cell::new(false);
    let report =
        |_: memry_core::markdown::convert::restore::SourceRestoreOutcome| unreadable.set(true);
    let options = SerializeOptions {
        on_unreadable: Some(&report),
        note_path: input["notePath"].as_str(),
        read_file_body: input.get("fileBody").is_some().then_some(&read),
        embeds: Some(files),
    };
    let body = converter.doc_to_markdown(document, FRAGMENT, &options);
    let note = converter.serialize_note_body(document, FRAGMENT, &options);
    json!({
        "seeded": true,
        "markdown": body.as_ref().map(|b| b.markdown.clone()),
        "outcome": body.as_ref().map(|b| b.outcome.as_str()).or(unreadable.get().then_some("file-unreadable")),
        "canonical": converter.doc_to_canonical_markdown(document, FRAGMENT),
        "noteBody": note.map(|n| json!({
            "markdown": n.markdown,
            "writing": serde_json::to_value(&n.writing).expect("writing"),
            "outcome": n.outcome.as_str(),
        })),
        "unrepresentable": converter.find_unrepresentable_nodes(document, FRAGMENT),
    })
}
