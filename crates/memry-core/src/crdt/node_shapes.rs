//! What BlockNote's nodes look like, so a Rust writer can build one.
//!
//! **This is the table plan §3 D1 exists for.** Inserting a block means
//! building a node y-prosemirror can construct, and chapter 12 §12.5.0 is
//! explicit about the cost of getting it wrong: a node the schema cannot build
//! is answered by **deleting the element**, silently. The update applies, the
//! document encodes, `extract_text` may still return the text, and the next
//! desktop to open the note renders it without the block.
//!
//! So node construction lives here, in one place, rather than in each caller
//! and never in Swift. A shell sends an operation name and parameters; it does
//! not know a node shape.
//!
//! ## Where these values come from
//!
//! **Not from reading BlockNote's source and transcribing it.** They are
//! derived from `note-blocks.json`, whose documents are authored by
//! `blocksToYXmlFragment` — the production path desktop's main process calls.
//! The props below are what a real note actually carries, and the
//! `block-edit` class holds a writer to producing the same document BlockNote
//! would have.
//!
//! ## Why the defaults are written rather than omitted
//!
//! §12.5.0 says "a block's props are omitted when they equal their declared
//! defaults". That describes the hand-built `text-extract` fixtures, **not**
//! BlockNote's writer: a real paragraph carries `backgroundColor`,
//! `textAlignment` and `textColor` explicitly. A block written without them
//! renders identically and is **not** the same document, so it cannot be held
//! to byte parity with desktop. The chapter now says so, and this table is
//! what makes the writer match.

use yrs::Any;

/// One declared prop: its name and the value a fresh block carries.
pub struct PropDefault {
    pub name: &'static str,
    pub value: PropValue,
}

/// A prop's declared **type**, which is not the same as its text.
///
/// The reference writer stores `checked` as the boolean `true` and `level` as
/// the number `1`. A writer that stored `"true"` and `"1"` produces valid CBOR
/// and a document that reads differently: a non-empty string is truthy, so an
/// unticked box written as `"false"` reads as ticked anywhere the prop is
/// tested for truth.
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    Text(&'static str),
    Number(f64),
    Bool(bool),
    /// y-prosemirror writes an `undefined` attribute rather than omitting it;
    /// `numberedListItem` carries `start: undefined` on every item.
    Undefined,
}

impl PropValue {
    pub fn to_any(&self) -> Any {
        match self {
            PropValue::Text(value) => Any::String((*value).into()),
            PropValue::Number(value) => Any::Number(*value),
            PropValue::Bool(value) => Any::Bool(*value),
            PropValue::Undefined => Any::Undefined,
        }
    }
}

const fn text(name: &'static str, value: &'static str) -> PropDefault {
    PropDefault {
        name,
        value: PropValue::Text(value),
    }
}
const fn number(name: &'static str, value: f64) -> PropDefault {
    PropDefault {
        name,
        value: PropValue::Number(value),
    }
}
const fn boolean(name: &'static str, value: bool) -> PropDefault {
    PropDefault {
        name,
        value: PropValue::Bool(value),
    }
}
const fn undefined(name: &'static str) -> PropDefault {
    PropDefault {
        name,
        value: PropValue::Undefined,
    }
}

/// The three every text block carries.
const COLOURS: [PropDefault; 3] = [
    text("backgroundColor", "default"),
    text("textAlignment", "left"),
    text("textColor", "default"),
];

/// The declared props of one block type, or `None` for a type this build does
/// not know.
///
/// **`None` is a refusal, not an empty list.** A writer asked to insert a type
/// it cannot shape must refuse rather than write a bare node: the bare node is
/// the one y-prosemirror deletes.
pub fn defaults_for(kind: &str) -> Option<Vec<PropDefault>> {
    let props: Vec<PropDefault> = match kind {
        "paragraph" | "bulletListItem" => COLOURS.into(),
        "numberedListItem" => vec![
            text("backgroundColor", "default"),
            undefined("start"),
            text("textAlignment", "left"),
            text("textColor", "default"),
        ],
        "checkListItem" => vec![
            text("backgroundColor", "default"),
            boolean("checked", false),
            text("textAlignment", "left"),
            text("textColor", "default"),
        ],
        "heading" => vec![
            text("backgroundColor", "default"),
            boolean("isToggleable", false),
            number("level", 1.0),
            text("textAlignment", "left"),
            text("textColor", "default"),
        ],
        "toggleListItem" => vec![
            text("backgroundColor", "default"),
            boolean("open", false),
            text("textAlignment", "left"),
            text("textColor", "default"),
        ],
        // A quote carries no alignment of its own.
        "quote" => vec![
            text("backgroundColor", "default"),
            text("textColor", "default"),
        ],
        "callout" => vec![
            text("textAlignment", "left"),
            text("textColor", "default"),
            text("type", "info"),
        ],
        "codeBlock" => vec![text("language", "javascript")],
        "divider" => Vec::new(),
        "table" => vec![text("textColor", "default")],
        "taskBlock" => vec![
            boolean("checked", false),
            text("parentTaskId", ""),
            text("taskId", ""),
            text("title", ""),
        ],
        "image" => vec![
            text("backgroundColor", "default"),
            text("caption", ""),
            text("name", ""),
            undefined("previewWidth"),
            boolean("showPreview", true),
            text("textAlignment", "left"),
            text("url", ""),
        ],
        "video" => vec![
            text("backgroundColor", "default"),
            text("caption", ""),
            text("name", ""),
            undefined("previewWidth"),
            boolean("showPreview", true),
            text("textAlignment", "left"),
            text("url", ""),
        ],
        // Audio has no alignment: there is nothing to align.
        "audio" => vec![
            text("backgroundColor", "default"),
            text("caption", ""),
            text("name", ""),
            boolean("showPreview", true),
            text("url", ""),
        ],
        "file" => vec![
            text("align", "left"),
            number("height", 0.0),
            text("mimeType", ""),
            text("name", ""),
            number("size", 0.0),
            text("url", ""),
            number("width", 0.0),
        ],
        "bookmark" => vec![
            text("description", ""),
            text("domain", ""),
            text("favicon", ""),
            text("image", ""),
            text("siteName", ""),
            text("title", ""),
            text("url", ""),
        ],
        "youtubeEmbed" => vec![text("title", ""), text("videoId", ""), text("videoUrl", "")],
        _ => return None,
    };
    Some(props)
}

