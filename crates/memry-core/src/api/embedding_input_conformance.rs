//! `embedding-input.json` through the core: every note and query shaped the
//! way desktop's `embedding-input.ts` shapes it (`docs/protocol/15`).

use serde_json::{Value, json};

use crate::domain::embedding_input::{Window, chunks, document_input, query_input};

fn text<'a>(case: &'a Value, field: &str) -> &'a str {
    case[field].as_str().unwrap_or("")
}

/// Runs every case of `embedding-input.json` and answers `{ cases: [{ name,
/// actual: { document, chunks } }], queries: [{ name, actual }] }`.
#[uniffi::export]
pub fn embedding_input_conformance(vector_json: String) -> String {
    let Ok(file) = serde_json::from_str::<Value>(&vector_json) else {
        return json!({ "error": "not JSON" }).to_string();
    };
    let list = |key: &str| file[key].as_array().cloned().unwrap_or_default();
    let cases: Vec<Value> = list("cases")
        .iter()
        .map(|case| {
            let (title, content) = (text(case, "title"), text(case, "content"));
            json!({
                "name": case["name"],
                "actual": {
                    "document": document_input(title, content).as_ref().map(Window::as_str),
                    "chunks": chunks(title, content).iter().map(Window::as_str).collect::<Vec<_>>(),
                }
            })
        })
        .collect();
    let queries: Vec<Value> = list("queries")
        .iter()
        .map(|case| {
            json!({
                "name": case["name"],
                "actual": query_input(text(case, "query")).as_ref().map(Window::as_str),
            })
        })
        .collect();
    json!({ "cases": cases, "queries": queries }).to_string()
}
