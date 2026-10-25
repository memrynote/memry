//! The arena DOM: linkedom's tree as Defuddle sees it, built by a port of htmlparser2.

pub mod element;
pub mod node;
mod parse;
pub mod query;
pub mod selector;
pub mod serialize;
pub mod tree;

pub use node::{Attribute, NodeId, NodeKind};
pub use tree::Document;
