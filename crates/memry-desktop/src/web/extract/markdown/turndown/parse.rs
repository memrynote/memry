//! `domino.createDocument(html)`: the spec tree builder Turndown parses its input with, as an
//! html5ever `TreeSink` over the arena DOM.
//!
//! Domino and html5ever both follow the HTML parsing algorithm, so the trees agree. The settings
//! that pin the agreement: scripting is off (domino's body mode has no raw-text `noscript`) and
//! the document has no doctype, so it is in quirks mode in both. Template content lives in a
//! fragment beside the template, as in domino, so it is neither a child nor part of `textContent`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

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
}

impl Sink {
    fn handle(&self, id: NodeId, name: QualName) -> Ref {
        Rc::new(Handle { id, name })
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
    }

    fn attach(&self, parent: NodeId, child: NodeOrText<Ref>, before: Option<NodeId>) {
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
            }
        }
    }
}

fn attribute_name(attr: &HtmlAttribute) -> String {
    match &attr.name.prefix {
        Some(prefix) => format!("{prefix}:{}", attr.name.local),
        None => attr.name.local.to_string(),
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
        if flags.template {
            let content = doc.create_document_fragment();
            self.templates.borrow_mut().insert(id, content);
        }
        drop(doc);
        self.handle(id, name)
    }

    fn create_comment(&self, text: StrTendril) -> Ref {
        let id = self.doc.borrow_mut().create_comment(&text);
        self.handle(
            id,
            QualName::new(None, html5ever::ns!(), html5ever::local_name!("")),
        )
    }

    fn create_pi(&self, target: StrTendril, data: StrTendril) -> Ref {
        let id = self
            .doc
            .borrow_mut()
            .create_comment(&format!("?{target} {data}?"));
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
        let content = *self
            .templates
            .borrow()
            .get(&target.id)
            .expect("the tree builder asks only for template elements");
        self.handle(
            content,
            QualName::new(None, html5ever::ns!(), html5ever::local_name!("")),
        )
    }

    fn same_node(&self, x: &Ref, y: &Ref) -> bool {
        x.id == y.id
    }

    fn set_quirks_mode(&self, _mode: QuirksMode) {}

    fn append_before_sibling(&self, sibling: &Ref, new_node: NodeOrText<Ref>) {
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
        let mut doc = self.doc.borrow_mut();
        while let Some(child) = doc.first_child(node.id) {
            doc.append_child(new_parent.id, child)
                .expect("the tree builder only builds acyclic trees");
        }
    }
}

/// `domino.createDocument('<x-turndown id="turndown-root">' + input + '</x-turndown>')`.
pub fn parse(html: &str) -> Dom {
    let sink = Sink {
        doc: RefCell::new(Document::new()),
        templates: RefCell::new(HashMap::new()),
    };
    let mut opts = ParseOpts::default();
    opts.tree_builder.scripting_enabled = false;
    parse_document(sink, opts).one(StrTendril::from(html))
}
