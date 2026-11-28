//! Tokens a body already holds as text, made nodes in place: what desktop's
//! editor does on open (`promoteLinkMentionsInSharedDoc` and
//! `promoteDateMentionsInSharedDoc` in `use-editor-sync.ts`) for a body an
//! older build seeded with the tokens as text.
//!
//! Only the run holding a token changes: its text from the first token on is
//! cut, and the nodes and the text between them follow it as siblings, each
//! piece of text with the attributes it had. A concurrent edit before the
//! first token survives. A body with no token to promote is not touched, so
//! the write authors no update: opening a note does not rewrite it.

use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::{
    Any, Out, ReadTxn as _, Text as _, TransactionMut, XmlElementPrelim, XmlElementRef,
    XmlFragment as _, XmlOut, XmlTextPrelim, XmlTextRef,
};

use crate::crdt::blocks::is_inline_node;
use crate::crdt::text_extract::BODY_FRAGMENT;

use super::{InlineToken, Piece, split};

/// Elements that hold blocks or cells, not inline content.
const STRUCTURE: [&str; 8] = [
    "blockGroup",
    "blockContainer",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
    "columnList",
    "column",
];

/// Blocks whose text is literal (`content: 'plain'`).
const LITERAL: [&str; 2] = ["codeBlock", "diagram"];

/// Promotes every token in the body's text, in the caller's transaction, and
/// returns whether anything changed.
pub(crate) fn promote_in(txn: &mut TransactionMut) -> bool {
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return false;
    };
    let mut hosts = Vec::new();
    for child in fragment.children(txn) {
        if let XmlOut::Element(element) = child {
            collect_hosts(txn, &element, &mut hosts);
        }
    }
    let mut changed = false;
    for host in hosts {
        changed |= promote_host(txn, &host);
    }
    changed
}

/// The elements whose own text is a block's inline content: every block's
/// content element but a literal one, and each table cell's paragraph.
fn collect_hosts(txn: &TransactionMut, element: &XmlElementRef, out: &mut Vec<XmlElementRef>) {
    let tag = element.tag().clone();
    let name: &str = tag.as_ref();
    if STRUCTURE.contains(&name) {
        for child in element.children(txn) {
            if let XmlOut::Element(inner) = child {
                collect_hosts(txn, &inner, out);
            }
        }
    } else if !LITERAL.contains(&name) && !is_inline_node(name) && name != "hardBreak" {
        out.push(element.clone());
    }
}

/// Promotes the tokens of each text run directly in `host`, last run first so
/// the indexes before it hold.
fn promote_host(txn: &mut TransactionMut, host: &XmlElementRef) -> bool {
    let runs: Vec<(u32, XmlTextRef)> = (0u32..)
        .zip(host.children(txn))
        .filter_map(|(index, child)| match child {
            XmlOut::Text(run) => Some((index, run)),
            _ => None,
        })
        .collect();
    let mut changed = false;
    for (index, run) in runs.into_iter().rev() {
        changed |= promote_run(txn, host, index, &run);
    }
    changed
}

/// One piece of a promoted run.
enum Pending {
    Text(String, Attrs),
    Node(InlineToken),
}

fn promote_run(
    txn: &mut TransactionMut,
    host: &XmlElementRef,
    index: u32,
    run: &XmlTextRef,
) -> bool {
    let mut pieces: Vec<Pending> = Vec::new();
    // Where in the run, in its offset unit (UTF-8 bytes), the first node goes.
    let mut cut: Option<u32> = None;
    let mut offset = 0u32;
    let Some(chunks) = chunks(txn, run) else {
        return false;
    };
    for (text, attrs) in chunks {
        let cut_text = if unstyled(&attrs) { split(&text) } else { None };
        let Some(cut_text) = cut_text else {
            offset += text.len() as u32;
            if cut.is_some() {
                pieces.push(Pending::Text(text, attrs));
            }
            continue;
        };
        for piece in cut_text {
            match piece {
                Piece::Text(part) => {
                    if cut.is_some() {
                        pieces.push(Pending::Text(part.to_owned(), attrs.clone()));
                    } else {
                        offset += part.len() as u32;
                    }
                }
                Piece::Node(node) => {
                    cut.get_or_insert(offset);
                    pieces.push(Pending::Node(node));
                }
            }
        }
    }
    let Some(cut) = cut else {
        return false;
    };
    let length = run.len(txn);
    run.remove_range(txn, cut, length - cut);
    let mut at = index + 1;
    let mut open: Option<XmlTextRef> = None;
    for piece in pieces {
        match piece {
            Pending::Node(node) => {
                open = None;
                let element = host.insert(txn, at, XmlElementPrelim::empty(node.tag()));
                node.write_attributes(txn, &element);
                at += 1;
            }
            Pending::Text(text, attrs) => {
                let target = match &open {
                    Some(target) => target.clone(),
                    None => {
                        let created = host.insert(txn, at, XmlTextPrelim::new(""));
                        at += 1;
                        open = Some(created.clone());
                        created
                    }
                };
                // Every chunk carries its full attribute set, empty included:
                // a plain insert would inherit the marks of the chunk before.
                let end = target.len(txn);
                target.insert_with_attributes(txn, end, &text, attrs);
            }
        }
    }
    true
}

/// The run's text as chunks of one attribute set each, neighbours with the
/// same set joined, as ProseMirror joins text nodes with the same marks.
/// `None` for a run holding an embed, which y-prosemirror never writes: its
/// offsets are not the text's, so the run is left alone.
fn chunks(txn: &TransactionMut, run: &XmlTextRef) -> Option<Vec<(String, Attrs)>> {
    let mut out: Vec<(String, Attrs)> = Vec::new();
    for chunk in run.diff(txn, YChange::identity) {
        let Out::Any(Any::String(text)) = &chunk.insert else {
            return None;
        };
        let attrs = chunk.attributes.map(|attrs| *attrs).unwrap_or_default();
        match out.last_mut() {
            Some((last, last_attrs)) if *last_attrs == attrs => last.push_str(text),
            _ => out.push((text.to_string(), attrs)),
        }
    }
    Some(out)
}

/// `hasActiveStyle` of a run with no link: no attribute but a text or
/// background colour of `default`.
fn unstyled(attrs: &Attrs) -> bool {
    attrs.iter().all(|(key, value)| {
        let name = key.split_once("--").map_or(key.as_ref(), |(name, _)| name);
        let default = match value {
            Any::Map(map) => {
                map.len() == 1 && map.get("stringValue") == Some(&Any::String("default".into()))
            }
            _ => false,
        };
        matches!(name, "textColor" | "backgroundColor") && default
    })
}
