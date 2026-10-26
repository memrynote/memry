//! Node types, mark types and the checked constructors of `prosemirror-model`'s
//! `Schema`, built from the static tables in [`super::specs`].

use std::collections::HashMap;
use std::sync::OnceLock;

use yrs::Any;

use super::content::{self, ContentMatch, MatchState, StateId, TypeInfo};
use super::model::{Attrs, Fragment, Mark, Node, PmError};
use super::specs::{MARK_SPECS, NODE_SPECS, TOP_NODE};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeTypeId(pub u16);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MarkTypeId(pub u8);

/// A declared attribute default. `Required` is an attribute with no default:
/// `computeAttrs` throws when a node is built without it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Default {
    Required,
    Str(&'static str),
    Number(f64),
    Bool(bool),
    Null,
    Undefined,
}

impl Default {
    fn value(&self) -> Option<Any> {
        Some(match self {
            Default::Required => return None,
            Default::Str(s) => Any::from(*s),
            Default::Number(n) => Any::Number(*n),
            Default::Bool(b) => Any::Bool(*b),
            Default::Null => Any::Null,
            Default::Undefined => Any::Undefined,
        })
    }
}

pub struct AttrSpec {
    pub name: &'static str,
    pub default: Default,
}

/// `NodeSpec.marks`: absent (inline-content nodes allow every mark, others
/// none) or the empty string (none). No node of the schema names marks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Marks {
    Unspecified,
    None,
}

pub struct NodeSpec {
    pub name: &'static str,
    pub content: &'static str,
    pub marks: Marks,
    pub group: &'static str,
    pub inline: bool,
    pub atom: bool,
    pub code: bool,
    pub defining: bool,
    pub isolating: bool,
    pub selectable: Option<bool>,
    pub linebreak_replacement: bool,
    pub attrs: &'static [AttrSpec],
}

impl NodeSpec {
    pub const BASE: NodeSpec = NodeSpec {
        name: "",
        content: "",
        marks: Marks::Unspecified,
        group: "",
        inline: false,
        atom: false,
        code: false,
        defining: false,
        isolating: false,
        selectable: None,
        linebreak_replacement: false,
        attrs: &[],
    };
}

/// `MarkSpec.excludes`: absent means the mark excludes itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Excludes {
    Own,
    None,
    All,
}

pub struct MarkSpec {
    pub name: &'static str,
    pub excludes: Excludes,
    pub inclusive: Option<bool>,
    pub attrs: &'static [AttrSpec],
}

impl MarkSpec {
    pub const BASE: MarkSpec = MarkSpec {
        name: "",
        excludes: Excludes::Own,
        inclusive: None,
        attrs: &[],
    };
}

pub struct NodeType {
    pub name: &'static str,
    pub spec: &'static NodeSpec,
    pub content_match: StateId,
    pub is_inline: bool,
    pub is_text: bool,
    pub is_leaf: bool,
    pub inline_content: bool,
    pub has_required_attrs: bool,
    /// Every mark is allowed inside this node (the `markSet == null` case).
    pub all_marks: bool,
    groups: Vec<&'static str>,
}

impl NodeType {
    pub fn is_in_group(&self, group: &str) -> bool {
        self.groups.contains(&group)
    }

    pub fn is_atom(&self) -> bool {
        self.is_leaf || self.spec.atom
    }

    /// `NodeType.whitespace`: `pre` for code nodes, else `normal`.
    pub fn preserves_whitespace(&self) -> bool {
        self.spec.code
    }
}

pub struct MarkType {
    pub name: &'static str,
    pub rank: u8,
    pub spec: &'static MarkSpec,
    excludes: Vec<bool>,
}

pub struct Schema {
    nodes: Vec<NodeType>,
    marks: Vec<MarkType>,
    pub(super) states: Vec<MatchState>,
    by_name: HashMap<&'static str, NodeTypeId>,
    mark_by_name: HashMap<&'static str, MarkTypeId>,
    top: NodeTypeId,
    text: NodeTypeId,
}

