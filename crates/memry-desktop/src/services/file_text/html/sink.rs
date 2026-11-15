//! The html5ever tree sink that builds [`Tree`] under the node budget and the depth cap, and
//! [`parse`], which feeds it in chunks and checks the caps, the deadline and the stop between.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use html5ever::tendril::{StrTendril, TendrilSink as _};
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, ParseOpts, QualName, local_name, ns, parse_document};

use super::{DOCUMENT, FEED_CHUNK, HtmlTextError, Id, Kind, MAX_DEPTH, Node, Tree, classify, step};

/// A tree-builder handle. `id` is `None` for a node created past the budget: the parse is
/// abandoned at the end of the chunk, so it is never attached.
struct Handle {
    id: Option<Id>,
    name: QualName,
    integration_point: bool,
    template: Option<Id>,
}

type Ref = Rc<Handle>;

struct Sink {
    tree: RefCell<Tree>,
    budget: usize,
    over: Cell<Option<HtmlTextError>>,
}

fn unnamed() -> QualName {
    QualName::new(None, ns!(), local_name!(""))
}

impl Sink {
    fn create(&self, kind: Kind) -> Option<Id> {
        step();
        let mut tree = self.tree.borrow_mut();
        let len = tree.nodes.len();
        if len >= self.budget {
            self.over
                .set(Some(HtmlTextError::TooManyNodes { limit: self.budget }));
            return None;
        }
        // Grow by doubling, but never past the budget.
        if len == tree.nodes.capacity() {
            tree.nodes.reserve_exact(len.max(64).min(self.budget - len));
        }
        tree.nodes.push(Node {
            kind,
            parent: None,
            first_child: None,
            last_child: None,
            prev: None,
            next: None,
        });
        // `len < budget <= MAX_NODES`, so the id fits.
        Id::new(len as u32 + 1)
    }

    fn create_text(&self, text: &str) -> Option<Id> {
        let start = self.tree.borrow().text.len();
        let id = self.create(Kind::Text {
            start: start as u32,
            end: (start + text.len()) as u32,
        })?;
        self.tree.borrow_mut().text.push_str(text);
        Some(id)
    }

    fn handle(&self, id: Option<Id>, name: QualName) -> Ref {
        Rc::new(Handle {
            id,
            name,
            integration_point: false,
            template: None,
        })
    }

    /// Fails the parse when a child of `parent` would nest past [`MAX_DEPTH`].
    fn check_depth(&self, tree: &Tree, parent: Id) {
        if tree.depth(parent) + 1 > MAX_DEPTH {
            self.over.set(Some(HtmlTextError::TooDeep));
        }
    }

    fn attach(&self, parent: Option<Id>, child: NodeOrText<Ref>, before: Option<Id>) {
        let Some(parent) = parent else {
            return;
        };
        let id = match child {
            NodeOrText::AppendNode(node) => node.id,
            NodeOrText::AppendText(text) => self.create_text(&text),
        };
        if let Some(id) = id {
            let mut tree = self.tree.borrow_mut();
            tree.insert(parent, id, before);
            self.check_depth(&tree, parent);
        }
    }
}

impl TreeSink for Sink {
    type Handle = Ref;
    type Output = Result<Tree, HtmlTextError>;
    type ElemName<'a> = &'a QualName;

    fn finish(self) -> Result<Tree, HtmlTextError> {
        match self.over.into_inner() {
            Some(error) => Err(error),
            None => Ok(self.tree.into_inner()),
        }
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> Ref {
        self.handle(Some(DOCUMENT), unnamed())
    }

    fn elem_name<'a>(&'a self, target: &'a Ref) -> &'a QualName {
        &target.name
    }

    fn create_element(&self, name: QualName, _: Vec<Attribute>, flags: ElementFlags) -> Ref {
        let id = self.create(Kind::Element(classify(&name)));
        let template = match id {
            Some(id) if flags.template => self.create(Kind::Contents(id)),
            _ => None,
        };
        Rc::new(Handle {
            id,
            name,
            integration_point: flags.mathml_annotation_xml_integration_point,
            template,
        })
    }

    fn create_comment(&self, _: StrTendril) -> Ref {
        self.handle(self.create(Kind::Other), unnamed())
    }

    fn create_pi(&self, _: StrTendril, _: StrTendril) -> Ref {
        self.handle(self.create(Kind::Other), unnamed())
    }

    fn append(&self, parent: &Ref, child: NodeOrText<Ref>) {
        self.attach(parent.id, child, None);
    }

    fn append_based_on_parent_node(&self, element: &Ref, prev: &Ref, child: NodeOrText<Ref>) {
        let has_parent = element
            .id
            .is_some_and(|id| self.tree.borrow().node(id).parent.is_some());
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev, child);
        }
    }

    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}

    fn get_template_contents(&self, target: &Ref) -> Ref {
        self.handle(target.template, unnamed())
    }

    fn is_mathml_annotation_xml_integration_point(&self, handle: &Ref) -> bool {
        handle.integration_point
    }

    fn same_node(&self, x: &Ref, y: &Ref) -> bool {
        Rc::ptr_eq(x, y) || (x.id.is_some() && x.id == y.id)
    }

    fn set_quirks_mode(&self, _: QuirksMode) {}

    fn append_before_sibling(&self, sibling: &Ref, child: NodeOrText<Ref>) {
        let Some(sibling) = sibling.id else {
            return;
        };
        let parent = self.tree.borrow().node(sibling).parent;
        self.attach(parent, child, Some(sibling));
    }

    fn add_attrs_if_missing(&self, _: &Ref, _: Vec<Attribute>) {}

    fn remove_from_parent(&self, target: &Ref) {
        if let Some(id) = target.id {
            self.tree.borrow_mut().detach(id);
        }
    }

    fn reparent_children(&self, node: &Ref, new_parent: &Ref) {
        let (Some(node), Some(new_parent)) = (node.id, new_parent.id) else {
            return;
        };
        let mut tree = self.tree.borrow_mut();
        if tree.node(node).first_child.is_none() {
            return;
        }
        while let Some(child) = tree.node(node).first_child {
            tree.insert(new_parent, child, None);
        }
        self.check_depth(&tree, new_parent);
    }
}

/// `new JSDOM(html)`: the document tree, scripting off as jsdom parses it. The byte order mark
/// stays, as `Buffer#toString('utf8')` keeps it: as text before `<html>` it starts `body` early.
pub(super) fn parse(
    html: &str,
    budget: usize,
    deadline: Duration,
    stopped: &dyn Fn() -> bool,
) -> Result<Tree, HtmlTextError> {
    let started = Instant::now();
    let sink = Sink {
        tree: RefCell::new(Tree {
            nodes: Vec::new(),
            text: String::new(),
        }),
        budget,
        over: Cell::new(None),
    };
    sink.create(Kind::Other);
    let mut opts = ParseOpts::default();
    opts.tree_builder.scripting_enabled = false;
    opts.tokenizer.discard_bom = false;
    let mut parser = parse_document(sink, opts);
    let mut rest = html;
    while !rest.is_empty() {
        let mut cut = rest.len().min(FEED_CHUNK);
        while !rest.is_char_boundary(cut) {
            cut += 1;
        }
        let (chunk, tail) = rest.split_at(cut);
        parser.process(StrTendril::from_slice(chunk));
        if let Some(error) = parser.tokenizer.sink.sink.over.take() {
            return Err(error);
        }
        if started.elapsed() > deadline {
            return Err(HtmlTextError::TooSlow);
        }
        if stopped() {
            return Err(HtmlTextError::Stopped);
        }
        rest = tail;
    }
    parser.finish()
}
