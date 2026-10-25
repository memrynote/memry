//! Matching of a compiled css-select chain against the arena DOM, through linkedom's adapter
//! (`shared/matches.js`): tags are elements, siblings are the parent's child nodes, text is the
//! data of text nodes only.

use std::collections::{HashMap, HashSet};

use super::compile::{Compiled, CompiledSelector, CtxEntry, NthKind, Simple, Step};
use crate::web::extract::dom::node::{NodeId, NodeKind};
use crate::web::extract::dom::tree::Document;

/// Per-walk state: the current subject of each `:has`, and css-select's `isFalseCache`, which
/// remembers ancestors that failed a top-level descendant combinator.
#[derive(Default)]
pub(super) struct State {
    placeholders: Vec<Option<NodeId>>,
    false_cache: HashMap<usize, HashSet<NodeId>>,
}

pub(super) fn matches(
    doc: &Document,
    selector: &CompiledSelector,
    element: NodeId,
    state: &mut State,
) -> bool {
    eval_compiled(doc, &selector.compiled, element, state)
}

fn eval_compiled(doc: &Document, compiled: &Compiled, element: NodeId, state: &mut State) -> bool {
    match compiled {
        Compiled::True => true,
        Compiled::False => false,
        Compiled::Or(chains) => chains
            .iter()
            .any(|chain| eval_chain(doc, chain, chain.len(), element, state)),
    }
}

/// `adapter.getName`: the lower-cased local name.
fn name_of(doc: &Document, element: NodeId) -> String {
    doc.local_name(element).unwrap_or_default().to_lowercase()
}

/// `adapter.getText`: only text nodes contribute.
fn get_text(doc: &Document, node: NodeId) -> String {
    match &doc.node(node).kind {
        NodeKind::Element(_) => doc
            .child_nodes(node)
            .into_iter()
            .map(|c| get_text(doc, c))
            .collect(),
        NodeKind::Text(data) => data.clone(),
        _ => String::new(),
    }
}

/// `adapter.getSiblings`: the parent's child nodes, `None` for a detached node.
fn siblings(doc: &Document, element: NodeId) -> Option<Vec<NodeId>> {
    doc.parent_node(element).map(|p| doc.child_nodes(p))
}

fn exists_one(doc: &Document, compiled: &Compiled, elements: &[NodeId], state: &mut State) -> bool {
    for &element in elements {
        if !doc.is_element(element) {
            continue;
        }
        if eval_compiled(doc, compiled, element, state) {
            return true;
        }
        let children = doc.child_nodes(element);
        if exists_one(doc, compiled, &children, state) {
            return true;
        }
    }
    false
}

fn next_siblings(doc: &Document, element: NodeId) -> Vec<NodeId> {
    let Some(all) = siblings(doc, element) else {
        return Vec::new();
    };
    if all.len() <= 1 {
        return Vec::new();
    }
    match all.iter().position(|&n| n == element) {
        Some(pos) => all[pos + 1..]
            .iter()
            .copied()
            .filter(|&n| doc.is_element(n))
            .collect(),
        None => Vec::new(),
    }
}

fn nth_position(doc: &Document, element: NodeId, kind: NthKind) -> i64 {
    let Some(all) = siblings(doc, element) else {
        return 0;
    };
    let name = name_of(doc, element);
    let counts = |n: NodeId| match kind {
        NthKind::Child | NthKind::LastChild => doc.is_element(n),
        NthKind::OfType | NthKind::LastOfType => doc.is_element(n) && name_of(doc, n) == name,
    };
    let mut pos = 0;
    let ordered: Box<dyn Iterator<Item = &NodeId>> = match kind {
        NthKind::Child | NthKind::OfType => Box::new(all.iter()),
        NthKind::LastChild | NthKind::LastOfType => Box::new(all.iter().rev()),
    };
    for &n in ordered {
        if n == element {
            break;
        }
        if counts(n) {
            pos += 1;
        }
    }
    pos
}

fn simple(doc: &Document, element: NodeId, which: Simple) -> bool {
    if which == Simple::Empty {
        return !doc
            .child_nodes(element)
            .into_iter()
            .any(|c| doc.is_element(c) || !get_text(doc, c).is_empty());
    }
    // A detached element has no sibling list; JS throws or answers false, the port answers false.
    let Some(all) = siblings(doc, element) else {
        return false;
    };
    let name = name_of(doc, element);
    match which {
        Simple::Empty => unreachable!("handled above"),
        Simple::FirstChild => all.iter().find(|&&n| doc.is_element(n)) == Some(&element),
        Simple::LastChild => {
            for &n in all.iter().rev() {
                if n == element {
                    return true;
                }
                if doc.is_element(n) {
                    break;
                }
            }
            false
        }
        Simple::FirstOfType => {
            for &n in &all {
                if n == element {
                    return true;
                }
                if doc.is_element(n) && name_of(doc, n) == name {
                    break;
                }
            }
            false
        }
        Simple::LastOfType => {
            for &n in all.iter().rev() {
                if n == element {
                    return true;
                }
                if doc.is_element(n) && name_of(doc, n) == name {
                    break;
                }
            }
            false
        }
        Simple::OnlyOfType => all
            .iter()
            .all(|&n| n == element || !doc.is_element(n) || name_of(doc, n) != name),
        Simple::OnlyChild => all.iter().all(|&n| n == element || !doc.is_element(n)),
    }
}

