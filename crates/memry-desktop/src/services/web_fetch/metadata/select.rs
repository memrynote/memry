//! The cheerio queries of the metascraper rules (`$(selector)`, `.attr`, `.text`, `$filter`) over
//! the spec tree that `cheerio.load` builds with parse5.
//!
//! The rules use a fixed set of selectors: compounds of a tag and attribute tests, joined by the
//! descendant combinator. [`Sel`] holds them as data, matched with css-select 5.2.2's semantics:
//! attribute names compare exactly, values compare case-sensitively unless the selector carries
//! `i` or the attribute is on css-select's HTML case-insensitive list (`rel`, `type` and
//! `hreflang` among the attributes used here), and the descendant combinator only climbs through
//! element parents, so a `template`'s content has no ancestors.
//!
//! Every query is one pass over the elements in document order, so a query costs the element
//! count however deep the tree is. Text is read only from elements that hold non-whitespace
//! text, and every node visit and text byte copied counts against a per-page budget: a page of
//! nested matches whose text a rule keeps rejecting stops yielding text once the budget is spent,
//! where cheerio's walk would be quadratic.

use std::cell::Cell;

use crate::web::extract::dom::{NodeId, NodeKind};
use crate::web::extract::markdown::turndown::parse::{CapHit, Caps, Dom, parse_page};
use crate::web::extract::utils::js::is_js_whitespace;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
    static PARSE_STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Node visits the queries and text reads of this thread made so far (the complexity guard).
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

/// Nodes the page parses of this thread created and parent links they followed, so far.
pub fn parse_steps() -> usize {
    PARSE_STEPS.with(Cell::get)
}

pub(super) fn step(count: usize) {
    STEPS.with(|steps| steps.set(steps.get().saturating_add(count)));
}

/// What a page may spend reading element text: this many node visits and text bytes copied per
/// node and per byte of the page.
const TEXT_BUDGET_RATIO: usize = 16;

/// The deepest a node of the page may nest ([`Caps::for_page`]).
pub use crate::web::extract::markdown::turndown::parse::PAGE_MAX_DEPTH as MAX_DEPTH;

