//! Seed blocks to the `prosemirror` fragment, in the shape y-prosemirror
//! writes for them: `blockGroup > blockContainer(id) > block [> blockGroup]`,
//! each block with its declared props ([`crate::crdt::node_shapes`]), text as
//! `XmlText` runs with one attribute per mark and a `hardBreak` element
//! between runs.

use std::collections::HashMap;

use yrs::types::xml::XmlFragmentRef;
use yrs::{
    Any, Text as _, TransactionMut, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _,
    XmlTextPrelim, XmlTextRef,
};

use crate::crdt::node_shapes::{self, PropValue};

use super::{SeedBlock, SeedInline, SeedKind, SeedMarks};

/// Writes `blocks` into an empty fragment: one top-level `blockGroup`, empty
/// when there are no blocks, as BlockNote writes an empty document.
pub(super) fn write_blocks(
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
    blocks: &[SeedBlock],
    mint: &mut dyn FnMut() -> String,
) {
    let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
    write_group(txn, &group, blocks, mint);
}

fn write_group(
    txn: &mut TransactionMut,
    group: &XmlElementRef,
    blocks: &[SeedBlock],
    mint: &mut dyn FnMut() -> String,
) {
    for block in blocks {
        let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", mint());
        write_block(txn, &container, block);
        if !block.children.is_empty() {
            let children = container.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            write_group(txn, &children, &block.children, mint);
        }
    }
}

fn kind_name(kind: &SeedKind) -> &'static str {
    match kind {
        SeedKind::Paragraph => "paragraph",
        SeedKind::Heading { .. } => "heading",
        SeedKind::BulletListItem => "bulletListItem",
        SeedKind::NumberedListItem { .. } => "numberedListItem",
        SeedKind::CheckListItem { .. } => "checkListItem",
        SeedKind::Quote => "quote",
        SeedKind::CodeBlock { .. } => "codeBlock",
        SeedKind::Divider => "divider",
    }
}

/// The value one declared prop takes on this block.
fn prop_value(kind: &SeedKind, name: &str, default: &PropValue) -> Any {
    match (kind, name) {
        (SeedKind::Heading { level }, "level") => Any::Number(f64::from(*level)),
        (SeedKind::CheckListItem { checked }, "checked") => Any::Bool(*checked),
        (SeedKind::NumberedListItem { start: Some(start) }, "start") => {
            Any::Number(f64::from(*start))
        }
        (
            SeedKind::CodeBlock {
                language: Some(language),
            },
            "language",
        ) => Any::String(language.as_str().into()),
        _ => default.to_any(),
    }
}

fn write_block(txn: &mut TransactionMut, container: &XmlElementRef, block: &SeedBlock) {
    let name = kind_name(&block.kind);
    let element = container.push_back(txn, XmlElementPrelim::empty(name));
    for prop in node_shapes::defaults_for(name).unwrap_or_default() {
        element.insert_attribute(
            txn,
            prop.name,
            prop_value(&block.kind, prop.name, &prop.value),
        );
    }

    if matches!(block.kind, SeedKind::CodeBlock { .. }) {
        // A code block's content is plain: newlines stay characters.
        let code: String = block
            .content
            .iter()
            .filter_map(|piece| match piece {
                SeedInline::Text { text, .. } => Some(text.as_str()),
                SeedInline::HardBreak => None,
            })
            .collect();
        if !code.is_empty() {
            element.push_back(txn, XmlTextPrelim::new(code.as_str()));
        }
        return;
    }

    let mut run: Option<XmlTextRef> = None;
    for piece in &block.content {
        match piece {
            SeedInline::Text { text, marks } => {
                let target = match &run {
                    Some(target) => target.clone(),
                    None => {
                        let created = element.push_back(txn, XmlTextPrelim::new(""));
                        run = Some(created.clone());
                        created
                    }
                };
                let end = target.len(txn);
                // Every chunk carries its full attribute set, empty included:
                // a plain insert would inherit the marks of the chunk before.
                target.insert_with_attributes(txn, end, text, attributes(marks));
            }
            SeedInline::HardBreak => {
                run = None;
                element.push_back(txn, XmlElementPrelim::empty("hardBreak"));
            }
        }
    }
}

/// y-prosemirror's mark attributes: the mark's `attrs` object, `{}` for a
/// boolean style and `{ href }` for a link.
fn attributes(marks: &SeedMarks) -> yrs::types::Attrs {
    let mut attrs = yrs::types::Attrs::new();
    let empty = || Any::Map(HashMap::<String, Any>::new().into());
    for (on, name) in [
        (marks.bold, "bold"),
        (marks.italic, "italic"),
        (marks.strike, "strike"),
        (marks.code, "code"),
    ] {
        if on {
            attrs.insert(name.into(), empty());
        }
    }
    if let Some(href) = &marks.link {
        let mut link = HashMap::new();
        link.insert("href".to_owned(), Any::String(href.as_str().into()));
        attrs.insert("link".into(), Any::Map(link.into()));
    }
    attrs
}
