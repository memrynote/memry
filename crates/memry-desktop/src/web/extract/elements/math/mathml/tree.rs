//! mathml-to-latex's internal element tree (`MathMLElement`) and its two normalizing passes,
//! `FenceNormalizer` and `TableAnnotator`.

use std::collections::HashSet;
use std::sync::LazyLock;

use super::xml::XNode;
use crate::web::extract::utils::js::trim;

/// `{ name, attributes, value, children }`.
#[derive(Clone)]
pub struct MNode {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub value: String,
    pub children: Vec<usize>,
}

impl MNode {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// `!!attributes[name]`.
    pub fn flag(&self, name: &str) -> bool {
        self.attr(name).is_some_and(|v| !v.is_empty())
    }

    fn set_attr(&mut self, name: &str, value: &str) {
        match self.attrs.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value.to_string(),
            None => self.attrs.push((name.to_string(), value.to_string())),
        }
    }
}

#[derive(Default)]
pub struct Tree {
    pub nodes: Vec<MNode>,
}

impl Tree {
    fn add(&mut self, node: MNode) -> usize {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    pub fn node(&self, id: usize) -> &MNode {
        &self.nodes[id]
    }

    /// `ElementsToMathMLAdapter.convert` for one root element, iteratively.
    pub fn build(&mut self, root: &XNode) -> Result<usize, String> {
        let mut result = None;
        let mut stack: Vec<(&XNode, Option<usize>)> = vec![(root, None)];
        while let Some((x, parent)) = stack.pop() {
            let XNode::Element {
                name,
                attrs,
                children,
            } = x
            else {
                if matches!(x, XNode::ProcessingInstruction) {
                    // `Array.from(el.attributes)` of a node without attributes
                    return Err("TypeError: attributes is not iterable".to_string());
                }
                continue;
            };
            let has_element_child = children.iter().any(|c| !matches!(c, XNode::Text(_)));
            let value = if has_element_child {
                String::new()
            } else {
                children
                    .iter()
                    .map(|c| match c {
                        XNode::Text(t) => t.as_str(),
                        _ => "",
                    })
                    .collect()
            };
            let id = self.add(MNode {
                name: name.clone(),
                // `attr.nodeValue === attr.nodeName ? '' : attr.nodeValue`
                attrs: attrs
                    .iter()
                    .map(|(k, v)| (k.clone(), if k == v { String::new() } else { v.clone() }))
                    .collect(),
                value,
                children: Vec::new(),
            });
            match parent {
                Some(p) => self.nodes[p].children.push(id),
                None => result = Some(id),
            }
            if has_element_child {
                for child in children.iter().rev() {
                    stack.push((child, Some(id)));
                }
            }
        }
        Ok(result.expect("root is an element"))
    }

    /// Runs `FenceNormalizer` then `TableAnnotator` over the tree of `root`.
    pub fn normalize(&mut self, root: usize) {
        self.normalize_fences(root);
        self.annotate_tables(root);
    }

    fn normalize_fences(&mut self, root: usize) {
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            if self.nodes[id].children.is_empty() {
                continue;
            }
            let children = self.nodes[id].children.clone();
            if let Some(paired) = self.pair(&children) {
                self.nodes[id].children = paired;
            }
            stack.extend(self.nodes[id].children.iter().copied());
        }
    }

    fn is_mo_in(&self, id: usize, set: &LazyLock<HashSet<&'static str>>) -> bool {
        let n = self.node(id);
        n.name == "mo" && set.contains(trim(&n.value))
    }

    fn is_bar(&self, id: usize) -> bool {
        self.is_mo_in(id, &BARS)
    }

    fn closes_bar(&self, child: usize, top: Option<&Frame>) -> bool {
        let Some(top) = top else { return false };
        self.is_bar(child)
            && self.is_bar(top.opener)
            && trim(&self.node(top.opener).value) == trim(&self.node(child).value)
    }

    fn script_base_closer(&self, child: usize, top: Option<&Frame>) -> Option<usize> {
        let top = top?;
        let node = self.node(child);
        if !self.is_bar(top.opener)
            || !matches!(node.name.as_str(), "msub" | "msup" | "msubsup")
            || node.children.is_empty()
        {
            return None;
        }
        let base = node.children[0];
        let b = self.node(base);
        let bar = if b.name == "mrow" && b.children.len() == 1 {
            b.children[0]
        } else {
            base
        };
        let bar_node = self.node(bar);
        (bar_node.name == "mo" && trim(&bar_node.value) == trim(&self.node(top.opener).value))
            .then_some(bar)
    }

