//! Construction calls for a tree builder that has the final shape of every node, as html5ever's
//! `TreeSink` does. Nothing here is a DOM method of linkedom.

use super::node::{Attribute, ElementData, NodeId, NodeKind};
use super::tree::Document;

impl Document {
    /// Creates an element with its name, attributes and namespace flag exactly as given.
    pub fn create_element_data(&mut self, data: ElementData) -> NodeId {
        self.alloc(NodeKind::Element(data))
    }

    /// Appends an attribute without the lookup and the front insertion of `setAttribute`.
    pub fn push_attribute(&mut self, id: NodeId, name: &str, value: &str) {
        if let Some(element) = self.element_mut(id) {
            element.attrs.push(Attribute {
                name: name.to_string(),
                value: value.to_string(),
            });
        }
    }

    /// Appends `text` to the data of a text node. Returns false when `id` is not a text node.
    pub fn append_data(&mut self, id: NodeId, text: &str) -> bool {
        match &mut self.node_mut(id).kind {
            NodeKind::Text(data) => {
                data.push_str(text);
                true
            }
            _ => false,
        }
    }
}
