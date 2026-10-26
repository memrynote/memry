//! `compareDocumentPosition` as linkedom 0.18.12 implements it. It compares the depth of the two
//! nodes first and only looks at sibling order when the depths are equal, so it disagrees with
//! the DOM specification for a shallow node in a later branch; Defuddle's output depends on it.

use super::node::NodeId;
use super::tree::Document;

pub const POSITION_DISCONNECTED: u8 = 0x01;
pub const POSITION_PRECEDING: u8 = 0x02;
pub const POSITION_FOLLOWING: u8 = 0x04;
pub const POSITION_CONTAINS: u8 = 0x08;
pub const POSITION_CONTAINED_BY: u8 = 0x10;
pub const POSITION_IMPLEMENTATION_SPECIFIC: u8 = 0x20;

impl Document {
    /// `getParentNodeCount`: the number of ancestors, the document node included.
    fn parent_node_count(&self, id: NodeId) -> usize {
        let mut count = 0;
        let mut current = self.parent_node(id);
        while let Some(parent) = current {
            count += 1;
            current = self.parent_node(parent);
        }
        count
    }

    /// `node.childNodes.indexOf(child)` for a child of `node`.
    fn child_index(&self, node: NodeId, child: NodeId) -> Option<usize> {
        let mut index = 0;
        let mut next = self.first_child(node);
        while let Some(c) = next {
            if c == child {
                return Some(index);
            }
            index += 1;
            next = self.next_sibling(c);
        }
        None
    }

    /// `this.compareDocumentPosition(target)`.
    pub fn compare_document_position(&self, this: NodeId, target: NodeId) -> u8 {
        if this == target {
            return 0;
        }
        let mut result = 0;
        let own = self.parent_node_count(this);
        let other = self.parent_node_count(target);
        if own < other {
            result += POSITION_FOLLOWING;
            if self.contains(this, target) {
                result += POSITION_CONTAINED_BY;
            }
        } else if other < own {
            result += POSITION_PRECEDING;
            if self.contains(target, this) {
                result += POSITION_CONTAINS;
            }
        } else if own != 0 && other != 0 {
            // Same depth: the index of `target` in *this* node's parent, which is -1 when the
            // parents differ, so a node in another branch always reads as preceding.
            let parent = self.parent_node(this).expect("depth is non-zero");
            let this_index = self.child_index(parent, this);
            let target_index = self.child_index(parent, target);
            let before = match (this_index, target_index) {
                (Some(a), Some(b)) => a < b,
                _ => false,
            };
            result += if before {
                POSITION_FOLLOWING
            } else {
                POSITION_PRECEDING
            };
        }
        if own == 0 || other == 0 {
            result += POSITION_IMPLEMENTATION_SPECIFIC + POSITION_DISCONNECTED;
        }
        result
    }
}
