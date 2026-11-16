//! The parse rules of the memry schema: `DOMParser.schemaRules` of
//! `DOMParser.fromSchema(memrySchema)`, in the order its priority sort leaves
//! them (69 tag rules, 6 style rules).
//!
//! The rules are not read from the schema at run time. Each node and mark type
//! has them from tiptap's `parseHTML` (wrapped by tiptap to read the type's
//! attributes, see [`attrs`]), BlockNote's `createSpec` (`getParseRules`) and
//! memry's own blocks. The order is the sorted one: higher `priority` first,
//! ties kept in the order of the schema's types, which in turn follow
//! `runsBefore`.

mod attrs;
mod blocks;
mod content;
mod getattrs;
pub(crate) mod js;
mod link;
mod url;

use super::{
    AttrsResult, ContentElement, GetAttrs, GetContent, StyleRule, StyleTarget, TagRule, Target,
};
use crate::markdown::bn::dom::{Dom, NodeId, Selector};
use crate::markdown::pm::Schema;
use getattrs as g;

/// `[data-editable]` of a style or inline content, or the element itself.
fn editable_element(dom: &Dom, id: NodeId) -> NodeId {
    let editable = Selector::new("[data-editable]");
    if dom.matches(id, &editable) {
        return id;
    }
    dom.query_selector(id, &editable).unwrap_or(id)
}

fn rule(selector: &str, target: Target, get_attrs: Option<GetAttrs>) -> TagRule {
    TagRule {
        selector: Selector::new(selector),
        target,
        consuming: true,
        skip: false,
        preserve_whitespace: None,
        content_element: ContentElement::Itself,
        get_content: None,
        get_attrs,
    }
}

pub fn tag_rules(schema: &'static Schema) -> Vec<TagRule> {
    let node =
        |name: &str| Target::Node(schema.node_type(name).expect("a node type of the schema"));
    let mark =
        |name: &str| Target::Mark(schema.mark_type(name).expect("a mark type of the schema"));

    // A mark whose rule reads no attribute.
    let plain_mark = |tag: &str, name: &str| rule(tag, mark(name), None);
    // `getStyleParseRules`.
    let style_data = |name: &str, get_attrs: GetAttrs| TagRule {
        content_element: ContentElement::Func(editable_element),
        ..rule(
            &format!("[data-style-type=\"{name}\"]"),
            mark(name),
            Some(get_attrs),
        )
    };
    let style_any = |name: &str, get_attrs: GetAttrs| TagRule {
        consuming: false,
        ..rule("*", mark(name), Some(get_attrs))
    };
    // `getParseRules`: the rule that reads a block's own markup back.
    let block_data = |name: &str, get_attrs: GetAttrs| TagRule {
        content_element: ContentElement::Selector(Selector::new(".bn-inline-content")),
        ..rule(
            &format!("[data-content-type={name}]"),
            node(name),
            Some(get_attrs),
        )
    };
    // ... and the one that reads other HTML through the block's `parse`.
    let block_any = |name: &str, get_attrs: GetAttrs, get_content: GetContent| TagRule {
        preserve_whitespace: Some(true),
        get_content: Some(get_content),
        ..rule("*", node(name), Some(get_attrs))
    };
    // `getInlineContentParseRules`.
    let inline_data = |name: &str, get_attrs: GetAttrs| TagRule {
        content_element: ContentElement::Func(editable_element),
        ..rule(
            &format!("[data-inline-content-type=\"{name}\"]"),
            node(name),
            Some(get_attrs),
        )
    };
    let inline_any = |name: &str, get_attrs: GetAttrs| rule("*", node(name), Some(get_attrs));

    vec![
        plain_mark("strong", "bold"),
        plain_mark("b", "bold"),
        plain_mark("em", "italic"),
        plain_mark("i", "italic"),
        plain_mark("u", "underline"),
        plain_mark("s", "strike"),
        plain_mark("del", "strike"),
        plain_mark("strike", "strike"),
        plain_mark("code", "code"),
        style_data("textColor", g::text_color_data),
        style_any("textColor", g::text_color_any),
        style_data("backgroundColor", g::background_color_data),
        style_any("backgroundColor", g::background_color_any),
        rule("a[href]", mark("link"), Some(g::link)),
        inline_data("inlineImage", g::inline_image_data),
        inline_any("inlineImage", g::inline_image_any),
        inline_data("inlineCheckbox", g::inline_checkbox_data),
        inline_any("inlineCheckbox", g::inline_checkbox_any),
        block_data("paragraph", g::paragraph_data),
        block_any("paragraph", g::paragraph_any, content::inline_content),
        block_data("audio", g::audio_data),
        block_any("audio", g::audio_any, content::no_content),
        block_data("checkListItem", g::check_list_item_data),
        block_any(
            "checkListItem",
            g::check_list_item_any,
            content::list_item_content,
        ),
        block_data("heading", g::heading_data),
        block_any("heading", g::heading_any, content::heading_content),
        block_data("image", g::image_data),
        block_any("image", g::image_any, content::no_content),
        block_data("video", g::video_data),
        block_any("video", g::video_any, content::no_content),
        block_data("diagram", g::diagram_data),
        block_any("diagram", g::diagram_any, content::diagram_content),
        inline_data("wikiLink", g::wiki_link_data),
        inline_data("linkMention", g::link_mention_data),
        inline_any("linkMention", g::link_mention_any),
        inline_data("hashTag", g::hash_tag_data),
        inline_any("hashTag", g::hash_tag_any),
        inline_data("dateMention", g::date_mention_data),
        inline_any("dateMention", g::date_mention_any),
        inline_data("htmlComment", g::html_comment_data),
        block_data("bulletListItem", g::bullet_list_item_data),
        block_any(
            "bulletListItem",
            g::bullet_list_item_any,
            content::list_item_content,
        ),
        block_data("codeBlock", g::code_block_data),
        block_any("codeBlock", g::code_block_any, content::code_block_content),
        block_data("divider", g::divider_data),
        block_any("divider", g::divider_any, content::no_content),
        block_data("file", g::file_data),
        block_data("numberedListItem", g::numbered_list_item_data),
        block_any(
            "numberedListItem",
            g::numbered_list_item_any,
            content::list_item_content,
        ),
        block_data("quote", g::quote_data),
        block_any("quote", g::quote_any, content::inline_content),
        block_data("toggleListItem", g::toggle_list_item_data),
        block_data("taskBlock", g::task_block_data),
        block_data("callout", g::callout_data),
        block_data("youtubeEmbed", g::youtube_embed_data),
        block_data("bookmark", g::bookmark_data),
        block_data("mathBlock", g::math_block_data),
        block_data("whiteboard", g::whiteboard_data),
        rule("div", node("blockGroup"), Some(g::block_group)),
        rule("table", node("table"), Some(g::table)),
        rule("p", node("tableParagraph"), Some(g::table_paragraph)),
        TagRule {
            get_content: Some(content::table_cell_content),
            ..rule("th", node("tableHeader"), Some(g::table_header))
        },
        TagRule {
            get_content: Some(content::table_cell_content),
            ..rule("td", node("tableCell"), Some(g::table_cell))
        },
        rule("tr", node("tableRow"), None),
        rule(
            "div[data-node-type=blockContainer]",
            node("blockContainer"),
            Some(g::block_container),
        ),
        TagRule {
            skip: true,
            ..rule(
                "div[data-node-type=\"blockOuter\"]",
                node("blockContainer"),
                Some(g::block_outer),
            )
        },
        rule("div", node("column"), Some(g::column)),
        rule("div", node("columnList"), Some(g::column_list)),
        rule("br", node("hardBreak"), None),
    ]
}

