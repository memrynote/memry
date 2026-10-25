//! Node storage of the arena DOM.
//!
//! The shapes follow what linkedom 0.18.12 exposes to Defuddle: the same node kinds, attributes
//! as an ordered list of exact-case names, and no text-node merging.

/// An index into [`super::Document`]'s arena.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct NodeId(pub(super) u32);

impl NodeId {
    pub(super) fn index(self) -> usize {
        self.0 as usize
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attribute {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct ElementData {
    /// `localName`: lowercase for parsed HTML elements, as authored for created ones.
    pub name: String,
    pub attrs: Vec<Attribute>,
    /// True for the SVG elements linkedom builds inside `<svg>` (`'ownerSVGElement' in element`).
    pub svg: bool,
}

#[derive(Clone, Debug)]
pub struct DoctypeData {
    pub name: String,
    pub public_id: String,
    pub system_id: String,
}

#[derive(Clone, Debug)]
pub enum NodeKind {
    Document,
    Fragment,
    Element(ElementData),
    Text(String),
    Comment(String),
    CData(String),
    Doctype(DoctypeData),
}

/// `Node.nodeType` values.
pub mod node_type {
    pub const ELEMENT: u8 = 1;
    pub const TEXT: u8 = 3;
    pub const CDATA_SECTION: u8 = 4;
    pub const COMMENT: u8 = 8;
    pub const DOCUMENT: u8 = 9;
    pub const DOCUMENT_TYPE: u8 = 10;
    pub const DOCUMENT_FRAGMENT: u8 = 11;
}

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: NodeKind,
    pub(super) parent: Option<NodeId>,
    pub(super) first_child: Option<NodeId>,
    pub(super) last_child: Option<NodeId>,
    pub(super) prev: Option<NodeId>,
    pub(super) next: Option<NodeId>,
}

impl Node {
    pub(super) fn new(kind: NodeKind) -> Self {
        Node {
            kind,
            parent: None,
            first_child: None,
            last_child: None,
            prev: None,
            next: None,
        }
    }

    pub fn node_type(&self) -> u8 {
        match self.kind {
            NodeKind::Element(_) => node_type::ELEMENT,
            NodeKind::Text(_) => node_type::TEXT,
            NodeKind::CData(_) => node_type::CDATA_SECTION,
            NodeKind::Comment(_) => node_type::COMMENT,
            NodeKind::Document => node_type::DOCUMENT,
            NodeKind::Doctype(_) => node_type::DOCUMENT_TYPE,
            NodeKind::Fragment => node_type::DOCUMENT_FRAGMENT,
        }
    }
}
