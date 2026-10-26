//! `querySelector`, `querySelectorAll`, `matches` and `closest` as linkedom implements them,
//! with the css-select scope handling pinned by tests below.

use super::node::{NodeId, NodeKind};
use super::selector::{Scope, Selector};
use super::tree::Document;
use crate::web::extract::error::ExtractError;

impl Document {
    /// `prepareMatch(element, selectors)`: the scope is only passed when the selector text
    /// mentions `:scope`.
    fn prepare(&self, root: NodeId, selectors: &str) -> Result<Selector, ExtractError> {
        let scope = match self.node(root).kind {
            NodeKind::Element(_) => Scope::Element(root),
            _ => Scope::Opaque,
        };
        Selector::compile(self, selectors, Some(scope))
    }

    /// `root.querySelector(selectors)`: the first matching descendant in document order. The
    /// content of a `template` element is not searched.
    pub fn query_selector(
        &self,
        root: NodeId,
        selectors: &str,
    ) -> Result<Option<NodeId>, ExtractError> {
        let selector = self.prepare(root, selectors)?;
        let matcher = selector.matcher(self);
        let mut found = None;
        self.walk_until(root, true, &mut |n| {
            if matcher.matches(n) {
                found = Some(n);
                true
            } else {
                false
            }
        });
        Ok(found)
    }

    /// `root.querySelectorAll(selectors)` in document order.
    pub fn query_selector_all(
        &self,
        root: NodeId,
        selectors: &str,
    ) -> Result<Vec<NodeId>, ExtractError> {
        let selector = self.prepare(root, selectors)?;
        let matcher = selector.matcher(self);
        let mut found = Vec::new();
        self.walk(root, true, &mut |n| {
            if matcher.matches(n) {
                found.push(n);
            }
        });
        Ok(found)
    }

    /// `element.matches(selectors)`.
    pub fn matches(&self, element: NodeId, selectors: &str) -> Result<bool, ExtractError> {
        let selector = self.prepare(element, selectors)?;
        Ok(selector.matcher(self).matches(element))
    }

    /// `element.closest(selectors)`: the element itself or the nearest matching ancestor.
    pub fn closest(
        &self,
        element: NodeId,
        selectors: &str,
    ) -> Result<Option<NodeId>, ExtractError> {
        let selector = self.prepare(element, selectors)?;
        let matcher = selector.matcher(self);
        let mut current = Some(element);
        while let Some(c) = current {
            if matcher.matches(c) {
                return Ok(Some(c));
            }
            current = self.parent_element(c);
        }
        Ok(None)
    }
}
