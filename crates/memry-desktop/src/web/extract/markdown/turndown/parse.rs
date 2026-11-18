//! `domino.createDocument(html)`: the spec tree builder Turndown parses its input with, as an
//! html5ever `TreeSink` over the arena DOM.
//!
//! Domino and html5ever both follow the HTML parsing algorithm, so the trees agree. The settings
//! that pin the agreement: scripting is off (domino's body mode has no raw-text `noscript`) and
//! the document has no doctype, so it is in quirks mode in both. Template content lives in a
//! fragment beside the template, as in domino, so it is neither a child nor part of `textContent`.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute as HtmlAttribute, ParseOpts, QualName, parse_document};

use crate::web::extract::dom::node::{Attribute, ElementData};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;

const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

/// A parsed Turndown document: the arena plus the content fragments of its `template` elements.
pub struct Dom {
    pub doc: Document,
    pub templates: HashMap<NodeId, NodeId>,
    /// The error a nested `turndown()` call raised inside a rule: JS lets it unwind through the
    /// rule, so the conversion that owns this document fails with it.
    pub failure: Option<ExtractError>,
}

/// An html5ever handle: the arena id and, for elements, the name the tree builder asks for.
pub struct Handle {
    id: NodeId,
    name: QualName,
}

type Ref = Rc<Handle>;

struct Sink {
    doc: RefCell<Document>,
    templates: RefCell<HashMap<NodeId, NodeId>>,
    /// `annotation-xml` elements whose `encoding` makes them HTML integration points.
    integration_points: RefCell<HashSet<NodeId>>,
    /// The bounds of an untrusted page; Turndown's own input has none.
    guard: Option<Guard>,
}

/// The bounds of an untrusted parse ([`parse_page`]). html5ever scans its stack of open elements
/// for most tags, so 100,000 nested elements cost 10^10 scans; the spec's formatting
/// reconstruction clones every open formatting element for each run of text; and the tokenizer
/// compares each attribute of a tag with every earlier one. The input is fed in chunks and the
/// parse fails at the first chunk past a cap. Once a cap is hit the sink builds nothing more.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    /// The deepest a node may nest, counted from its parent links when it is attached (the
    /// adoption agency moves whole subtrees); template content nests one level below its template.
    pub max_depth: usize,
    pub max_nodes: usize,
    pub deadline: Duration,
}

/// The deepest a node of a fetched page may nest: Blink's `kMaximumHTMLParserDOMTreeDepth`.
pub const PAGE_MAX_DEPTH: usize = 512;

/// The most nodes any page builds.
const PAGE_MAX_NODES: usize = 1 << 22;

/// The longest a parse may run. A chunk of input costs at most a fraction of a second.
const PAGE_PARSE_DEADLINE: Duration = Duration::from_secs(10);

impl Caps {
    /// The caps of `len` bytes of a fetched page. At most `2 * len + 64` nodes: a tag, text run
    /// or comment takes at least one byte, and the elements the parser adds itself (`html`,
    /// `tbody`, a reconstructed `b`) stay within a second one per byte on any page a person
    /// writes.
    pub fn for_page(len: usize) -> Self {
        Self {
            max_depth: PAGE_MAX_DEPTH,
            max_nodes: (2 * len + 64).min(PAGE_MAX_NODES),
            deadline: PAGE_PARSE_DEADLINE,
        }
    }
}

/// The cap a page went past.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapHit {
    TooDeep,
    TooManyNodes,
    TooSlow,
}

/// Input fed to the tree builder at a time; the caps are checked in between.
pub const FEED_CHUNK: usize = 256;

struct Guard {
    caps: Caps,
    nodes: Cell<usize>,
    /// Nodes created and parent links followed, for the complexity tests.
    steps: Cell<usize>,
    hit: Cell<Option<CapHit>>,
    /// Template content fragment -> its template.
    owners: RefCell<HashMap<NodeId, NodeId>>,
    /// A detached node handed out for everything created past a cap.
    spent: NodeId,
}

impl Sink {
    fn handle(&self, id: NodeId, name: QualName) -> Ref {
        Rc::new(Handle { id, name })
    }

    /// The node created past a cap, when one was hit.
    fn spent(&self) -> Option<NodeId> {
        self.guard
            .as_ref()
            .filter(|guard| guard.hit.get().is_some())
            .map(|guard| guard.spent)
    }

    fn count_node(&self) {
        if let Some(guard) = &self.guard {
            guard.steps.set(guard.steps.get() + 1);
            guard.nodes.set(guard.nodes.get() + 1);
            if guard.nodes.get() > guard.caps.max_nodes {
                guard.hit.set(Some(CapHit::TooManyNodes));
            }
        }
    }

