//! One `getAttrs` function per rule that needs its own: a rule's function
//! cannot capture its target type, so each target gets its own item, built by
//! `node_attrs!` and `mark_attrs!` around [`wrap_node`] and [`wrap_mark`].

use super::attrs::{Own, Props, props_result, wrap_mark, wrap_node};
use super::blocks::{self, Media, tag_is};
use super::link::link_attrs;
use crate::markdown::bn::dom::{Dom, NodeId, Selector};
use crate::markdown::bn::dom_parser::AttrsResult;

macro_rules! node_attrs {
    ($name:ident, $ty:literal) => {
        pub fn $name(dom: &Dom, id: NodeId) -> AttrsResult {
            wrap_node(dom, id, $ty, None)
        }
    };
    ($name:ident, $ty:literal, $own:expr) => {
        pub fn $name(dom: &Dom, id: NodeId) -> AttrsResult {
            let own: Own = $own;
            wrap_node(dom, id, $ty, Some(own))
        }
    };
}

macro_rules! mark_attrs {
    ($name:ident, $ty:literal) => {
        pub fn $name(dom: &Dom, id: NodeId) -> AttrsResult {
            wrap_mark(dom, id, $ty, None)
        }
    };
    ($name:ident, $ty:literal, $own:expr) => {
        pub fn $name(dom: &Dom, id: NodeId) -> AttrsResult {
            let own: Own = $own;
            wrap_mark(dom, id, $ty, Some(own))
        }
    };
}

/// An own `getAttrs` made of a `parse`: `None` is `false`.
macro_rules! parse {
    ($f:expr) => {
        |dom: &Dom, id: NodeId| -> AttrsResult {
            let props: Option<Props> = $f(dom, id);
            props_result(props)
        }
    };
}

// Marks. `bold`, `italic`, `underline`, `strike` and `code` read no attribute.
mark_attrs!(text_color_data, "textColor");
mark_attrs!(
    text_color_any,
    "textColor",
    parse!(|d: &Dom, i| blocks::span_style(d, i, "color"))
);
mark_attrs!(background_color_data, "backgroundColor");
mark_attrs!(
    background_color_any,
    "backgroundColor",
    parse!(|d: &Dom, i| blocks::span_style(d, i, "background-color"))
);
mark_attrs!(link, "link", link_attrs);

// Inline content.
node_attrs!(inline_image_data, "inlineImage");
node_attrs!(
    inline_image_any,
    "inlineImage",
    parse!(blocks::inline_image)
);
node_attrs!(inline_checkbox_data, "inlineCheckbox");
node_attrs!(
    inline_checkbox_any,
    "inlineCheckbox",
    parse!(blocks::inline_checkbox)
);
node_attrs!(wiki_link_data, "wikiLink");
node_attrs!(link_mention_data, "linkMention");
node_attrs!(
    link_mention_any,
    "linkMention",
    parse!(blocks::link_mention)
);
node_attrs!(hash_tag_data, "hashTag");
node_attrs!(hash_tag_any, "hashTag", parse!(blocks::hash_tag));
node_attrs!(date_mention_data, "dateMention");
node_attrs!(
    date_mention_any,
    "dateMention",
    parse!(blocks::date_mention)
);
node_attrs!(html_comment_data, "htmlComment");

