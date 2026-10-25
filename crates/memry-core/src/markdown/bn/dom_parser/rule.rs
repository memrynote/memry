//! A ProseMirror parse rule (`TagParseRule` / `StyleParseRule`) as data and
//! function pointers. The memry schema's rules are a fixed list, in the order
//! `DOMParser.schemaRules` leaves them, built by [`super::rules`].

use super::DomParser;
use super::error::ParseError;
use crate::markdown::bn::dom::{Dom, NodeId, Selector};
use crate::markdown::pm::{Attrs, Fragment, MarkTypeId, NodeTypeId};

/// What `getAttrs` returned: `false` (the rule does not apply), `null` or
/// `undefined` (it applies and adds no attributes), or an attribute object.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrsResult {
    Reject,
    NoAttrs,
    Attrs(Attrs),
}

pub type GetAttrs = fn(&Dom, NodeId) -> AttrsResult;

/// `rule.getContent(node, schema)`: the content nodes of a matched element. It
/// may clone parts of the tree and parse them with a nested `DOMParser.parse`,
/// so it takes the tree mutably and the parser.
pub type GetContent = fn(&mut Dom, &DomParser, NodeId) -> Result<Fragment, ParseError>;

/// `rule.contentElement`.
pub enum ContentElement {
    /// Absent: the matched element.
    Itself,
    /// A selector string: `dom.querySelector(selector)`; no match is a
    /// `TypeError` in the TypeScript (reading a property of `null`).
    Selector(Selector),
    /// A function returning the element.
    Func(fn(&Dom, NodeId) -> NodeId),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    Node(NodeTypeId),
    Mark(MarkTypeId),
}

pub struct TagRule {
    pub selector: Selector,
    pub target: Target,
    /// `rule.consuming !== false`.
    pub consuming: bool,
    pub skip: bool,
    /// `rule.preserveWhitespace`: only ever `true` or absent here.
    pub preserve_whitespace: Option<bool>,
    pub content_element: ContentElement,
    pub get_content: Option<GetContent>,
    pub get_attrs: Option<GetAttrs>,
}

pub enum StyleTarget {
    Mark(MarkTypeId),
    /// `rule.clearMark`: drop the marks of this type.
    ClearMark(MarkTypeId),
}

pub struct StyleRule {
    /// `rule.style`: a property name, or `name=value` to match one value.
    pub style: &'static str,
    pub target: StyleTarget,
    pub consuming: bool,
    /// `getAttrs(value)` with the declaration's value.
    pub get_attrs: Option<fn(&str) -> AttrsResult>,
}
