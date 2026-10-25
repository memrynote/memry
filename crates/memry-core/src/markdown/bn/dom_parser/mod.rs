//! ProseMirror's `DOMParser` (prosemirror-model 1.25.11 `from_dom.ts`) over the
//! arena DOM, with the memry schema's parse rules.

mod engine;
mod error;
mod rule;
pub mod rules;

pub use engine::{DomParser, ParseOptions};
pub use error::ParseError;
pub use rule::{
    AttrsResult, ContentElement, GetAttrs, GetContent, StyleRule, StyleTarget, TagRule, Target,
};
