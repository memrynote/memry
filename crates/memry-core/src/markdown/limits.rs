//! Nesting limits. The converter recurses once per level of nesting (blocks,
//! quotes, lists, HTML elements, Yjs elements), and a stack overflow aborts the
//! process, which `catch_unwind` cannot stop: a 1 KB body of `>` characters
//! would crash-loop the app through the vault watcher. Past [`MAX_NESTING_DEPTH`]
//! the conversion fails closed, as the TypeScript does on a `RangeError`
//! (`status: "error"` in the oracle): the caller keeps the file.
//!
//! The caps sit at the recursion sites, so no shape of input escapes them:
//! block recursion of the markdown parser (quotes, list items) and the HTML
//! tree depth are capped at [`MAX_NESTING_DEPTH`], inline recursion (links and
//! emphasis inside each other) at [`MAX_INLINE_DEPTH`]. Indentation and `>`
//! characters that open no nested block (inside a code fence, past a lazy
//! continuation) are not nesting and are not counted. Real notes nest a few
//! levels; the caps are far above that and far below the depth at which a
//! 2 MiB stack overflows in a debug build.
//!
//! The budget is shared: a quote or an HTML element costs one step and a list
//! level two (the list and its item), so the limits in practice are about 97
//! quotes, 98 elements and 48 list levels.
//!
//! Untrusted structure that is not markdown has its own cap at its recursion:
//! YAML frontmatter (`frontmatter::value::MAX_YAML_DEPTH`) and a Yjs tree from a
//! peer ([`fragment_too_deep`], checked before `replace_body` touches it).

use yrs::{ReadTxn, XmlFragment, XmlFragmentRef, XmlOut};

pub const MAX_NESTING_DEPTH: usize = 100;

/// Largest `colspan` or `rowspan` a table cell may claim. The TypeScript
/// answers a 100000-column span and fails on a million (oracle cases in
/// `markdown_depth.rs`), and a span costs memory in proportion to itself.
pub const MAX_TABLE_SPAN: usize = 100_000;

/// Largest table grid (rows x columns, spans included) the converter builds.
pub const MAX_TABLE_CELLS: usize = 4_000_000;

/// Nesting of inline constructs (links and emphasis inside each other) the
/// markdown parser follows. Each level costs two stack frames; the TypeScript
/// fails at about 3000, a debug build on a 2 MiB thread at about 500.
pub const MAX_INLINE_DEPTH: usize = 200;

thread_local! {
    static DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static EXCEEDED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// One level of recursion. [`DepthGuard::enter`] answers `None` past `limit`
/// and records it; [`take_exceeded`] reports and clears that record, so the
/// entry point of a recursive parser can fail closed without every frame
/// threading an error through.
pub struct DepthGuard;

impl DepthGuard {
    pub fn enter(limit: usize) -> Option<DepthGuard> {
        DEPTH.with(|d| {
            if d.get() >= limit {
                EXCEEDED.with(|e| e.set(true));
                None
            } else {
                d.set(d.get() + 1);
                Some(DepthGuard)
            }
        })
    }
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(d.get() - 1));
    }
}

/// Whether any [`DepthGuard::enter`] failed since the last call; clears it.
pub fn take_exceeded() -> bool {
    EXCEEDED.with(|e| e.replace(false))
}

/// True when the fragment's element tree is deeper than [`MAX_NESTING_DEPTH`].
/// Iterative, so it is safe to run on a tree of any depth.
pub fn fragment_too_deep<T: ReadTxn>(txn: &T, fragment: &XmlFragmentRef) -> bool {
    let mut stack: Vec<(XmlOut, usize)> = fragment.children(txn).map(|c| (c, 1)).collect();
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_NESTING_DEPTH {
            return true;
        }
        if let XmlOut::Element(element) = node {
            stack.extend(element.children(txn).map(|c| (c, depth + 1)));
        }
    }
    false
}