    fn make_fence(&mut self, opener: usize, closer: usize, content: Vec<usize>) -> usize {
        let inner = if content.len() == 1 {
            content[0]
        } else {
            self.add(MNode {
                name: "mrow".into(),
                attrs: Vec::new(),
                value: String::new(),
                children: content,
            })
        };
        let open = trim(&self.node(opener).value).to_string();
        let close = trim(&self.node(closer).value).to_string();
        self.add(MNode {
            name: "mfenced".into(),
            attrs: vec![("open".into(), open), ("close".into(), close)],
            value: String::new(),
            children: vec![inner],
        })
    }

    /// `FencePairing.pair`: `None` when nothing paired (JS returns the same array).
    fn pair(&mut self, children: &[usize]) -> Option<Vec<usize>> {
        let mut root: Vec<usize> = Vec::new();
        let mut frames: Vec<Frame> = Vec::new();
        let mut paired = false;
        fn push(root: &mut Vec<usize>, frames: &mut [Frame], node: usize) {
            match frames.last_mut() {
                Some(frame) => frame.content.push(node),
                None => root.push(node),
            }
        }
        for &child in children {
            let top = frames.last();
            let opens = self.is_mo_in(child, &OPENERS)
                || (self.is_bar(child) && !self.closes_bar(child, top));
            if opens {
                frames.push(Frame {
                    opener: child,
                    content: Vec::new(),
                });
                continue;
            }
            let closes = top.is_some_and(|t| {
                (self.is_mo_in(child, &CLOSERS) && self.is_mo_in(t.opener, &OPENERS))
                    || self.closes_bar(child, Some(t))
            });
            if closes {
                let frame = frames.pop().expect("top frame");
                let fence = self.make_fence(frame.opener, child, frame.content);
                push(&mut root, &mut frames, fence);
                paired = true;
                continue;
            }
            if let Some(closer) = self.script_base_closer(child, frames.last()) {
                let frame = frames.pop().expect("top frame");
                let fence = self.make_fence(frame.opener, closer, frame.content);
                let mut copy = self.node(child).clone();
                copy.children = std::iter::once(fence)
                    .chain(copy.children.iter().skip(1).copied())
                    .collect();
                let id = self.add(copy);
                push(&mut root, &mut frames, id);
                paired = true;
                continue;
            }
            push(&mut root, &mut frames, child);
        }
        if !paired {
            return None;
        }
        for frame in frames {
            root.push(frame.opener);
            root.extend(frame.content);
        }
        Some(root)
    }

    /// `LinearSystemPattern.matches`.
    pub fn is_linear_system(&self, id: usize) -> bool {
        let n = self.node(id);
        if n.name != "mrow" || (n.children.len() != 2 && n.children.len() != 3) {
            return false;
        }
        let opening = self.node(n.children[0]);
        let table = self.node(n.children[1]);
        let closing = n.children.get(2).map(|c| self.node(*c));
        opening.name == "mo"
            && trim(&opening.value) == "{"
            && table.name == "mtable"
            && closing.is_none_or(|c| c.name == "mo" && trim(&c.value).is_empty())
    }

    fn annotate_tables(&mut self, root: usize) {
        let mut stack = vec![(root, false, false)];
        while let Some((id, inside, wrapped)) = stack.pop() {
            let name = self.nodes[id].name.clone();
            if name == "mtable" {
                if inside {
                    self.nodes[id].set_attr("innerTable", "innerTable");
                } else if !wrapped {
                    self.nodes[id].set_attr("bareTable", "bareTable");
                }
            }
            if name == "mtr" && !inside {
                self.nodes[id].set_attr("bareRow", "bareRow");
            }
            let child_inside = inside || name == "mtable";
            let child_wrapped = wrapped || name == "mfenced";
            let linear_table = self
                .is_linear_system(id)
                .then(|| self.nodes[id].children[1]);
            for &child in &self.nodes[id].children {
                stack.push((
                    child,
                    child_inside,
                    child_wrapped || Some(child) == linear_table,
                ));
            }
        }
    }
}

struct Frame {
    opener: usize,
    content: Vec<usize>,
}

static OPENERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| HashSet::from(["(", "[", "{"]));
static CLOSERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| HashSet::from([")", "]", "}"]));
/// `BARS`: `|` and the double-bar glyphs.
static BARS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| HashSet::from(["|", "||", "\u{2016}", "\u{2225}"]));