    /// Fails the parse when a child of `parent` would nest past the depth cap.
    fn check_depth(&self, doc: &Document, parent: NodeId) {
        let Some(guard) = &self.guard else {
            return;
        };
        let owners = guard.owners.borrow();
        let (mut node, mut depth) = (parent, 0);
        while depth < guard.caps.max_depth {
            guard.steps.set(guard.steps.get() + 1);
            match doc.parent_node(node).or_else(|| owners.get(&node).copied()) {
                Some(up) => (node, depth) = (up, depth + 1),
                None => return,
            }
        }
        guard.hit.set(Some(CapHit::TooDeep));
    }

    fn append_text(&self, parent: NodeId, before: Option<NodeId>, text: &str) {
        let mut doc = self.doc.borrow_mut();
        let neighbor = match before {
            Some(sibling) => doc.previous_sibling(sibling),
            None => doc.last_child(parent),
        };
        if let Some(prev) = neighbor
            && doc.append_data(prev, text)
        {
            return;
        }
        let node = doc.create_text_node(text);
        match before {
            Some(sibling) => doc.insert_before(parent, node, Some(sibling)),
            None => doc.append_child(parent, node),
        }
        .expect("a freshly created node attaches");
        self.count_node();
        self.check_depth(&doc, parent);
    }

    fn attach(&self, parent: NodeId, child: NodeOrText<Ref>, before: Option<NodeId>) {
        if self.spent().is_some() {
            return;
        }
        match child {
            NodeOrText::AppendText(text) => self.append_text(parent, before, &text),
            NodeOrText::AppendNode(node) => {
                let mut doc = self.doc.borrow_mut();
                doc.remove(node.id);
                match before {
                    Some(sibling) => doc.insert_before(parent, node.id, Some(sibling)),
                    None => doc.append_child(parent, node.id),
                }
                .expect("the tree builder only builds acyclic trees");
                self.check_depth(&doc, parent);
            }
        }
    }
}

fn attribute_name(attr: &HtmlAttribute) -> String {
    match &attr.name.prefix {
        // `xmlns` on a foreign element carries the empty prefix; domino names it `xmlns`.
        Some(prefix) if !prefix.is_empty() => format!("{prefix}:{}", attr.name.local),
        _ => attr.name.local.to_string(),
    }
}

impl TreeSink for Sink {
    type Handle = Ref;
    type Output = Dom;
    type ElemName<'a> = &'a QualName;