impl Schema {
    /// The memry schema. Built once; a failure here is a defect in the static
    /// tables, which the `markdown_pm_vectors` test would catch first.
    pub fn memry() -> &'static Schema {
        static MEMRY: OnceLock<Schema> = OnceLock::new();
        MEMRY.get_or_init(|| {
            Schema::build(NODE_SPECS, MARK_SPECS, TOP_NODE)
                .unwrap_or_else(|err| panic!("the static memry schema is invalid: {err}"))
        })
    }

    pub fn build(
        node_specs: &'static [NodeSpec],
        mark_specs: &'static [MarkSpec],
        top: &str,
    ) -> Result<Schema, String> {
        let mut by_name = HashMap::new();
        let mut infos = Vec::new();
        let mut nodes = Vec::new();
        for (index, spec) in node_specs.iter().enumerate() {
            let id = NodeTypeId(index as u16);
            by_name.insert(spec.name, id);
            let is_text = spec.name == "text";
            let groups: Vec<&'static str> = spec.group.split_whitespace().collect();
            let is_inline = spec.inline || is_text;
            let has_required_attrs = spec.attrs.iter().any(|a| a.default == Default::Required);
            infos.push(TypeInfo {
                name: spec.name,
                groups: groups.clone(),
                is_inline,
                is_text,
                has_required_attrs,
            });
            nodes.push(NodeType {
                name: spec.name,
                spec,
                content_match: StateId(0),
                is_inline,
                is_text,
                is_leaf: spec.content.is_empty(),
                inline_content: false,
                has_required_attrs,
                all_marks: false,
                groups,
            });
        }
        let mut states = vec![MatchState {
            next: Vec::new(),
            valid_end: true,
        }];
        let mut cache: HashMap<&str, StateId> = HashMap::new();
        for node in &mut nodes {
            let expr = node.spec.content;
            let state = match cache.get(expr) {
                Some(state) => *state,
                None => {
                    let state = content::compile(expr, &infos, &mut states)?;
                    cache.insert(expr, state);
                    state
                }
            };
            node.content_match = state;
            node.inline_content = states[state.0 as usize]
                .next
                .first()
                .is_some_and(|(ty, _)| infos[ty.0 as usize].is_inline);
            node.all_marks = match node.spec.marks {
                Marks::None => false,
                Marks::Unspecified => node.inline_content,
            };
        }
        let mut mark_by_name = HashMap::new();
        for (index, spec) in mark_specs.iter().enumerate() {
            mark_by_name.insert(spec.name, MarkTypeId(index as u8));
        }
        let marks = mark_specs
            .iter()
            .enumerate()
            .map(|(index, spec)| MarkType {
                name: spec.name,
                rank: index as u8,
                spec,
                excludes: mark_specs
                    .iter()
                    .enumerate()
                    .map(|(other, _)| match spec.excludes {
                        Excludes::Own => other == index,
                        Excludes::None => false,
                        Excludes::All => true,
                    })
                    .collect(),
            })
            .collect();
        let top = *by_name.get(top).ok_or("no top node type")?;
        let text = *by_name.get("text").ok_or("no text node type")?;
        Ok(Schema {
            nodes,
            marks,
            states,
            by_name,
            mark_by_name,
            top,
            text,
        })
    }

    pub fn node_type(&self, name: &str) -> Option<NodeTypeId> {
        self.by_name.get(name).copied()
    }

    pub fn mark_type(&self, name: &str) -> Option<MarkTypeId> {
        self.mark_by_name.get(name).copied()
    }

    pub fn node_ty(&self, id: NodeTypeId) -> &NodeType {
        &self.nodes[id.0 as usize]
    }

    pub fn mark_ty(&self, id: MarkTypeId) -> &MarkType {
        &self.marks[id.0 as usize]
    }

    pub fn node_types(&self) -> impl Iterator<Item = (NodeTypeId, &NodeType)> {
        self.nodes
            .iter()
            .enumerate()
            .map(|(i, t)| (NodeTypeId(i as u16), t))
    }

    pub fn mark_types(&self) -> impl Iterator<Item = (MarkTypeId, &MarkType)> {
        self.marks
            .iter()
            .enumerate()
            .map(|(i, t)| (MarkTypeId(i as u8), t))
    }

    pub fn top_node_type(&self) -> NodeTypeId {
        self.top
    }

    pub fn text_type(&self) -> NodeTypeId {
        self.text
    }

    pub fn content_match(&self, ty: NodeTypeId) -> ContentMatch<'_> {
        ContentMatch::new(self, self.node_ty(ty).content_match)
    }

    /// The match at a state of a node's own automaton, as `ContentMatch.next` reaches it.
    pub fn content_match_at(&self, id: StateId) -> ContentMatch<'_> {
        ContentMatch::new(self, id)
    }

    /// `MarkType.excludes`.
    pub fn mark_excludes(&self, mark: MarkTypeId, other: MarkTypeId) -> bool {
        self.mark_ty(mark).excludes[other.0 as usize]
    }

    /// `NodeType.allowsMarks`.
    pub fn allows_marks(&self, ty: NodeTypeId, marks: &[Mark]) -> bool {
        self.node_ty(ty).all_marks || marks.is_empty()
    }

    /// `computeAttrs(type.attrs, given)`: a value that is absent or
    /// `Undefined` takes the declared default, and a required attribute with
    /// no value is an error. Names the type does not declare are dropped.
    fn compute_attrs(
        owner: &str,
        declared: &[AttrSpec],
        given: impl Fn(&str) -> Option<Any>,
    ) -> Result<Attrs, PmError> {
        let mut built = Vec::with_capacity(declared.len());
        for attr in declared {
            let value = match given(attr.name) {
                Some(value) if !matches!(value, Any::Undefined) => value,
                _ => attr.default.value().ok_or_else(|| PmError::MissingAttr {
                    owner: owner.to_owned(),
                    attr: attr.name.to_owned(),
                })?,
            };
            built.push((attr.name.to_owned(), value));
        }
        Ok(built)
    }

    fn node_attrs(&self, ty: NodeTypeId, given: &[(String, Any)]) -> Result<Attrs, PmError> {
        let node_ty = self.node_ty(ty);
        Self::compute_attrs(node_ty.name, node_ty.spec.attrs, |name| {
            given
                .iter()
                .rfind(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        })
    }

    /// `NodeType.create`: attributes computed, content not checked.
    pub fn create(
        &self,
        ty: NodeTypeId,
        given: &[(String, Any)],
        content: Fragment,
        marks: Vec<Mark>,
    ) -> Result<Node, PmError> {
        if self.node_ty(ty).is_text {
            return Err(PmError::InvalidJson("cannot create a text node this way"));
        }
        Ok(Node {
            ty,
            attrs: self.node_attrs(ty, given)?,
            content,
            marks: self.set_from(marks),
            text: None,
        })
    }

    /// `NodeType.checkContent`: the children must match the content
    /// expression to a valid end, and each child's marks must be allowed.
    pub fn check_content(&self, ty: NodeTypeId, content: &Fragment) -> Result<(), PmError> {
        let node_ty = self.node_ty(ty);
        let matched = self.content_match(ty).match_fragment(content.nodes(), 0);
        let valid = matched.is_some_and(|m| m.valid_end())
            && content
                .nodes()
                .iter()
                .all(|child| self.allows_marks(ty, &child.marks));
        if valid {
            Ok(())
        } else {
            Err(PmError::InvalidContent(node_ty.name.to_owned()))
        }
    }

    /// `schema.node(name, attrs, children)`, which is `createChecked`.
    pub fn node(
        &self,
        name: &str,
        given: &[(String, Any)],
        children: Vec<Node>,
    ) -> Result<Node, PmError> {
        let ty = self
            .node_type(name)
            .ok_or_else(|| PmError::UnknownNodeType(name.to_owned()))?;
        let content = Fragment::from_array(children);
        self.check_content(ty, &content)?;
        Ok(Node {
            ty,
            attrs: self.node_attrs(ty, given)?,
            content,
            marks: Vec::new(),
            text: None,
        })
    }

    /// `schema.text(text, marks)`.
    pub fn text(&self, text: &str, marks: Vec<Mark>) -> Result<Node, PmError> {
        if text.is_empty() {
            return Err(PmError::EmptyText);
        }
        Ok(Node {
            ty: self.text,
            attrs: Vec::new(),
            content: Fragment::default(),
            marks: self.set_from(marks),
            text: Some(text.to_owned()),
        })
    }

    /// `Mark.create`: `given` is the attribute value as Yjs stored it, and
    /// only a map has attributes to read (`value && value[name]`).
    pub fn create_mark(&self, ty: MarkTypeId, given: &Any) -> Result<Mark, PmError> {
        let mark_ty = self.mark_ty(ty);
        let attrs = Self::compute_attrs(mark_ty.name, mark_ty.spec.attrs, |name| match given {
            Any::Map(map) => map.get(name).cloned(),
            _ => None,
        })?;
        Ok(Mark { ty, attrs })
    }

    /// `Mark.setFrom`: stable sort by rank.
    fn set_from(&self, mut marks: Vec<Mark>) -> Vec<Mark> {
        marks.sort_by_key(|m| self.mark_ty(m.ty).rank);
        marks
    }

    /// `NodeType.checkAttrs` for JSON input: a name the type does not declare
    /// is an error.
    pub fn check_node_attrs(&self, ty: NodeTypeId, given: &[(String, Any)]) -> Result<(), PmError> {
        let node_ty = self.node_ty(ty);
        Self::check_declared(node_ty.name, node_ty.spec.attrs, given)
    }

    pub fn check_mark_attrs(&self, ty: MarkTypeId, given: &[(String, Any)]) -> Result<(), PmError> {
        let mark_ty = self.mark_ty(ty);
        Self::check_declared(mark_ty.name, mark_ty.spec.attrs, given)
    }

    fn check_declared(
        owner: &str,
        declared: &[AttrSpec],
        given: &[(String, Any)],
    ) -> Result<(), PmError> {
        match given
            .iter()
            .find(|(name, _)| !declared.iter().any(|a| a.name == name))
        {
            Some((attr, _)) => Err(PmError::UnsupportedAttr {
                owner: owner.to_owned(),
                attr: attr.clone(),
            }),
            None => Ok(()),
        }
    }

    /// `NodeType.createAndFill` with no attributes and no content: the node
    /// with every required child generated, or `None` when it cannot be.
    pub fn create_and_fill(&self, ty: NodeTypeId) -> Option<Node> {
        let node_ty = self.node_ty(ty);
        if node_ty.is_text {
            return None;
        }
        let attrs = self.node_attrs(ty, &[]).ok()?;
        let after = self.content_match(ty).fill_before(&[], true, 0)?;
        Some(Node {
            ty,
            attrs,
            content: Fragment::from_array(after),
            marks: Vec::new(),
            text: None,
        })
    }
}