/// `/^(bold(er)?|[5-9]\d{2,})$/.test(value) && null`.
fn bold_font_weight(value: &str) -> AttrsResult {
    let digits = value.as_bytes();
    let numeric = digits.len() >= 3
        && (b'5'..=b'9').contains(&digits[0])
        && digits.iter().all(u8::is_ascii_digit);
    if matches!(value, "bold" | "bolder") || numeric {
        AttrsResult::NoAttrs
    } else {
        AttrsResult::Reject
    }
}

fn has_underline(value: &str) -> AttrsResult {
    if value.contains("underline") {
        AttrsResult::Attrs(Vec::new())
    } else {
        AttrsResult::Reject
    }
}

fn has_line_through(value: &str) -> AttrsResult {
    if value.contains("line-through") {
        AttrsResult::Attrs(Vec::new())
    } else {
        AttrsResult::Reject
    }
}

pub fn style_rules(schema: &'static Schema) -> Vec<StyleRule> {
    let mark = |name: &str| schema.mark_type(name).expect("a mark type of the schema");
    vec![
        StyleRule {
            style: "font-weight=400",
            target: StyleTarget::ClearMark(mark("bold")),
            consuming: true,
            get_attrs: None,
        },
        StyleRule {
            style: "font-weight",
            target: StyleTarget::Mark(mark("bold")),
            consuming: true,
            get_attrs: Some(bold_font_weight),
        },
        StyleRule {
            style: "font-style=normal",
            target: StyleTarget::ClearMark(mark("italic")),
            consuming: true,
            get_attrs: None,
        },
        StyleRule {
            style: "font-style=italic",
            target: StyleTarget::Mark(mark("italic")),
            consuming: true,
            get_attrs: None,
        },
        StyleRule {
            style: "text-decoration",
            target: StyleTarget::Mark(mark("underline")),
            consuming: false,
            get_attrs: Some(has_underline),
        },
        StyleRule {
            style: "text-decoration",
            target: StyleTarget::Mark(mark("strike")),
            consuming: false,
            get_attrs: Some(has_line_through),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kind, target, flags: `n` not consuming, `s` skip, `w` preserveWhitespace,
    /// `e` contentElement, `c` getContent. Dumped from the real
    /// `DOMParser.fromSchema(memrySchema).rules` by the oracle.
    const TAGS: [(&str, &str, &str); 69] = [
        ("M", "bold", ""),
        ("M", "bold", ""),
        ("M", "italic", ""),
        ("M", "italic", ""),
        ("M", "underline", ""),
        ("M", "strike", ""),
        ("M", "strike", ""),
        ("M", "strike", ""),
        ("M", "code", ""),
        ("M", "textColor", "e"),
        ("M", "textColor", "n"),
        ("M", "backgroundColor", "e"),
        ("M", "backgroundColor", "n"),
        ("M", "link", ""),
        ("N", "inlineImage", "e"),
        ("N", "inlineImage", ""),
        ("N", "inlineCheckbox", "e"),
        ("N", "inlineCheckbox", ""),
        ("N", "paragraph", "e"),
        ("N", "paragraph", "wc"),
        ("N", "audio", "e"),
        ("N", "audio", "wc"),
        ("N", "checkListItem", "e"),
        ("N", "checkListItem", "wc"),
        ("N", "heading", "e"),
        ("N", "heading", "wc"),
        ("N", "image", "e"),
        ("N", "image", "wc"),
        ("N", "video", "e"),
        ("N", "video", "wc"),
        ("N", "diagram", "e"),
        ("N", "diagram", "wc"),
        ("N", "wikiLink", "e"),
        ("N", "linkMention", "e"),
        ("N", "linkMention", ""),
        ("N", "hashTag", "e"),
        ("N", "hashTag", ""),
        ("N", "dateMention", "e"),
        ("N", "dateMention", ""),
        ("N", "htmlComment", "e"),
        ("N", "bulletListItem", "e"),
        ("N", "bulletListItem", "wc"),
        ("N", "codeBlock", "e"),
        ("N", "codeBlock", "wc"),
        ("N", "divider", "e"),
        ("N", "divider", "wc"),
        ("N", "file", "e"),
        ("N", "numberedListItem", "e"),
        ("N", "numberedListItem", "wc"),
        ("N", "quote", "e"),
        ("N", "quote", "wc"),
        ("N", "toggleListItem", "e"),
        ("N", "taskBlock", "e"),
        ("N", "callout", "e"),
        ("N", "youtubeEmbed", "e"),
        ("N", "bookmark", "e"),
        ("N", "mathBlock", "e"),
        ("N", "whiteboard", "e"),
        ("N", "blockGroup", ""),
        ("N", "table", ""),
        ("N", "tableParagraph", ""),
        ("N", "tableHeader", "c"),
        ("N", "tableCell", "c"),
        ("N", "tableRow", ""),
        ("N", "blockContainer", ""),
        ("N", "blockContainer", "s"),
        ("N", "column", ""),
        ("N", "columnList", ""),
        ("N", "hardBreak", ""),
    ];

    #[test]
    fn tag_rules_are_the_sorted_typescript_rules() {
        let schema = Schema::memry();
        let rules = tag_rules(schema);
        assert_eq!(rules.len(), TAGS.len());
        for (i, (rule, (kind, name, flags))) in rules.iter().zip(TAGS).enumerate() {
            let target = match rule.target {
                Target::Node(ty) => ("N", schema.node_ty(ty).name),
                Target::Mark(ty) => ("M", schema.mark_ty(ty).name),
            };
            assert_eq!(target, (kind, name), "target of rule {i}");
            assert_eq!(
                !rule.consuming,
                flags.contains('n'),
                "consuming of rule {i}"
            );
            assert_eq!(rule.skip, flags.contains('s'), "skip of rule {i}");
            assert_eq!(
                rule.preserve_whitespace == Some(true),
                flags.contains('w'),
                "ws of rule {i}"
            );
            assert_eq!(
                !matches!(rule.content_element, ContentElement::Itself),
                flags.contains('e'),
                "contentElement of rule {i}"
            );
            assert_eq!(
                rule.get_content.is_some(),
                flags.contains('c'),
                "getContent of rule {i}"
            );
        }
    }

    #[test]
    fn style_rules_match_the_typescript_rules() {
        let rules = style_rules(Schema::memry());
        let shape: Vec<(&str, bool)> = rules.iter().map(|r| (r.style, r.consuming)).collect();
        assert_eq!(
            shape,
            [
                ("font-weight=400", true),
                ("font-weight", true),
                ("font-style=normal", true),
                ("font-style=italic", true),
                ("text-decoration", false),
                ("text-decoration", false),
            ]
        );
        let bold = |v: &str| bold_font_weight(v) == AttrsResult::NoAttrs;
        assert!(bold("bold") && bold("bolder") && bold("700") && bold("900"));
        assert!(!bold("400") && !bold("normal") && !bold("50") && !bold("bold ") && !bold("7000x"));
        assert_eq!(
            has_underline("underline dotted"),
            AttrsResult::Attrs(Vec::new())
        );
        assert_eq!(has_underline("none"), AttrsResult::Reject);
        assert_eq!(
            has_line_through("line-through"),
            AttrsResult::Attrs(Vec::new())
        );
    }
}
