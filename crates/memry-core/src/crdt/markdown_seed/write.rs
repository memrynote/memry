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

use super::{FileProps, SeedBlock, SeedInline, SeedKind, SeedMarks, SeedRow};

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

pub(super) fn write_group(
    txn: &mut TransactionMut,
    group: &XmlElementRef,
    blocks: &[SeedBlock],
    mint: &mut dyn FnMut() -> String,
) {
    for block in blocks {
        let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        let id = mint();
        write_container(txn, &container, id, block, mint);
    }
}

/// Writes `blocks` into `group` from `index` on, each top-level container
/// under its id in `ids`; nested blocks take ids from `mint`.
pub(super) fn insert_group(
    txn: &mut TransactionMut,
    group: &XmlElementRef,
    index: u32,
    blocks: &[SeedBlock],
    ids: &[String],
    mint: &mut dyn FnMut() -> String,
) {
    for (offset, (block, id)) in (0u32..).zip(blocks.iter().zip(ids)) {
        let container = group.insert(
            txn,
            index + offset,
            XmlElementPrelim::empty("blockContainer"),
        );
        write_container(txn, &container, id.clone(), block, mint);
    }
}

fn write_container(
    txn: &mut TransactionMut,
    container: &XmlElementRef,
    id: String,
    block: &SeedBlock,
    mint: &mut dyn FnMut() -> String,
) {
    container.insert_attribute(txn, "id", id);
    write_block(txn, container, block);
    if !block.children.is_empty() {
        let children = container.push_back(txn, XmlElementPrelim::empty("blockGroup"));
        write_group(txn, &children, &block.children, mint);
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
        SeedKind::Diagram => "diagram",
        SeedKind::Toggle { .. } => "toggleListItem",
        SeedKind::Divider => "divider",
        SeedKind::Callout { .. } => "callout",
        SeedKind::Math { .. } => "mathBlock",
        SeedKind::Image { .. } => "image",
        SeedKind::Video { .. } => "video",
        SeedKind::YoutubeEmbed { .. } => "youtubeEmbed",
        SeedKind::Bookmark { .. } => "bookmark",
        SeedKind::Whiteboard { .. } => "whiteboard",
        SeedKind::File(_) => "file",
        SeedKind::Table { .. } => "table",
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
        (SeedKind::CodeBlock { language }, "language") => text(language),
        (
            SeedKind::Image { url, .. }
            | SeedKind::Video { url, .. }
            | SeedKind::Bookmark { url, .. },
            "url",
        ) => text(url),
        (SeedKind::Image { name, .. } | SeedKind::Video { name, .. }, "name") => text(name),
        (
            SeedKind::Image {
                preview_width: Some(width),
                ..
            },
            "previewWidth",
        ) => Any::Number(f64::from(*width)),
        (SeedKind::Toggle { open }, "open") => Any::Bool(*open),
        (SeedKind::Callout { kind, .. }, "type") => text(kind),
        (SeedKind::Callout { fold, .. }, "fold") => text(fold),
        (SeedKind::Math { latex }, "latex") => text(latex),
        (SeedKind::YoutubeEmbed { video_id, .. }, "videoId") => text(video_id),
        (SeedKind::YoutubeEmbed { video_url, .. }, "videoUrl") => text(video_url),
        (SeedKind::YoutubeEmbed { alt, .. }, "alt") => text(alt),
        (SeedKind::Bookmark { domain, .. }, "domain") => text(domain),
        (SeedKind::Whiteboard { canvas_id }, "canvasId") => text(canvas_id),
        (SeedKind::File(file), _) => file_prop(file, name).unwrap_or_else(|| default.to_any()),
        _ => default.to_any(),
    }
}

fn text(value: &str) -> Any {
    Any::String(value.into())
}

fn file_prop(file: &FileProps, name: &str) -> Option<Any> {
    let number = |value: &serde_json::Number| Any::Number(value.as_f64().unwrap_or(0.0));
    Some(match name {
        "url" => text(&file.url),
        "name" => text(&file.name),
        "size" => number(&file.size),
        "mimeType" => text(&file.mime_type),
        "width" => number(&file.width),
        "height" => number(&file.height),
        "align" => text(&file.align),
        "display" if file.link => text("link"),
        _ => return None,
    })
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

    if matches!(block.kind, SeedKind::CodeBlock { .. } | SeedKind::Diagram) {
        // A code block's content is plain: newlines stay characters.
        let code: String = block
            .content
            .iter()
            .filter_map(|piece| match piece {
                SeedInline::Text { text, .. } => Some(text.as_str()),
                SeedInline::HardBreak { .. }
                | SeedInline::InlineImage { .. }
                | SeedInline::HtmlComment { .. } => None,
            })
            .collect();
        if !code.is_empty() {
            element.push_back(txn, XmlTextPrelim::new(code.as_str()));
        }
        return;
    }
    if let SeedKind::Table { rows } = &block.kind {
        write_table(txn, &element, rows);
        return;
    }
    write_inline(txn, &element, &block.content);
}

/// `table > tableRow > tableHeader|tableCell(props) > tableParagraph`.
fn write_table(txn: &mut TransactionMut, table: &XmlElementRef, rows: &[SeedRow]) {
    for row in rows {
        let row_element = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
        for cell in &row.cells {
            let name = if cell.header {
                "tableHeader"
            } else {
                "tableCell"
            };
            let cell_element = row_element.push_back(txn, XmlElementPrelim::empty(name));
            for prop in node_shapes::cell_defaults() {
                cell_element.insert_attribute(txn, prop.name, prop.value.to_any());
            }
            let paragraph = cell_element.push_back(txn, XmlElementPrelim::empty("tableParagraph"));
            write_inline(txn, &paragraph, &cell.content);
        }
    }
}

/// Inline content: marked `XmlText` runs, a `hardBreak` element between them.
fn write_inline(txn: &mut TransactionMut, element: &XmlElementRef, content: &[SeedInline]) {
    let mut run: Option<XmlTextRef> = None;
    for piece in content {
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
            SeedInline::HardBreak { .. } => {
                run = None;
                element.push_back(txn, XmlElementPrelim::empty("hardBreak"));
            }
            SeedInline::HtmlComment { source } => {
                run = None;
                let comment = element.push_back(txn, XmlElementPrelim::empty("htmlComment"));
                comment.insert_attribute(txn, "source", text(source));
            }
            SeedInline::InlineImage { src, alt, width } => {
                run = None;
                let image = element.push_back(txn, XmlElementPrelim::empty("inlineImage"));
                image.insert_attribute(txn, "alt", text(alt));
                image.insert_attribute(txn, "src", text(src));
                image.insert_attribute(txn, "width", Any::Number(f64::from(*width)));
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