// Blocks: the `[data-content-type]` rule reads attributes only, the `*` rule
// adds the block's `parse`.
node_attrs!(paragraph_data, "paragraph");
node_attrs!(paragraph_any, "paragraph", parse!(blocks::paragraph));
node_attrs!(audio_data, "audio");
node_attrs!(
    audio_any,
    "audio",
    parse!(|d: &Dom, i| blocks::media(d, i, Media::Audio))
);
node_attrs!(check_list_item_data, "checkListItem");
node_attrs!(
    check_list_item_any,
    "checkListItem",
    parse!(blocks::check_list_item)
);
node_attrs!(heading_data, "heading");
node_attrs!(heading_any, "heading", parse!(blocks::heading));
node_attrs!(image_data, "image");
node_attrs!(image_any, "image", parse!(blocks::image));
node_attrs!(video_data, "video");
node_attrs!(
    video_any,
    "video",
    parse!(|d: &Dom, i| blocks::media(d, i, Media::Video))
);
node_attrs!(diagram_data, "diagram");
node_attrs!(diagram_any, "diagram", parse!(blocks::diagram));
node_attrs!(bullet_list_item_data, "bulletListItem");
node_attrs!(
    bullet_list_item_any,
    "bulletListItem",
    parse!(blocks::bullet_list_item)
);
node_attrs!(code_block_data, "codeBlock");
node_attrs!(code_block_any, "codeBlock", parse!(blocks::code_block));
node_attrs!(divider_data, "divider");
node_attrs!(divider_any, "divider", parse!(blocks::divider));
node_attrs!(file_data, "file");
node_attrs!(numbered_list_item_data, "numberedListItem");
node_attrs!(
    numbered_list_item_any,
    "numberedListItem",
    parse!(blocks::numbered_list_item)
);
node_attrs!(quote_data, "quote");
node_attrs!(quote_any, "quote", parse!(blocks::quote));
node_attrs!(toggle_list_item_data, "toggleListItem");
node_attrs!(task_block_data, "taskBlock");
node_attrs!(callout_data, "callout");
node_attrs!(youtube_embed_data, "youtubeEmbed");
node_attrs!(bookmark_data, "bookmark");
node_attrs!(math_block_data, "mathBlock");
node_attrs!(whiteboard_data, "whiteboard");

// Structure.
node_attrs!(block_group, "blockGroup", block_group_own);
node_attrs!(table, "table");
node_attrs!(table_paragraph, "tableParagraph", table_paragraph_own);
node_attrs!(table_header, "tableHeader");
node_attrs!(table_cell, "tableCell");
node_attrs!(block_container, "blockContainer", block_container_own);
node_attrs!(block_outer, "blockContainer");
node_attrs!(column, "column", |d, i| node_type_div(d, i, "column"));
node_attrs!(column_list, "columnList", |d, i| node_type_div(
    d,
    i,
    "columnList"
));

/// `BlockGroup`'s `div` rule: only `data-node-type="blockGroup"`.
fn block_group_own(dom: &Dom, id: NodeId) -> AttrsResult {
    if dom.attr(id, "data-node-type") == Some("blockGroup") {
        AttrsResult::NoAttrs
    } else {
        AttrsResult::Reject
    }
}

/// `parseNodeTypeDiv` of the column nodes: `{}` for the right `data-node-type`.
fn node_type_div(dom: &Dom, id: NodeId, name: &str) -> AttrsResult {
    if dom.attr(id, "data-node-type") == Some(name) {
        AttrsResult::Attrs(Vec::new())
    } else {
        AttrsResult::Reject
    }
}

/// `BlockContainer`'s rule reads `BlockAttributes` (`blockColor`, `blockStyle`,
/// `id`, `depth`, `depthChange`) when non-empty. Only `id` is an attribute of
/// the memry schema's node; the other four do not survive `computeAttrs`.
fn block_container_own(dom: &Dom, id: NodeId) -> AttrsResult {
    let attrs = match dom.attr(id, "data-id").filter(|v| !v.is_empty()) {
        Some(value) => vec![("id".to_owned(), yrs::Any::from(value))],
        None => Vec::new(),
    };
    AttrsResult::Attrs(attrs)
}

/// `tableParagraph`: only a `<p>` with text that sits directly in a `td` or
/// `th` of internal (`data-content-type`) HTML.
fn table_paragraph_own(dom: &Dom, id: NodeId) -> AttrsResult {
    if dom.text_content(id).is_empty()
        || dom
            .closest(id, &Selector::new("[data-content-type]"))
            .is_none()
    {
        return AttrsResult::Reject;
    }
    match dom.parent_element(id) {
        Some(parent) if tag_is(dom, parent, "TD") || tag_is(dom, parent, "TH") => {
            AttrsResult::Attrs(Vec::new())
        }
        _ => AttrsResult::Reject,
    }
}