/// One attribute test of a compound selector.
#[derive(Clone, Copy)]
pub enum Attr {
    /// `[name]`
    Exists(&'static str),
    /// `[name="value"]`, `[name="value" i]` (lowercase `value` when case-insensitive).
    Eq(&'static str, &'static str, bool),
    /// `[name*="value" i]` (every `*=` of the rules carries `i`; `value` is lowercase ASCII).
    Contains(&'static str, &'static str),
    /// `.value`: a whitespace-separated token of `class`, case-sensitive.
    Class(&'static str),
    /// `:not([name="value"])`, case-sensitive.
    NotEq(&'static str, &'static str),
}

/// A compound selector: an optional tag name and attribute tests.
#[derive(Clone, Copy)]
pub struct Compound(pub Option<&'static str>, pub &'static [Attr]);

/// A selector: compounds joined by the descendant combinator, the subject last.
#[derive(Clone, Copy)]
pub struct Sel(pub &'static [Compound]);

/// css-select's `caseInsensitiveAttributes` entries that the rules query.
const CASE_INSENSITIVE: &[&str] = &["rel", "type", "hreflang"];

struct Elem {
    id: NodeId,
    /// The parent when it is an element (css-select's `getElementParent`).
    parent: Option<u32>,
    /// The nearest element ancestor through any node, template content included (`textContent`).
    owner: Option<u32>,
    /// Some node below it, template content included, is non-whitespace text.
    nonblank: bool,
}

/// A parsed page and its elements in document order.
pub struct Page {
    dom: Dom,
    elems: Vec<Elem>,
    text_budget: Cell<usize>,
}

impl Page {
    /// `cheerio.load(html)`: parse5 with scripting on, within the depth, node and time caps.
    pub fn load(html: &str) -> Result<Page, CapHit> {
        let caps = Caps::for_page(html.len());
        let (dom, steps) = parse_page(html, caps).inspect_err(|hit| {
            tracing::warn!(?hit, "metadata page parse stopped at a cap");
        })?;
        PARSE_STEPS.with(|count| count.set(count.get().saturating_add(steps)));
        let mut elems: Vec<Elem> = Vec::new();
        // (node, element parent for selectors, element ancestor for text)
        let mut stack = vec![(dom.doc.root(), None::<u32>, None::<u32>)];
        let mut visits = 0usize;
        while let Some((node, sel_parent, text_owner)) = stack.pop() {
            visits += 1;
            let mut child_sel_parent = None;
            let mut child_owner = text_owner;
            match &dom.doc.node(node).kind {
                NodeKind::Element(_) => {
                    let index = elems.len() as u32;
                    elems.push(Elem {
                        id: node,
                        parent: sel_parent,
                        owner: text_owner,
                        nonblank: false,
                    });
                    child_sel_parent = Some(index);
                    child_owner = Some(index);
                }
                NodeKind::Text(data) | NodeKind::CData(data) => {
                    if let Some(owner) = text_owner
                        && data.chars().any(|c| !is_js_whitespace(c))
                    {
                        elems[owner as usize].nonblank = true;
                    }
                }
                _ => {}
            }
            // cheerio's parse5 adapter appends a template's content as its child node, which is
            // not an element: its children have no element parent but count for `textContent`.
            let mut children = Vec::new();
            if let Some(&content) = dom.templates.get(&node) {
                children.push((content, None, child_owner));
            }
            let mut child = dom.doc.first_child(node);
            while let Some(id) = child {
                children.push((id, child_sel_parent, child_owner));
                child = dom.doc.next_sibling(id);
            }
            stack.extend(children.into_iter().rev());
        }
        // Children come after their parent in document order, so one reverse pass lifts the
        // non-whitespace flag to every ancestor.
        for index in (0..elems.len()).rev() {
            if elems[index].nonblank
                && let Some(owner) = elems[index].owner
            {
                elems[owner as usize].nonblank = true;
            }
        }
        step(visits);
        let budget = TEXT_BUDGET_RATIO.saturating_mul(visits.saturating_add(html.len()));
        Ok(Page {
            dom,
            elems,
            text_budget: Cell::new(budget),
        })
    }

    /// `$(selector)`: the matching elements in document order.
    pub fn select(&self, sel: Sel) -> Vec<usize> {
        let mut out = Vec::new();
        self.scan(sel, |index| {
            out.push(index);
            true
        });
        out
    }

    /// `$(selector).attr(name)`: the attribute of the first match, which may lack it.
    pub fn attr(&self, sel: Sel, name: &str) -> Option<String> {
        let mut first = None;
        self.scan(sel, |index| {
            first = Some(index);
            false
        });
        first.and_then(|index| self.attr_of(index, name).map(str::to_owned))
    }

    pub fn attr_of(&self, index: usize, name: &str) -> Option<&str> {
        self.attrs(index)
            .iter()
            .find(|attr| attr.name == name)
            .map(|attr| attr.value.as_str())
    }

    /// `$(el).text()` (domutils `textContent`), or `None` once the page's text budget is spent.
    /// An element with only whitespace text gives `""` without a walk.
    pub fn text(&self, index: usize) -> Option<String> {
        let elem = &self.elems[index];
        if !elem.nonblank {
            return Some(String::new());
        }
        let mut out = String::new();
        let mut stack = vec![elem.id];
        while let Some(node) = stack.pop() {
            let kind = &self.dom.doc.node(node).kind;
            let text = match kind {
                NodeKind::Text(data) | NodeKind::CData(data) => Some(data.as_str()),
                _ => None,
            };
            // A visit and the bytes it copies: nested matches each copy the text below them.
            let cost = 1 + text.map_or(0, str::len);
            let budget = self.text_budget.get();
            if cost > budget {
                self.text_budget.set(0);
                return None;
            }
            self.text_budget.set(budget - cost);
            // The work done, counted apart from what the budget charges.
            step(1);
            if let Some(text) = text {
                step(text.len());
                out.push_str(text);
            }
            if matches!(kind, NodeKind::Comment(_)) {
                continue;
            }
            let mut children = Vec::new();
            if let Some(&content) = self.dom.templates.get(&node) {
                children.push(content);
            }
            let mut child = self.dom.doc.first_child(node);
            while let Some(id) = child {
                children.push(id);
                child = self.dom.doc.next_sibling(id);
            }
            stack.extend(children.into_iter().rev());
        }
        Some(out)
    }

    fn attrs(&self, index: usize) -> &[crate::web::extract::dom::Attribute] {
        self.dom.doc.attributes(self.elems[index].id)
    }

    fn matches(&self, index: usize, compound: &Compound) -> bool {
        if let Some(tag) = compound.0
            && self.dom.doc.local_name(self.elems[index].id) != Some(tag)
        {
            return false;
        }
        compound.1.iter().all(|test| self.attr_test(index, test))
    }

    fn attr_test(&self, index: usize, test: &Attr) -> bool {
        match *test {
            Attr::Exists(name) => self.attr_of(index, name).is_some(),
            Attr::Eq(name, value, ci) => self.attr_of(index, name).is_some_and(|attr| {
                if ci || CASE_INSENSITIVE.contains(&name) {
                    attr.encode_utf16().count() == value.len() && attr.to_lowercase() == value
                } else {
                    attr == value
                }
            }),
            // A non-unicode JS `i` regex folds ASCII letters only.
            Attr::Contains(name, value) => self
                .attr_of(index, name)
                .is_some_and(|attr| attr.to_ascii_lowercase().contains(value)),
            Attr::Class(token) => self
                .attr_of(index, "class")
                .is_some_and(|attr| attr.split(is_js_whitespace).any(|t| t == token)),
            Attr::NotEq(name, value) => self.attr_of(index, name) != Some(value),
        }
    }

    /// Calls `found` on each match in document order until it returns false. `prefix[i]` of an
    /// element says that compounds `0..=i` match it or a chain of its element ancestors.
    fn scan(&self, sel: Sel, mut found: impl FnMut(usize) -> bool) {
        let compounds = sel.0;
        let last = compounds.len() - 1;
        let mut prefix: Vec<u8> = vec![0; self.elems.len()];
        let mut visits = 0usize;
        for index in 0..self.elems.len() {
            visits += 1;
            let above = self.elems[index].parent.map_or(0, |p| prefix[p as usize]);
            let mut own = 0u8;
            for (i, compound) in compounds.iter().enumerate() {
                if (i == 0 || above & (1 << (i - 1)) != 0) && self.matches(index, compound) {
                    own |= 1 << i;
                }
            }
            prefix[index] = above | own;
            if own & (1 << last) != 0 && !found(index) {
                break;
            }
        }
        step(visits);
    }
}
