//! The memry ProseMirror schema as data: the 36 node types and 8 mark types
//! BlockNote builds from `createMemrySchema` (`packages/editor-schema/src/schema.ts`)
//! plus tiptap's table and hard-break nodes, in the order `schema.spec.nodes`
//! lists them. **Order matters**: content expressions that name a group expand
//! in this order, and `fillBefore`/`findWrapping` pick the first match.
//!
//! The table is not read from the TypeScript at run time. The `pm-schema`
//! vector of the `markdown-convert` class is the TypeScript schema dumped by the
//! oracle, and `tests/markdown_pm_vectors.rs` compares it against this table,
//! so a BlockNote bump that changes a node shows up as a failing vector.

use super::schema::{AttrSpec, Default, Excludes, MarkSpec, Marks, NodeSpec};

const fn attr(name: &'static str, default: Default) -> AttrSpec {
    AttrSpec { name, default }
}

pub const TOP_NODE: &str = "doc";

pub static NODE_SPECS: &[NodeSpec] = &[
    NodeSpec {
        name: "inlineImage",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[
            attr("src", Default::Str("")),
            attr("alt", Default::Str("")),
            attr("width", Default::Number(0.0)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "inlineCheckbox",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[attr("checked", Default::Bool(false))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "paragraph",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "audio",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("name", Default::Str("")),
            attr("url", Default::Str("")),
            attr("caption", Default::Str("")),
            attr("showPreview", Default::Bool(true)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "checkListItem",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("checked", Default::Bool(false)),
            attr("plain", Default::Bool(false)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "heading",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("level", Default::Number(1.0)),
            attr("isToggleable", Default::Bool(false)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "image",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("textAlignment", Default::Str("left")),
            attr("backgroundColor", Default::Str("default")),
            attr("name", Default::Str("")),
            attr("url", Default::Str("")),
            attr("caption", Default::Str("")),
            attr("showPreview", Default::Bool(true)),
            attr("previewWidth", Default::Undefined),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "video",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("textAlignment", Default::Str("left")),
            attr("backgroundColor", Default::Str("default")),
            attr("name", Default::Str("")),
            attr("url", Default::Str("")),
            attr("caption", Default::Str("")),
            attr("showPreview", Default::Bool(true)),
            attr("previewWidth", Default::Undefined),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "diagram",
        content: "text*",
        marks: Marks::None,
        group: "blockContent",
        code: true,
        defining: true,
        isolating: true,
        selectable: Some(true),
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "wikiLink",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[
            attr("target", Default::Str("")),
            attr("alias", Default::Str("")),
            attr("bold", Default::Bool(false)),
            attr("italic", Default::Bool(false)),
            attr("underline", Default::Bool(false)),
            attr("strike", Default::Bool(false)),
            attr("code", Default::Bool(false)),
            attr("textColor", Default::Str("default")),
            attr("backgroundColor", Default::Str("default")),
            attr("size", Default::Str("none")),
            attr("cover", Default::Bool(false)),
            attr("preview", Default::Bool(false)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "linkMention",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[
            attr("url", Default::Str("")),
            attr("domain", Default::Str("")),
            attr("title", Default::Str("")),
            attr("favicon", Default::Str("")),
            attr("siteName", Default::Str("")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "hashTag",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[
            attr("tag", Default::Str("")),
            attr("color", Default::Str("")),
            attr("icon", Default::Str("")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "dateMention",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[
            attr("anchorId", Default::Str("")),
            attr("dateISO", Default::Str("")),
            attr("hasTime", Default::Bool(false)),
            attr("dateFormat", Default::Str("relative")),
            attr("remind", Default::Str("none")),
            attr("timeFormat", Default::Str("system")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "htmlComment",
        group: "inline",
        inline: true,
        atom: true,
        selectable: Some(false),
        attrs: &[attr("source", Default::Str(""))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "bulletListItem",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "codeBlock",
        content: "text*",
        marks: Marks::None,
        group: "blockContent",
        code: true,
        defining: true,
        selectable: Some(true),
        attrs: &[attr("language", Default::Str("javascript"))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "divider",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "file",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("url", Default::Str("")),
            attr("name", Default::Str("")),
            attr("size", Default::Number(0.0)),
            attr("mimeType", Default::Str("")),
            attr("width", Default::Number(0.0)),
            attr("height", Default::Number(0.0)),
            attr("align", Default::Str("left")),
            attr("display", Default::Str("embed")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "numberedListItem",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("start", Default::Undefined),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "quote",
        content: "inline*",
        group: "blockContent",
        defining: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "toggleListItem",
        content: "inline*",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("backgroundColor", Default::Str("default")),
            attr("textColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("open", Default::Bool(false)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "taskBlock",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("taskId", Default::Str("")),
            attr("title", Default::Str("")),
            attr("checked", Default::Bool(false)),
            attr("parentTaskId", Default::Str("")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "callout",
        content: "inline*",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("textAlignment", Default::Str("left")),
            attr("textColor", Default::Str("default")),
            attr("type", Default::Str("info")),
            attr("fold", Default::Str("none")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "youtubeEmbed",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("videoId", Default::Str("")),
            attr("videoUrl", Default::Str("")),
            attr("title", Default::Str("")),
            attr("alt", Default::Str("embed")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "bookmark",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[
            attr("url", Default::Str("")),
            attr("domain", Default::Str("")),
            attr("title", Default::Str("")),
            attr("description", Default::Str("")),
            attr("image", Default::Str("")),
            attr("favicon", Default::Str("")),
            attr("siteName", Default::Str("")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "mathBlock",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[attr("latex", Default::Str(""))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "whiteboard",
        group: "blockContent",
        defining: true,
        isolating: true,
        selectable: Some(true),
        attrs: &[attr("canvasId", Default::Str(""))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "text",
        group: "inline",
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "doc",
        content: "blockGroup",
        marks: Marks::None,
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "blockGroup",
        content: "blockGroupChild+",
        marks: Marks::None,
        group: "childContainer",
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "table",
        content: "tableRow+",
        marks: Marks::None,
        group: "blockContent",
        isolating: true,
        attrs: &[attr("textColor", Default::Str("default"))],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "tableParagraph",
        content: "inline*",
        group: "tableContent",
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "tableHeader",
        content: "tableContent+",
        marks: Marks::None,
        isolating: true,
        attrs: &[
            attr("textColor", Default::Str("default")),
            attr("backgroundColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("colspan", Default::Number(1.0)),
            attr("rowspan", Default::Number(1.0)),
            attr("colwidth", Default::Null),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "tableCell",
        content: "tableContent+",
        marks: Marks::None,
        isolating: true,
        attrs: &[
            attr("textColor", Default::Str("default")),
            attr("backgroundColor", Default::Str("default")),
            attr("textAlignment", Default::Str("left")),
            attr("colspan", Default::Number(1.0)),
            attr("rowspan", Default::Number(1.0)),
            attr("colwidth", Default::Null),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "tableRow",
        content: "(tableCell | tableHeader)+",
        marks: Marks::None,
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "blockContainer",
        content: "blockContent blockGroup?",
        marks: Marks::None,
        group: "blockGroupChild bnBlock",
        defining: true,
        attrs: &[attr("id", Default::Null)],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "column",
        content: "blockContainer+",
        marks: Marks::None,
        group: "bnBlock childContainer",
        defining: true,
        attrs: &[
            attr("id", Default::Null),
            attr("width", Default::Number(1.0)),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "columnList",
        content: "column column+",
        marks: Marks::None,
        group: "childContainer bnBlock blockGroupChild",
        defining: true,
        attrs: &[
            attr("id", Default::Null),
            attr("regionId", Default::Str("")),
            attr("settings", Default::Str("")),
        ],
        ..NodeSpec::BASE
    },
    NodeSpec {
        name: "hardBreak",
        group: "inline",
        inline: true,
        selectable: Some(false),
        linebreak_replacement: true,
        ..NodeSpec::BASE
    },
];

pub static MARK_SPECS: &[MarkSpec] = &[
    MarkSpec {
        name: "bold",
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "italic",
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "underline",
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "strike",
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "code",
        excludes: Excludes::All,
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "textColor",
        attrs: &[attr("stringValue", Default::Undefined)],
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "backgroundColor",
        attrs: &[attr("stringValue", Default::Undefined)],
        ..MarkSpec::BASE
    },
    MarkSpec {
        name: "link",
        inclusive: Some(false),
        attrs: &[attr("href", Default::Null)],
        ..MarkSpec::BASE
    },
];
