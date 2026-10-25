//! html5ever tree builder over the arena [`Dom`].

use std::borrow::Cow;
use std::cell::RefCell;

use html5ever::interface::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{Attribute, QualName, local_name, ns, parse_fragment};
use markup5ever::interface::ElemName;
use markup5ever::{LocalName, Namespace};

use super::{Dom, Element, NodeData, NodeId, Ns};

/// An element name that owns its atoms, so `elem_name` can hand one out while
/// the DOM sits behind a `RefCell`.
#[derive(Debug)]
struct Name(QualName);

impl ElemName for Name {
    fn ns(&self) -> &Namespace {
        &self.0.ns
    }

    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}

struct Sink {
    dom: RefCell<Dom>,
    document: NodeId,
}

impl Sink {
    fn new_node(&self, data: NodeData) -> NodeId {
        let mut dom = self.dom.borrow_mut();
        let id = dom.alloc(data);
        dom.nodes[id].parent = None;
        id
    }

    /// `NodeOrText`, merging a text run into a text node that already ends the list.
    fn place(
        &self,
        child: NodeOrText<NodeId>,
        neighbour: Option<NodeId>,
        insert: impl FnOnce(&mut Dom, NodeId),
    ) {
        let node = match child {
            NodeOrText::AppendText(text) => {
                if let Some(prev) = neighbour {
                    let mut dom = self.dom.borrow_mut();
                    if let NodeData::Text(existing) = &mut dom.nodes[prev].data {
                        existing.push_str(&text);
                        return;
                    }
                }
                self.new_node(NodeData::Text(text.to_string()))
            }
            NodeOrText::AppendNode(node) => node,
        };
        insert(&mut self.dom.borrow_mut(), node);
    }
}

fn namespace(ns: &Namespace) -> Ns {
    if *ns == ns!(svg) {
        Ns::Svg
    } else if *ns == ns!(mathml) {
        Ns::MathMl
    } else {
        Ns::Html
    }
}

impl TreeSink for Sink {
    type Handle = NodeId;
    type Output = Dom;
    type ElemName<'a> = Name;

    fn finish(self) -> Dom {
        self.dom.into_inner()
    }

    fn parse_error(&self, _: Cow<'static, str>) {}

    fn get_document(&self) -> NodeId {
        self.document
    }

    fn elem_name<'a>(&'a self, target: &'a NodeId) -> Name {
        let dom = self.dom.borrow();
        let Some(el) = dom.element(*target) else {
            panic!("elem_name of a node that is not an element");
        };
        let ns = match el.ns {
            Ns::Html => ns!(html),
            Ns::Svg => ns!(svg),
            Ns::MathMl => ns!(mathml),
        };
        Name(QualName::new(None, ns, LocalName::from(el.name.as_str())))
    }

    fn set_quirks_mode(&self, _: QuirksMode) {}

    fn same_node(&self, x: &NodeId, y: &NodeId) -> bool {
        x == y
    }

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        self.dom
            .borrow()
            .element(*target)
            .and_then(|el| el.template_content)
            .expect("template element has content")
    }

    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> NodeId {
        let template_content = flags.template.then(|| self.new_node(NodeData::Document));
        self.new_node(NodeData::Element(Element {
            name: name.local.to_string(),
            ns: namespace(&name.ns),
            attrs: attrs
                .into_iter()
                .map(|a| (a.name.local.to_string(), a.value.to_string()))
                .collect(),
            template_content,
        }))
    }

    fn create_comment(&self, text: StrTendril) -> NodeId {
        self.new_node(NodeData::Comment(text.to_string()))
    }

    // A processing instruction in HTML is a bogus comment; the tree builder
    // never calls this for HTML input, and the tokenizer already produced the
    // comment form.
    fn create_pi(&self, target: StrTendril, data: StrTendril) -> NodeId {
        self.new_node(NodeData::Comment(format!("{target} {data}")))
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        let last = self.dom.borrow().children(*parent).last().copied();
        self.place(child, last, |dom, node| dom.append_child(*parent, node));
    }

    fn append_before_sibling(&self, sibling: &NodeId, child: NodeOrText<NodeId>) {
        let prev = self.dom.borrow().previous_sibling(*sibling);
        self.place(child, prev, |dom, node| {
            dom.detach(node);
            let parent = dom.nodes[*sibling].parent.expect("sibling has a parent");
            let at = dom.nodes[parent]
                .children
                .iter()
                .position(|c| c == sibling)
                .expect("sibling is a child");
            dom.nodes[parent].children.insert(at, node);
            dom.nodes[node].parent = Some(parent);
        });
    }

    fn append_based_on_parent_node(
        &self,
        element: &NodeId,
        prev_element: &NodeId,
        child: NodeOrText<NodeId>,
    ) {
        if self.dom.borrow().parent(*element).is_some() {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }

    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<Attribute>) {
        let mut dom = self.dom.borrow_mut();
        if let NodeData::Element(el) = &mut dom.nodes[*target].data {
            for attr in attrs {
                let name = attr.name.local.to_string();
                if !el.attrs.iter().any(|(n, _)| *n == name) {
                    el.attrs.push((name, attr.value.to_string()));
                }
            }
        }
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.dom.borrow_mut().detach(*target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        let mut dom = self.dom.borrow_mut();
        for child in dom.nodes[*node].children.clone() {
            dom.append_child(*new_parent, child);
        }
    }
}

/// `div.innerHTML = html` on a fresh `div`: parse `html` as a fragment with a
/// `div` context and return the DOM with the `div` as its returned root.
pub fn parse_fragment_in_div(html: &str) -> (Dom, NodeId) {
    let mut dom = Dom::new();
    let document = dom.create_document();
    let sink = Sink {
        dom: RefCell::new(dom),
        document,
    };
    let mut dom = parse_fragment(
        sink,
        Default::default(),
        QualName::new(None, ns!(html), local_name!("div")),
        Vec::new(),
        true,
    )
    .one(html);
    // The tree builder roots a fragment under a synthetic `html` element.
    let root = dom
        .first_child(document)
        .expect("a fragment parse yields a root element");
    let container = dom.create_element("div");
    for child in dom.children(root).to_vec() {
        dom.append_child(container, child);
    }
    (dom, container)
}