/// A table cell's declared props.
///
/// Separate from [`defaults_for`] because a cell is not a block: it has no
/// `blockContainer` and cannot be inserted on its own (Q1).
pub fn cell_defaults() -> Vec<PropDefault> {
    vec![
        text("backgroundColor", "default"),
        number("colspan", 1.0),
        number("rowspan", 1.0),
        text("textAlignment", "left"),
        text("textColor", "default"),
    ]
}

/// Whether a block type holds inline content.
///
/// A `divider` and a `file` hold none, so inserting text into one is a
/// caller's mistake rather than a node to build. `taskBlock` is the subtle
/// one: its text is the `title` **prop**, not inline content, which is why a
/// reader walking only inline content renders an empty row.
pub fn holds_inline(kind: &str) -> bool {
    matches!(
        kind,
        "paragraph"
            | "heading"
            | "quote"
            | "callout"
            | "codeBlock"
            | "bulletListItem"
            | "numberedListItem"
            | "checkListItem"
            | "toggleListItem"
    )
}

/// The prop a caller means when they say "the text of this block", for the
/// types whose text is not inline content.
pub fn text_prop(kind: &str) -> Option<&'static str> {
    match kind {
        "taskBlock" => Some("title"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 18 block types of the FR-040 registry, minus the two that are not
    /// independently insertable.
    #[test]
    fn every_registry_block_type_has_a_shape() {
        for kind in [
            "audio",
            "bookmark",
            "bulletListItem",
            "callout",
            "checkListItem",
            "codeBlock",
            "divider",
            "file",
            "heading",
            "image",
            "numberedListItem",
            "paragraph",
            "quote",
            "table",
            "taskBlock",
            "toggleListItem",
            "video",
            "youtubeEmbed",
        ] {
            assert!(
                defaults_for(kind).is_some(),
                "{kind} is in the registry and has no shape, so it cannot be inserted"
            );
        }
    }

    /// A type this build does not know is refused rather than written bare.
    /// The bare node is the one y-prosemirror deletes (§12.5.0).
    #[test]
    fn an_unknown_type_is_refused() {
        assert!(defaults_for("someBlockFromTheFuture").is_none());
    }

    /// Props are sorted by name, because `props_of` sorts and a document a
    /// shell diffs twice must not appear to change.
    #[test]
    fn declared_props_are_in_name_order() {
        for kind in ["paragraph", "heading", "checkListItem", "image", "file"] {
            let props = defaults_for(kind).expect("a shape");
            let mut names: Vec<&str> = props.iter().map(|prop| prop.name).collect();
            let sorted = {
                let mut copy = names.clone();
                copy.sort_unstable();
                copy
            };
            assert_eq!(names, sorted, "{kind}'s props are not in name order");
            names.dedup();
            assert_eq!(names.len(), props.len(), "{kind} declares a prop twice");
        }
    }

    /// The types matter, not just the names. `checked` is a boolean and
    /// `level` is a number; storing either as text produces a document that
    /// reads differently.
    #[test]
    fn a_prop_carries_its_declared_type() {
        let check = defaults_for("checkListItem").expect("a shape");
        let checked = check
            .iter()
            .find(|prop| prop.name == "checked")
            .expect("checked");
        assert_eq!(checked.value, PropValue::Bool(false));

        let heading = defaults_for("heading").expect("a shape");
        let level = heading
            .iter()
            .find(|prop| prop.name == "level")
            .expect("level");
        assert_eq!(level.value, PropValue::Number(1.0));

        // And `start` is the undefined y-prosemirror really writes.
        let numbered = defaults_for("numberedListItem").expect("a shape");
        let start = numbered
            .iter()
            .find(|prop| prop.name == "start")
            .expect("start");
        assert_eq!(start.value, PropValue::Undefined);
    }

    #[test]
    fn a_task_blocks_text_is_a_prop_and_not_inline_content() {
        assert!(!holds_inline("taskBlock"));
        assert_eq!(text_prop("taskBlock"), Some("title"));
        assert_eq!(text_prop("paragraph"), None);
        assert!(holds_inline("paragraph"));
        // A divider has nothing to say.
        assert!(!holds_inline("divider"));
    }
}
