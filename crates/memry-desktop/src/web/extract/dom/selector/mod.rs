//! A port of css-what 6.2.2 and css-select 5.2.2 as linkedom 0.18.12 calls them.
//!
//! linkedom compiles a selector with `CSSselect.compile`, passing its own DOM adapter, and walks
//! the tree itself. This module reproduces that compile step and the matching functions it
//! returns, including the behaviors that differ from the CSS specification: attribute names match
//! case-sensitively against the authored name, `getAttribute('class')` is `""` for an element
//! without a class attribute, `:scope` rewrites unrelated sub-selectors, and `nth-child` is the
//! only positional pseudo that accepts a formula without `of S`.
//!
//! Where JS would throw while matching a detached element (`:first-child` on an element with no
//! parent calls `.find` on an element), the port answers `false`.

mod attrs;
mod compile;
mod eval;
mod nth;
mod parse;

use std::cell::RefCell;

pub use parse::{Token, parse};

use super::node::NodeId;
use super::tree::Document;
use crate::web::extract::error::ExtractError;

/// What `prepareMatch` passes as `context` when the selector mentions `:scope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// An element: `:scope` matches it.
    Element(NodeId),
    /// A document or fragment: linkedom passes an object that is no element, so `:scope` matches
    /// nothing.
    Opaque,
}

/// A compiled selector, ready to test elements of one document.
pub struct Selector {
    compiled: compile::CompiledSelector,
}

impl Selector {
    /// `CSSselect.compile(selectors, { context: scope, adapter })` through `compileUnsafe` and
    /// `ensureIsTag`.
    pub fn compile(
        doc: &Document,
        selectors: &str,
        scope: Option<Scope>,
    ) -> Result<Selector, ExtractError> {
        Ok(Selector {
            compiled: compile::compile(doc, selectors, scope)?,
        })
    }

    /// The compiled selector is also a function of the scope element: `:scope` descendants and
    /// the `:has` placeholder keep per-run state, so each walk owns a [`Matcher`].
    pub fn matcher<'d>(&'d self, doc: &'d Document) -> Matcher<'d> {
        Matcher {
            selector: self,
            doc,
            state: RefCell::new(eval::State::default()),
        }
    }
}

pub struct Matcher<'d> {
    selector: &'d Selector,
    doc: &'d Document,
    state: RefCell<eval::State>,
}

impl Matcher<'_> {
    /// Whether `element` matches. Non-elements never do.
    pub fn matches(&self, element: NodeId) -> bool {
        self.doc.is_element(element)
            && eval::matches(
                self.doc,
                &self.selector.compiled,
                element,
                &mut self.state.borrow_mut(),
            )
    }
}
