//! The `memry-portal` fence's JSON, read as tolerantly as the TypeScript port
//! (`parsePortalDefinition`): unknown keys are ignored, anything unreadable is
//! `None`.

use serde_json::{Map, Value};

use super::anchor::is_anchor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalTarget {
    Note {
        note: String,
    },
    /// `anchor` is without the leading caret.
    Block {
        note: String,
        anchor: String,
    },
    /// Computed by the caller; the contents are not read here.
    Search,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalDefinition {
    pub target: PortalTarget,
    /// Anchors of descendants this portal does not show, deduplicated.
    pub hidden: Vec<String>,
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn read_target(json: &Map<String, Value>) -> Option<PortalTarget> {
    if let Some(Value::Object(search)) = json.get("search") {
        let usable =
            non_empty(search.get("text")).is_some() || non_empty(search.get("tag")).is_some();
        return usable.then_some(PortalTarget::Search);
    }
    let note = non_empty(json.get("note"))?;
    match json.get("block") {
        None => Some(PortalTarget::Note { note }),
        Some(Value::String(anchor)) if is_anchor(anchor) => Some(PortalTarget::Block {
            note,
            anchor: anchor.clone(),
        }),
        Some(_) => None,
    }
}

fn read_hidden(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    let mut hidden: Vec<String> = Vec::new();
    for entry in entries {
        if let Value::String(anchor) = entry
            && is_anchor(anchor)
            && !hidden.contains(anchor)
        {
            hidden.push(anchor.clone());
        }
    }
    hidden
}

pub fn parse_portal_definition(text: &str) -> Option<PortalDefinition> {
    let Ok(Value::Object(json)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let target = read_target(&json)?;
    Some(PortalDefinition {
        target,
        hidden: read_hidden(json.get("hidden")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_note_and_block_targets_and_ignores_unknown_keys() {
        let note = parse_portal_definition(r#"{"note":"n1","future":[1]}"#).unwrap();
        assert_eq!(note.target, PortalTarget::Note { note: "n1".into() });
        let block = parse_portal_definition(
            r#"{"note":"n1","block":"chl-7f2a","hidden":["b9x1","b9x1","no"]}"#,
        )
        .unwrap();
        assert_eq!(
            block.target,
            PortalTarget::Block {
                note: "n1".into(),
                anchor: "chl-7f2a".into()
            }
        );
        assert_eq!(block.hidden, vec!["b9x1".to_string()]);
    }

    #[test]
    fn rejects_unreadable_definitions() {
        for text in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"note":"  "}"#,
            r#"{"note":"n1","block":"x"}"#,
            r#"{"note":"n1","block":null}"#,
            r#"{"search":{"limit":5}}"#,
        ] {
            assert_eq!(parse_portal_definition(text), None, "{text}");
        }
        assert_eq!(
            parse_portal_definition(r#"{"search":{"tag":"bio"}}"#)
                .unwrap()
                .target,
            PortalTarget::Search
        );
    }
}
