//! The `memry-portal` fence's JSON, read as tolerantly as the TypeScript port
//! (`parsePortalDefinition`): unknown keys are ignored, anything unreadable is
//! `None`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::anchor::is_anchor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalOpen {
    /// Every child except these anchors.
    Hide(Vec<String>),
    /// Only these anchors.
    Show(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalTarget {
    /// The whole note, nothing folded, minus the blocks (and their
    /// descendants) whose anchors are in `hide`.
    Note { note: String, hide: Vec<String> },
    /// Root anchors (without the leading caret) in portal order, and which
    /// blocks show their children. A block absent from `open` is collapsed.
    Blocks {
        note: String,
        blocks: Vec<String>,
        open: HashMap<String, PortalOpen>,
    },
    /// Computed by the caller; the contents are not read here.
    Search,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalDefinition {
    pub target: PortalTarget,
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn read_anchors(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    let mut anchors: Vec<String> = Vec::new();
    for entry in entries {
        if let Value::String(anchor) = entry
            && is_anchor(anchor)
            && !anchors.contains(anchor)
        {
            anchors.push(anchor.clone());
        }
    }
    anchors
}

fn read_open(value: Option<&Value>) -> HashMap<String, PortalOpen> {
    let mut open = HashMap::new();
    let Some(Value::Object(entries)) = value else {
        return open;
    };
    for (anchor, entry) in entries {
        let Value::Object(entry) = entry else {
            continue;
        };
        if !is_anchor(anchor) {
            continue;
        }
        if entry.get("show").is_some_and(Value::is_array) {
            open.insert(
                anchor.clone(),
                PortalOpen::Show(read_anchors(entry.get("show"))),
            );
        } else if entry.get("hide").is_some_and(Value::is_array) {
            open.insert(
                anchor.clone(),
                PortalOpen::Hide(read_anchors(entry.get("hide"))),
            );
        }
    }
    open
}

fn read_target(json: &Map<String, Value>) -> Option<PortalTarget> {
    if let Some(Value::Object(search)) = json.get("search") {
        let usable =
            non_empty(search.get("text")).is_some() || non_empty(search.get("tag")).is_some();
        return usable.then_some(PortalTarget::Search);
    }
    let note = non_empty(json.get("note"))?;
    let blocks = read_anchors(json.get("blocks"));
    if blocks.is_empty() {
        return Some(PortalTarget::Note {
            note,
            hide: read_anchors(json.get("hide")),
        });
    }
    Some(PortalTarget::Blocks {
        note,
        blocks,
        open: read_open(json.get("open")),
    })
}

pub fn parse_portal_definition(text: &str) -> Option<PortalDefinition> {
    let Ok(Value::Object(json)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    Some(PortalDefinition {
        target: read_target(&json)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_note_and_blocks_targets_and_ignores_unknown_keys() {
        let note = parse_portal_definition(r#"{"v":1,"note":"n1","future":[1]}"#).unwrap();
        assert_eq!(
            note.target,
            PortalTarget::Note {
                note: "n1".into(),
                hide: Vec::new()
            }
        );
        let empty = parse_portal_definition(r#"{"note":"n1","blocks":["no"]}"#).unwrap();
        assert_eq!(
            empty.target,
            PortalTarget::Note {
                note: "n1".into(),
                hide: Vec::new()
            }
        );

        let hidden = parse_portal_definition(
            r#"{"v":1,"note":"n1","hide":["k3x9a2","NO",7,"k3x9a2","p8m2qa"]}"#,
        )
        .unwrap();
        assert_eq!(
            hidden.target,
            PortalTarget::Note {
                note: "n1".into(),
                hide: vec!["k3x9a2".into(), "p8m2qa".into()]
            }
        );

        let blocks = parse_portal_definition(
            r#"{"v":1,"note":"n1","blocks":["k3x9a2","p8m2qa","k3x9a2","x"],
               "open":{"k3x9a2":{"show":["n4c8x1","BAD"]},"p8m2qa":{"hide":[]},
                       "zzzz99":"no","bad":{"show":[]}}}"#,
        )
        .unwrap();
        let PortalTarget::Blocks { blocks, open, .. } = blocks.target else {
            panic!("blocks target");
        };
        assert_eq!(blocks, vec!["k3x9a2".to_string(), "p8m2qa".to_string()]);
        assert_eq!(open.len(), 2);
        assert_eq!(open["k3x9a2"], PortalOpen::Show(vec!["n4c8x1".into()]));
        assert_eq!(open["p8m2qa"], PortalOpen::Hide(Vec::new()));
    }

    #[test]
    fn rejects_unreadable_definitions() {
        for text in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"note":"  "}"#,
            r#"{"blocks":["k3x9a2"]}"#,
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
