//! `Node`, `Fragment` and `Mark`, plus their JSON form (`Node.toJSON`,
//! `Node.fromJSON`) so vectors can state a document as data.

use serde_json::{Map, Value as Json};
use yrs::Any;

use super::schema::{MarkTypeId, NodeTypeId, Schema};

/// Attribute values in the order the type declares them (the order
/// `computeAttrs` builds the JavaScript object in). A value is a Yjs [`Any`]
/// because y-prosemirror stores attributes as Yjs values verbatim, including
/// `Undefined`, which a declared default of `undefined` produces.
pub type Attrs = Vec<(String, Any)>;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PmError {
    #[error("unknown node type {0}")]
    UnknownNodeType(String),
    #[error("unknown mark type {0}")]
    UnknownMarkType(String),
    #[error("invalid content for {0}")]
    InvalidContent(String),
    #[error("no value supplied for attribute {attr} of {owner}")]
    MissingAttr { owner: String, attr: String },
    #[error("unsupported attribute {attr} for {owner}")]
    UnsupportedAttr { owner: String, attr: String },
    #[error("empty text nodes are not allowed")]
    EmptyText,
    #[error("invalid node JSON: {0}")]
    InvalidJson(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub ty: MarkTypeId,
    pub attrs: Attrs,
}

/// A node. `text` is `Some` for a text node; any other node carries its
/// children in `content`.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub ty: NodeTypeId,
    pub attrs: Attrs,
    pub content: Fragment,
    pub marks: Vec<Mark>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fragment {
    nodes: Vec<Node>,
}

impl Node {
    pub fn is_text(&self) -> bool {
        self.text.is_some()
    }

    /// `Node.sameMarkup`: same type, attributes and marks, content ignored.
    pub fn same_markup(&self, other: &Node) -> bool {
        self.ty == other.ty && self.attrs == other.attrs && self.marks == other.marks
    }

    pub fn children(&self) -> &[Node] {
        self.content.nodes()
    }

    /// `Node.toJSON`. An `Undefined` attribute is left out, as `JSON.stringify`
    /// does.
    pub fn to_json(&self, schema: &Schema) -> Json {
        let mut out = Map::new();
        out.insert("type".into(), Json::from(schema.node_ty(self.ty).name));
        if !self.attrs.is_empty() {
            out.insert("attrs".into(), attrs_to_json(&self.attrs));
        }
        if !self.content.is_empty() {
            let items = self.children().iter().map(|n| n.to_json(schema)).collect();
            out.insert("content".into(), Json::Array(items));
        }
        if !self.marks.is_empty() {
            let items = self.marks.iter().map(|m| m.to_json(schema)).collect();
            out.insert("marks".into(), Json::Array(items));
        }
        if let Some(text) = &self.text {
            out.insert("text".into(), Json::from(text.as_str()));
        }
        Json::Object(out)
    }

    /// `Node.fromJSON`: unchecked construction plus the attribute check.
    pub fn from_json(schema: &Schema, json: &Json) -> Result<Node, PmError> {
        let object = json
            .as_object()
            .ok_or(PmError::InvalidJson("node is not an object"))?;
        let marks = match object.get("marks") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Array(items)) => items
                .iter()
                .map(|m| Mark::from_json(schema, m))
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(PmError::InvalidJson("marks is not an array")),
        };
        let name = object
            .get("type")
            .and_then(Json::as_str)
            .ok_or(PmError::InvalidJson("node has no type"))?;
        if name == "text" {
            let text = object
                .get("text")
                .and_then(Json::as_str)
                .ok_or(PmError::InvalidJson("text node without text"))?;
            return schema.text(text, marks);
        }
        let ty = schema
            .node_type(name)
            .ok_or_else(|| PmError::UnknownNodeType(name.to_owned()))?;
        let children = match object.get("content") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Array(items)) => items
                .iter()
                .map(|n| Node::from_json(schema, n))
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(PmError::InvalidJson("content is not an array")),
        };
        let given = json_attrs(object.get("attrs"));
        schema.check_node_attrs(ty, &given)?;
        schema.create(ty, &given, Fragment::from_array(children), marks)
    }
}

impl Mark {
    pub fn to_json(&self, schema: &Schema) -> Json {
        let mut out = Map::new();
        out.insert("type".into(), Json::from(schema.mark_ty(self.ty).name));
        if !self.attrs.is_empty() {
            out.insert("attrs".into(), attrs_to_json(&self.attrs));
        }
        Json::Object(out)
    }

    pub fn from_json(schema: &Schema, json: &Json) -> Result<Mark, PmError> {
        let name = json
            .get("type")
            .and_then(Json::as_str)
            .ok_or(PmError::InvalidJson("mark has no type"))?;
        let ty = schema
            .mark_type(name)
            .ok_or_else(|| PmError::UnknownMarkType(name.to_owned()))?;
        let given = json_attrs(json.get("attrs"));
        schema.check_mark_attrs(ty, &given)?;
        schema.create_mark(ty, &given_any(&given))
    }
}

impl Fragment {
    /// `Fragment.fromArray`: adjacent text nodes with the same marks join.
    pub fn from_array(nodes: Vec<Node>) -> Fragment {
        let mut joined: Vec<Node> = Vec::with_capacity(nodes.len());
        for node in nodes {
            if let (Some(last), Some(text)) = (joined.last_mut(), &node.text)
                && last.same_markup(&node)
                && let Some(prefix) = &mut last.text
            {
                prefix.push_str(text);
                continue;
            }
            joined.push(node);
        }
        Fragment { nodes: joined }
    }

    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

fn attrs_to_json(attrs: &Attrs) -> Json {
    let mut out = Map::new();
    for (name, value) in attrs {
        if let Some(json) = any_to_json(value) {
            out.insert(name.clone(), json);
        }
    }
    Json::Object(out)
}

/// A Yjs value as JSON; `None` for `Undefined`, which JSON cannot carry.
pub fn any_to_json(value: &Any) -> Option<Json> {
    Some(match value {
        Any::Undefined => return None,
        Any::Null => Json::Null,
        Any::Bool(b) => Json::Bool(*b),
        Any::Number(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 => {
            Json::from(*n as i64)
        }
        Any::Number(n) => serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number),
        Any::BigInt(n) => Json::from(*n),
        Any::String(s) => Json::from(s.as_ref()),
        Any::Buffer(bytes) => Json::Array(bytes.iter().map(|b| Json::from(*b)).collect()),
        Any::Array(items) => Json::Array(
            items
                .iter()
                .map(|item| any_to_json(item).unwrap_or(Json::Null))
                .collect(),
        ),
        Any::Map(entries) => {
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(json) = any_to_json(&entries[key]) {
                    out.insert(key.clone(), json);
                }
            }
            Json::Object(out)
        }
    })
}

pub fn json_to_any(value: &Json) -> Any {
    match value {
        Json::Null => Any::Null,
        Json::Bool(b) => Any::Bool(*b),
        Json::Number(n) => Any::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Any::from(s.as_str()),
        Json::Array(items) => Any::from(items.iter().map(json_to_any).collect::<Vec<_>>()),
        Json::Object(map) => Any::from(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect::<std::collections::HashMap<_, _>>(),
        ),
    }
}

fn json_attrs(value: Option<&Json>) -> Vec<(String, Any)> {
    match value {
        Some(Json::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), json_to_any(v)))
            .collect(),
        _ => Vec::new(),
    }
}

fn given_any(given: &[(String, Any)]) -> Any {
    Any::from(
        given
            .iter()
            .cloned()
            .collect::<std::collections::HashMap<_, _>>(),
    )
}
