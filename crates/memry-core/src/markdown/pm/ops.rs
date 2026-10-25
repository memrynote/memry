//! The rest of `Node`, `Fragment` and `Mark` that the DOM parse needs and that
//! depend on the schema: sizes, `Fragment.cut`, `append`, `Mark.addToSet`.
//!
//! Positions and sizes count UTF-16 code units, as ProseMirror's do, because
//! `Fragment.cut` positions come from `nodeSize` arithmetic in the callers.

use super::model::{Fragment, Mark, Node};
use super::schema::Schema;

/// `String.length`.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(from, to)` over UTF-16 offsets. An offset inside a surrogate
/// pair would split a character; the callers only cut at node boundaries, so
/// the split part is dropped.
fn utf16_slice(text: &str, from: usize, to: usize) -> String {
    let mut out = String::new();
    let mut at = 0;
    for c in text.chars() {
        let end = at + c.len_utf16();
        if at >= from && end <= to {
            out.push(c);
        }
        at = end;
    }
    out
}

impl Schema {
    /// `Node.nodeSize`.
    pub fn node_size(&self, node: &Node) -> usize {
        if let Some(text) = &node.text {
            utf16_len(text)
        } else if self.node_ty(node.ty).is_leaf {
            1
        } else {
            2 + self.fragment_size(&node.content)
        }
    }

    pub fn fragment_size(&self, fragment: &Fragment) -> usize {
        fragment.nodes().iter().map(|n| self.node_size(n)).sum()
    }

    /// `NodeType.isTextblock`.
    pub fn is_textblock(&self, node: &Node) -> bool {
        let ty = self.node_ty(node.ty);
        !ty.is_inline && ty.inline_content
    }

    /// `Node.cut(from, to)`.
    pub fn cut_node(&self, node: &Node, from: usize, to: usize) -> Node {
        if let Some(text) = &node.text {
            if from == 0 && to >= utf16_len(text) {
                return node.clone();
            }
            return Node {
                text: Some(utf16_slice(text, from, to)),
                ..node.clone()
            };
        }
        if from == 0 && to == self.fragment_size(&node.content) {
            return node.clone();
        }
        Node {
            content: self.cut_fragment(&node.content, from, to),
            ..node.clone()
        }
    }

    /// `Fragment.cut(from, to)`.
    pub fn cut_fragment(&self, fragment: &Fragment, from: usize, to: usize) -> Fragment {
        let size = self.fragment_size(fragment);
        if from == 0 && to == size {
            return fragment.clone();
        }
        let mut result = Vec::new();
        let mut pos = 0;
        for child in fragment.nodes() {
            if pos >= to {
                break;
            }
            let end = pos + self.node_size(child);
            if end > from {
                let kept = if pos < from || end > to {
                    if child.is_text() {
                        self.cut_node(
                            child,
                            from.saturating_sub(pos),
                            utf16_len(child.text.as_deref().unwrap_or("")).min(to - pos),
                        )
                    } else {
                        self.cut_node(
                            child,
                            from.saturating_sub(pos + 1),
                            self.fragment_size(&child.content)
                                .min((to - pos).saturating_sub(1)),
                        )
                    }
                } else {
                    child.clone()
                };
                result.push(kept);
            }
            pos = end;
        }
        Fragment::from_array(result)
    }

    /// `Fragment.cut(from)`.
    pub fn cut_fragment_from(&self, fragment: &Fragment, from: usize) -> Fragment {
        self.cut_fragment(fragment, from, self.fragment_size(fragment))
    }

    /// `Fragment.append(other)`: texts of equal markup at the seam join.
    pub fn append_fragment(&self, a: &Fragment, b: &Fragment) -> Fragment {
        let mut nodes = a.nodes().to_vec();
        nodes.extend(b.nodes().iter().cloned());
        Fragment::from_array(nodes)
    }

    /// `Fragment.addToEnd(node)`.
    pub fn add_to_end(&self, fragment: &Fragment, node: Node) -> Fragment {
        let mut nodes = fragment.nodes().to_vec();
        nodes.push(node);
        Fragment::from_array(nodes)
    }

    /// `Mark.addToSet`: `set` is ordered by rank and free of excluded pairs.
    pub fn add_mark_to_set(&self, mark: &Mark, set: &[Mark]) -> Vec<Mark> {
        let mut copy: Option<Vec<Mark>> = None;
        let mut placed = false;
        for (i, other) in set.iter().enumerate() {
            if mark == other {
                return set.to_vec();
            }
            if self.mark_excludes(mark.ty, other.ty) {
                copy.get_or_insert_with(|| set[..i].to_vec());
            } else if self.mark_excludes(other.ty, mark.ty) {
                return set.to_vec();
            } else {
                if !placed && self.mark_ty(other.ty).rank > self.mark_ty(mark.ty).rank {
                    let list = copy.get_or_insert_with(|| set[..i].to_vec());
                    list.push(mark.clone());
                    placed = true;
                }
                if let Some(list) = &mut copy {
                    list.push(other.clone());
                }
            }
        }
        let mut copy = copy.unwrap_or_else(|| set.to_vec());
        if !placed {
            copy.push(mark.clone());
        }
        copy
    }

    /// `NodeType.allowsMarkType`: no node of the memry schema restricts its marks.
    pub fn allows_mark_type(&self, node: crate::markdown::pm::NodeTypeId) -> bool {
        self.node_ty(node).all_marks
    }
}

impl Node {
    /// `Node.textContent`.
    pub fn text_content(&self) -> String {
        match &self.text {
            Some(text) => text.clone(),
            None => self.children().iter().map(Node::text_content).collect(),
        }
    }
}