    fn finish(self) -> Dom {
        Dom {
            doc: self.doc.into_inner(),
            templates: self.templates.into_inner(),
            failure: None,
        }
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> Ref {
        let name = QualName::new(None, html5ever::ns!(), html5ever::local_name!(""));
        self.handle(self.doc.borrow().root(), name)
    }

    fn elem_name<'a>(&'a self, target: &'a Ref) -> &'a QualName {
        &target.name
    }

    fn create_element(
        &self,
        name: QualName,
        attrs: Vec<HtmlAttribute>,
        flags: ElementFlags,
    ) -> Ref {
        if let Some(spent) = self.spent() {
            return self.handle(spent, name);
        }
        self.count_node();
        let mut doc = self.doc.borrow_mut();
        let id = doc.create_element_data(ElementData {
            name: name.local.to_string(),
            attrs: attrs
                .iter()
                .map(|a| Attribute {
                    name: attribute_name(a),
                    value: a.value.to_string(),
                })
                .collect(),
            svg: &*name.ns != HTML_NS,
        });
        if flags.mathml_annotation_xml_integration_point {
            self.integration_points.borrow_mut().insert(id);
        }
        if flags.template {
            let content = doc.create_document_fragment();
            self.templates.borrow_mut().insert(id, content);
            if let Some(guard) = &self.guard {
                guard.owners.borrow_mut().insert(content, id);
            }
        }
        drop(doc);
        self.handle(id, name)
    }

    fn create_comment(&self, text: StrTendril) -> Ref {
        let id = match self.spent() {
            Some(spent) => spent,
            None => {
                self.count_node();
                self.doc.borrow_mut().create_comment(&text)
            }
        };
        self.handle(
            id,
            QualName::new(None, html5ever::ns!(), html5ever::local_name!("")),
        )
    }

    fn create_pi(&self, target: StrTendril, data: StrTendril) -> Ref {
        let id = match self.spent() {
            Some(spent) => spent,
            None => {
                self.count_node();
                self.doc
                    .borrow_mut()
                    .create_comment(&format!("?{target} {data}?"))
            }
        };
        self.handle(
            id,
            QualName::new(None, html5ever::ns!(), html5ever::local_name!("")),
        )
    }

    fn append(&self, parent: &Ref, child: NodeOrText<Ref>) {
        self.attach(parent.id, child, None);
    }

    fn append_based_on_parent_node(
        &self,
        element: &Ref,
        prev_element: &Ref,
        child: NodeOrText<Ref>,
    ) {
        let has_parent = self.doc.borrow().parent_node(element.id).is_some();
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }

    fn append_doctype_to_document(
        &self,
        _name: StrTendril,
        _public_id: StrTendril,
        _system_id: StrTendril,
    ) {
    }

    fn get_template_contents(&self, target: &Ref) -> Ref {
        let name = || QualName::new(None, html5ever::ns!(), html5ever::local_name!(""));
        if let Some(spent) = self.spent() {
            return self.handle(spent, name());
        }
        let content = *self
            .templates
            .borrow()
            .get(&target.id)
            .expect("the tree builder asks only for template elements");
        self.handle(content, name())
    }

    fn is_mathml_annotation_xml_integration_point(&self, handle: &Ref) -> bool {
        self.integration_points.borrow().contains(&handle.id)
    }

    fn same_node(&self, x: &Ref, y: &Ref) -> bool {
        x.id == y.id
    }

    fn set_quirks_mode(&self, _mode: QuirksMode) {}

    fn append_before_sibling(&self, sibling: &Ref, new_node: NodeOrText<Ref>) {
        if self.spent().is_some() {
            return;
        }
        let parent = self
            .doc
            .borrow()
            .parent_node(sibling.id)
            .expect("the tree builder inserts before attached nodes");
        self.attach(parent, new_node, Some(sibling.id));
    }

    fn add_attrs_if_missing(&self, target: &Ref, attrs: Vec<HtmlAttribute>) {
        let mut doc = self.doc.borrow_mut();
        for attr in attrs {
            let name = attribute_name(&attr);
            if !doc.has_attribute(target.id, &name) {
                doc.push_attribute(target.id, &name, &attr.value);
            }
        }
    }

    fn remove_from_parent(&self, target: &Ref) {
        self.doc.borrow_mut().remove(target.id);
    }

    fn reparent_children(&self, node: &Ref, new_parent: &Ref) {
        if self.spent().is_some() {
            return;
        }
        let mut doc = self.doc.borrow_mut();
        while let Some(child) = doc.first_child(node.id) {
            doc.append_child(new_parent.id, child)
                .expect("the tree builder only builds acyclic trees");
        }
        self.check_depth(&doc, new_parent.id);
    }
}

/// `domino.createDocument('<x-turndown id="turndown-root">' + input + '</x-turndown>')`.
pub fn parse(html: &str) -> Dom {
    let sink = Sink {
        doc: RefCell::new(Document::new()),
        templates: RefCell::new(HashMap::new()),
        integration_points: RefCell::new(HashSet::new()),
        guard: None,
    };
    let mut opts = ParseOpts::default();
    opts.tree_builder.scripting_enabled = false;
    parse_document(sink, opts).one(StrTendril::from(html))
}

/// A fetched web page as cheerio loads it (the Inbox metadata scraper): the same tree builder
/// with scripting on, as parse5 under cheerio parses, so `noscript` holds raw text, and within
/// `caps`. Returns the tree and the steps the sink took.
pub fn parse_page(html: &str, caps: Caps) -> Result<(Dom, usize), CapHit> {
    parse_guarded(html, caps, true)
}

/// [`parse`] within `caps`, for Turndown's input when it comes from a fetched page (the Inbox
/// article job): the same tree as `parse`, or the cap it went past.
pub fn parse_capped(html: &str, caps: Caps) -> Result<(Dom, usize), CapHit> {
    parse_guarded(html, caps, false)
}

fn parse_guarded(html: &str, caps: Caps, scripting: bool) -> Result<(Dom, usize), CapHit> {
    let started = Instant::now();
    let mut doc = Document::new();
    let spent = doc.create_document_fragment();
    let sink = Sink {
        doc: RefCell::new(doc),
        templates: RefCell::new(HashMap::new()),
        integration_points: RefCell::new(HashSet::new()),
        guard: Some(Guard {
            caps,
            nodes: Cell::new(0),
            steps: Cell::new(0),
            hit: Cell::new(None),
            owners: RefCell::new(HashMap::new()),
            spent,
        }),
    };
    let mut opts = ParseOpts::default();
    opts.tree_builder.scripting_enabled = scripting;
    let mut parser = parse_document(sink, opts);
    let guard = |parser: &html5ever::Parser<Sink>| -> Result<(), CapHit> {
        let guard = parser.tokenizer.sink.sink.guard.as_ref();
        match guard.and_then(|guard| guard.hit.get()) {
            Some(hit) => Err(hit),
            None if started.elapsed() > caps.deadline => Err(CapHit::TooSlow),
            None => Ok(()),
        }
    };
    let mut rest = html;
    while !rest.is_empty() {
        let mut cut = rest.len().min(FEED_CHUNK);
        while !rest.is_char_boundary(cut) {
            cut += 1;
        }
        let (chunk, tail) = rest.split_at(cut);
        parser.process(StrTendril::from_slice(chunk));
        guard(&parser)?;
        rest = tail;
    }
    let steps = parser
        .tokenizer
        .sink
        .sink
        .guard
        .as_ref()
        .map_or(0, |guard| guard.steps.get());
    let dom = parser.finish();
    Ok((dom, steps))
}