fn scope_matches(
    doc: &Document,
    context: &Option<Vec<CtxEntry>>,
    element: NodeId,
    state: &State,
) -> bool {
    let entry_is = |entry: &CtxEntry| match entry {
        CtxEntry::Node(n) => *n == element,
        CtxEntry::Placeholder(slot) => {
            state.placeholders.get(*slot).copied().flatten() == Some(element)
        }
        CtxEntry::Opaque => false,
    };
    match context {
        Some(entries) if !entries.is_empty() => entries.iter().any(entry_is),
        // Equivalent to `:root`.
        _ => doc.parent_element(element).is_none(),
    }
}

fn eval_chain(
    doc: &Document,
    steps: &[Step],
    count: usize,
    element: NodeId,
    state: &mut State,
) -> bool {
    if count == 0 {
        return true;
    }
    let step = &steps[count - 1];
    let next = |target: NodeId, state: &mut State| eval_chain(doc, steps, count - 1, target, state);
    match step {
        Step::Tag(name) => name_of(doc, element) == *name && next(element, state),
        Step::Attr { name, rule } => {
            let ok = match rule {
                super::attrs::AttrRule::Exists => doc.has_attribute(element, name),
                _ => rule.test(doc.get_attribute(element, name).as_deref()),
            };
            ok && next(element, state)
        }
        Step::Is(selector) => {
            eval_compiled(doc, &selector.compiled, element, state) && next(element, state)
        }
        Step::Not(selector) => {
            !eval_compiled(doc, &selector.compiled, element, state) && next(element, state)
        }
        Step::Has { selector, slot } => {
            if !next(element, state) {
                return false;
            }
            let mut candidates = doc.child_nodes(element);
            if let Some(slot) = slot {
                if state.placeholders.len() <= *slot {
                    state.placeholders.resize(*slot + 1, None);
                }
                state.placeholders[*slot] = Some(element);
                if selector.should_test_next_siblings {
                    candidates.extend(next_siblings(doc, element));
                }
            }
            exists_one(doc, &selector.compiled, &candidates, state)
        }
        Step::Scope(context) => scope_matches(doc, context, element, state) && next(element, state),
        Step::Root => doc.parent_element(element).is_none() && next(element, state),
        Step::Contains(text) => {
            next(element, state) && get_text(doc, element).contains(text.as_str())
        }
        Step::IContains(text) => {
            next(element, state)
                && get_text(doc, element)
                    .to_lowercase()
                    .contains(text.as_str())
        }
        Step::Nth { kind, check } => {
            check.matches(nth_position(doc, element, *kind)) && next(element, state)
        }
        Step::ParentIsTag => doc.parent_element(element).is_some() && next(element, state),
        Step::Simple(which) => simple(doc, element, *which) && next(element, state),
        Step::Descendant { cache } => {
            let mut current = element;
            while let Some(parent) = doc.parent_element(current) {
                current = parent;
                if let Some(id) = cache {
                    if state
                        .false_cache
                        .get(id)
                        .is_some_and(|set| set.contains(&current))
                    {
                        continue;
                    }
                    if next(current, state) {
                        return true;
                    }
                    state.false_cache.entry(*id).or_default().insert(current);
                } else if next(current, state) {
                    return true;
                }
            }
            false
        }
        Step::FlexibleDescendant => {
            let mut current = element;
            loop {
                if next(current, state) {
                    return true;
                }
                match doc.parent_element(current) {
                    Some(parent) => current = parent,
                    None => return false,
                }
            }
        }
        Step::Parent => {
            let children = doc.child_nodes(element);
            children
                .into_iter()
                .any(|c| doc.is_element(c) && next(c, state))
        }
        Step::Child => doc
            .parent_element(element)
            .is_some_and(|parent| next(parent, state)),
        Step::Sibling => {
            let Some(all) = siblings(doc, element) else {
                return false;
            };
            for sibling in all {
                if sibling == element {
                    break;
                }
                if doc.is_element(sibling) && next(sibling, state) {
                    return true;
                }
            }
            false
        }
        Step::Adjacent => {
            let Some(all) = siblings(doc, element) else {
                return false;
            };
            let mut last = None;
            for sibling in all {
                if sibling == element {
                    break;
                }
                if doc.is_element(sibling) {
                    last = Some(sibling);
                }
            }
            last.is_some_and(|previous| next(previous, state))
        }
    }
}
