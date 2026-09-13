//! `extract_text`: the core's only text operation (chapter 12 §12.1).
//!
//! A plain-text walk of a note document's `prosemirror` `XmlFragment` that
//! keeps heading and list markers, drops everything else, and claims **no**
//! markdown fidelity. It feeds FTS `content` (data-model §A.3), list previews,
//! and the SC-010 cross-shell digest, which chapter 12 §12.11 defines as
//! SHA-256 over the UTF-8 bytes of `title + "\n" + extract_text(doc)`.
//!
//! **This is not markdown and this module parses none.** A case whose output
//! looks like markdown is a coincidence of its input: inline marks, colours,
//! link targets, table structure, callout types and toggle state are all
//! dropped, because search and previews read better with heading and list
//! markers and worse with everything else (chapter 12 §12.1.2).
//!
//! **The contract is byte-level, not descriptive.** `text-extract.json` is
//! generated from the TypeScript reference port
//! (`packages/contracts/scripts/extract-text.ts`) and asserted against this one
//! in `crates/memry-core/tests/text_extract_vectors.rs`. Where the chapter is
//! silent, this port reproduces the reference's observable behaviour rather
//! than improving on it: a digest mismatch must mean the content differs, never
//! that two extractors disagree. Every such point is marked `PARITY` below.
//!
//! The door in is [`Document::read`], never a raw `Doc`: chapter 12 §12.5.1
//! forbids rebuilding a document through named accessors, and a reader that
//! cannot hold a `Doc` cannot be tempted to.

use yrs::{GetString as _, ReadTxn, Xml as _, XmlElementRef, XmlFragment, XmlOut};

use super::errors::CrdtError;
use super::registry::Document;

/// The body fragment's name (chapter 12 §12.3), `CRDT_FRAGMENT_NAME` and
/// `BRIDGE_FRAGMENT_NAME` on the TypeScript side.
///
/// The same string the registry types as a root; the unit tests below pin the
/// two together so they cannot drift apart silently.
pub const BODY_FRAGMENT: &str = "prosemirror";

/// The BlockNote list blocks, and the marker each one contributes.
///
/// Ordered numbering is deliberately **not** reconstructed: every
/// `numberedListItem` takes `1. `, because a preview does not need the count
/// and reconstructing it would make the output depend on sibling state.
const LIST_MARKERS: [(&str, &str); 4] = [
    ("bulletListItem", "- "),
    ("checkListItem", "- "),
    ("numberedListItem", "1. "),
    ("taskBlock", "- "),
];

/// Blocks whose own text is dropped entirely.
const SKIPPED_BLOCKS: [&str; 1] = ["divider"];

/// Blocks that contribute a line of their own.
///
/// y-prosemirror nests a BlockNote block's children under a
/// `blockContainer`/`blockGroup` pair, so "is this a block" is decided by the
/// node name and never by depth.
const LINE_BLOCKS: [&str; 8] = [
    "heading",
    "paragraph",
    "quote",
    "callout",
    "codeBlock",
    "toggleListItem",
    "tableCell",
    "tableHeader",
];

/// Structural nodes carrying no line of their own.
const CONTAINERS: [&str; 4] = ["blockContainer", "blockGroup", "table", "tableRow"];

/// The highest heading level a marker is emitted for; above it the level is
/// clamped rather than producing a run of seven `#`.
const MAX_HEADING_LEVEL: i64 = 6;

fn list_marker(name: &str) -> Option<&'static str> {
    LIST_MARKERS
        .iter()
        .find(|(block, _)| *block == name)
        .map(|(_, marker)| *marker)
}

fn is_line_block(name: &str) -> bool {
    LINE_BLOCKS.contains(&name) || list_marker(name).is_some()
}

fn is_container(name: &str) -> bool {
    CONTAINERS.contains(&name)
}

fn is_skipped(name: &str) -> bool {
    SKIPPED_BLOCKS.contains(&name)
}

/// Inline content is defined by exclusion: anything that is not a line block, a
/// container or a skipped block belongs to the line its parent emits.
///
/// Defining it this way is what keeps an unknown inline type — a mark or a
/// mention a later schema adds — inside the text instead of dropped.
fn is_inline(name: &str) -> bool {
    !is_line_block(name) && !is_container(name) && !is_skipped(name)
}

/// The plain text of a note body, one line per block, joined with `\n`.
///
/// An empty document is the empty string, not a newline.
pub fn extract_text(document: &Document) -> Result<String, CrdtError> {
    document.read(|txn| extract_text_in(txn))
}

/// The same walk against a read transaction the caller already holds.
fn extract_text_in<T: ReadTxn>(txn: &T) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) {
        walk(&fragment, txn, &mut lines);
    }
    lines.join("\n")
}

fn walk<F, T>(node: &F, txn: &T, lines: &mut Vec<String>)
where
    F: XmlFragment,
    T: ReadTxn,
{
    for child in node.children(txn) {
        match child {
            XmlOut::Text(text) => {
                let line = visible_text(&text.get_string(txn));
                if !line.is_empty() {
                    lines.push(line);
                }
            }
            XmlOut::Element(element) => walk_element(&element, txn, lines),
            // A nested fragment is not an element and carries no line; the
            // reference port skips it for the same reason (PARITY).
            XmlOut::Fragment(_) => {}
        }
    }
}

fn walk_element<T: ReadTxn>(element: &XmlElementRef, txn: &T, lines: &mut Vec<String>) {
    let tag = element.tag().clone();
    let name: &str = tag.as_ref();

    if is_skipped(name) {
        return;
    }

    if is_container(name) {
        walk(element, txn, lines);
        return;
    }

    if is_line_block(name) {
        let marker = if name == "heading" {
            heading_marker(element, txn)
        } else {
            list_marker(name).unwrap_or("").to_owned()
        };
        let line = trim_end_js(&format!("{marker}{}", inline_text(element, txn)));
        if !line.is_empty() {
            lines.push(line);
        }

        // A block may nest further blocks — a list inside a list item, a row
        // inside a table — and those contribute their own lines, AFTER this
        // one. Only the block children are followed: the inline children are
        // already in the line above, and walking them again would duplicate it.
        for grandchild in element.children(txn) {
            if let XmlOut::Element(inner) = grandchild
                && !is_inline(inner.tag().as_ref())
            {
                walk_element(&inner, txn, lines);
            }
        }
        return;
    }

    // An unknown element is walked rather than dropped: a block type this port
    // does not know must still contribute its text. Never strip what you do not
    // recognise (FR-033's habit, applied to the fragment).
    walk(element, txn, lines);
}

/// The concatenated text of a node's own **inline** descendants, marks
/// discarded.
///
/// Stops at a nested block: that block contributes its own line, and folding it
/// into the parent's would silently merge two paragraphs into one.
fn inline_text<T: ReadTxn>(node: &XmlElementRef, txn: &T) -> String {
    let mut out = String::new();
    for child in node.children(txn) {
        match child {
            XmlOut::Text(text) => out.push_str(&visible_text(&text.get_string(txn))),
            XmlOut::Element(element) => {
                if is_inline(element.tag().as_ref()) {
                    out.push_str(&inline_text(&element, txn));
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }
    out
}

/// `#` × level, clamped to 1..=6, then a space.
///
/// PARITY: the level is read as a string and parsed the way JavaScript's
/// `parseInt` reads it, because y-prosemirror stores the attribute as a string
/// and the reference port parses it with `parseInt`. An absent, empty or
/// unparseable level is level 1, never a missing marker.
fn heading_marker<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> String {
    let level = element
        .get_attribute(txn, "level")
        .map(|value| value.to_string(txn))
        .and_then(|text| parse_int_prefix(&text))
        .unwrap_or(1)
        .clamp(1, MAX_HEADING_LEVEL);

    let mut marker = "#".repeat(level as usize);
    marker.push(' ');
    marker
}

/// JavaScript `parseInt(text, 10)`: leading whitespace, an optional sign, then
/// the longest run of decimal digits. `None` stands for `NaN`.
fn parse_int_prefix(text: &str) -> Option<i64> {
    let rest = text.trim_start();
    let (negative, digits) = match rest.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, rest.strip_prefix('+').unwrap_or(rest)),
    };
    let run: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if run.is_empty() {
        return None;
    }
    // A level far outside 1..=6 saturates and is clamped by the caller, so an
    // absurd attribute is a `#`, not a panic.
    let value = run.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// PARITY: `yrs` and Yjs both render an `XmlText`'s formatting marks as XML
/// tags around the text, and the reference port strips them with
/// `/<[^>]*>/g`. This is that regex, character by character: from each `<`, up
/// to and including the next `>`, is removed; a `<` with no later `>` is kept.
///
/// It follows that a literal `<…>` a user typed is also removed, in both ports
/// alike. That is a property of the contract rather than of this
/// implementation, and deviating from it here would break the digest for a note
/// nobody would think to test.
fn visible_text(rendered: &str) -> String {
    let mut out = String::with_capacity(rendered.len());
    let mut rest = rendered;
    while let Some(open) = rest.find('<') {
        let after_open = &rest[open + 1..];
        match after_open.find('>') {
            Some(close) => {
                out.push_str(&rest[..open]);
                rest = &after_open[close + 1..];
            }
            // No `>` anywhere after this `<`, so no later `<` can close either:
            // the remainder is literal text.
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// PARITY: JavaScript's `String.prototype.trimEnd`, whose whitespace set is
/// Unicode `White_Space` — which is `char::is_whitespace` — plus `U+FEFF`,
/// which Rust does not consider whitespace.
fn trim_end_js(line: &str) -> String {
    line.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use yrs::{
        Doc, StateVector, Text as _, Transact as _, TransactionMut, XmlElementPrelim,
        XmlElementRef, XmlFragmentRef, XmlTextPrelim,
    };

    use super::super::registry::{DocumentRegistry, NOTE_DOC_ROOTS, UpdateSink};
    use super::*;

    #[test]
    fn the_body_fragment_is_the_root_the_registry_types() {
        assert_eq!(NOTE_DOC_ROOTS[0].0, BODY_FRAGMENT);
    }

    /// Builds a document the only supported way: author the update in a
    /// separate `Doc`, then apply the bytes through the registry's door.
    fn extracted(build: impl FnOnce(&mut TransactionMut, &XmlFragmentRef)) -> String {
        let author = Doc::with_client_id(1);
        let fragment = author.get_or_insert_xml_fragment(BODY_FRAGMENT);
        {
            let mut txn = author.transact_mut();
            build(&mut txn, &fragment);
        }
        let update = author
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let sink: UpdateSink = Arc::new(|_, _| {});
        let registry = DocumentRegistry::new("device-a", sink);
        let document = registry.get_or_open("abc123def456").expect("open");
        document.apply_durable_update(&update).expect("apply");
        extract_text(&document).expect("extract")
    }

    /// `blockContainer > <block> > text`, the shape y-prosemirror gives a
    /// BlockNote block.
    fn block(
        txn: &mut TransactionMut,
        parent: &XmlFragmentRef,
        block_type: &str,
        text: &str,
    ) -> XmlElementRef {
        let container = parent.push_back(txn, XmlElementPrelim::empty("blockContainer"));
        let inner = container.push_back(txn, XmlElementPrelim::empty(block_type));
        if !text.is_empty() {
            inner.push_back(txn, XmlTextPrelim::new(text));
        }
        inner
    }

    #[test]
    fn a_paragraph_is_its_own_text() {
        assert_eq!(
            extracted(|txn, body| {
                block(txn, body, "paragraph", "One plain paragraph.");
            }),
            "One plain paragraph."
        );
    }

    #[test]
    fn heading_levels_are_kept_and_clamped() {
        let extracted = extracted(|txn, body| {
            for (level, text) in [("1", "One"), ("3", "Three"), ("9", "Nine"), ("0", "Zero")] {
                let heading = block(txn, body, "heading", text);
                heading.insert_attribute(txn, "level", level);
            }
        });

        assert_eq!(extracted, "# One\n### Three\n###### Nine\n# Zero");
    }

    #[test]
    fn a_heading_with_no_level_is_level_one() {
        assert_eq!(
            extracted(|txn, body| {
                block(txn, body, "heading", "Unlevelled");
            }),
            "# Unlevelled"
        );
    }

    #[test]
    fn a_heading_with_an_unparseable_level_is_level_one() {
        assert_eq!(
            extracted(|txn, body| {
                let heading = block(txn, body, "heading", "Nonsense");
                heading.insert_attribute(txn, "level", "not a number");
            }),
            "# Nonsense"
        );
    }

    #[test]
    fn list_markers_are_kept_and_numbering_is_not_reconstructed() {
        let extracted = extracted(|txn, body| {
            block(txn, body, "bulletListItem", "Alpha");
            block(txn, body, "numberedListItem", "First");
            block(txn, body, "numberedListItem", "Second");
            block(txn, body, "checkListItem", "Done");
            block(txn, body, "taskBlock", "Task");
        });

        assert_eq!(extracted, "- Alpha\n1. First\n1. Second\n- Done\n- Task");
    }

    #[test]
    fn a_nested_list_contributes_its_own_lines_without_indentation() {
        let extracted = extracted(|txn, body| {
            let outer = block(txn, body, "bulletListItem", "Outer");
            let group = outer.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let inner = container.push_back(txn, XmlElementPrelim::empty("bulletListItem"));
            inner.push_back(txn, XmlTextPrelim::new("Inner"));
        });

        assert_eq!(extracted, "- Outer\n- Inner");
    }

    #[test]
    fn an_empty_document_is_the_empty_string() {
        assert_eq!(extracted(|_, _| {}), "");
    }

    #[test]
    fn an_empty_paragraph_contributes_no_line() {
        let extracted = extracted(|txn, body| {
            block(txn, body, "paragraph", "Before");
            block(txn, body, "paragraph", "");
            block(txn, body, "paragraph", "After");
        });

        assert_eq!(
            extracted, "Before\nAfter",
            "an empty block must not become a blank line"
        );
    }

    #[test]
    fn an_empty_list_item_keeps_its_bullet() {
        let extracted = extracted(|txn, body| {
            block(txn, body, "paragraph", "Before");
            block(txn, body, "bulletListItem", "");
            block(txn, body, "paragraph", "After");
        });

        // PARITY, and deliberate: the marker makes the line non-empty, and the
        // trailing space is trimmed off it, so an empty list item is `-`. The
        // reference port does exactly this; an empty *paragraph* still
        // disappears, because it has no marker to survive on.
        assert_eq!(extracted, "Before\n-\nAfter");
    }

    #[test]
    fn a_whitespace_only_block_contributes_no_line() {
        assert_eq!(
            extracted(|txn, body| {
                block(txn, body, "paragraph", "   \u{feff}");
            }),
            ""
        );
    }

    #[test]
    fn trailing_whitespace_is_trimmed_and_leading_whitespace_is_not() {
        assert_eq!(
            extracted(|txn, body| {
                block(txn, body, "paragraph", "  kept   ");
            }),
            "  kept"
        );
    }

    #[test]
    fn a_divider_is_dropped() {
        let extracted = extracted(|txn, body| {
            block(txn, body, "paragraph", "Above");
            block(txn, body, "divider", "");
            block(txn, body, "paragraph", "Below");
        });

        assert_eq!(extracted, "Above\nBelow");
    }

    #[test]
    fn a_table_gives_one_line_per_cell() {
        let extracted = extracted(|txn, body| {
            let table = block(txn, body, "table", "");
            let header = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
            for text in ["Name", "Value"] {
                let cell = header.push_back(txn, XmlElementPrelim::empty("tableHeader"));
                cell.push_back(txn, XmlTextPrelim::new(text));
            }
            let row = table.push_back(txn, XmlElementPrelim::empty("tableRow"));
            for text in ["alpha", "1"] {
                let cell = row.push_back(txn, XmlElementPrelim::empty("tableCell"));
                cell.push_back(txn, XmlTextPrelim::new(text));
            }
        });

        assert_eq!(extracted, "Name\nValue\nalpha\n1");
    }

    #[test]
    fn a_toggle_keeps_its_summary_and_its_body() {
        let extracted = extracted(|txn, body| {
            let toggle = block(txn, body, "toggleListItem", "Summary line");
            let group = toggle.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new("Hidden body."));
        });

        assert_eq!(extracted, "Summary line\nHidden body.");
    }

    #[test]
    fn an_unknown_block_still_contributes_its_text() {
        let extracted = extracted(|txn, body| {
            let container = body.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let unknown = container.push_back(txn, XmlElementPrelim::empty("someFutureBlock"));
            let paragraph = unknown.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new("Text a later schema added."));
        });

        assert_eq!(extracted, "Text a later schema added.");
    }

    #[test]
    fn an_unknown_inline_type_stays_inside_its_line() {
        let extracted = extracted(|txn, body| {
            let paragraph = block(txn, body, "paragraph", "before ");
            let mention = paragraph.push_back(txn, XmlElementPrelim::empty("someFutureMention"));
            mention.push_back(txn, XmlTextPrelim::new("inline"));
            paragraph.push_back(txn, XmlTextPrelim::new(" after"));
        });

        assert_eq!(
            extracted, "before inline after",
            "an inline type this port does not know belongs to its parent's line"
        );
    }

    #[test]
    fn marks_are_discarded_and_only_the_visible_text_survives() {
        let extracted = extracted(|txn, body| {
            let paragraph = block(txn, body, "paragraph", "");
            let text = paragraph.push_back(txn, XmlTextPrelim::new("bold plain"));
            text.format(txn, 0, 4, [("bold".into(), true.into())].into());
        });

        assert_eq!(extracted, "bold plain");
    }

    #[test]
    fn utf8_survives_the_walk_unchanged() {
        assert_eq!(
            extracted(|txn, body| {
                block(txn, body, "paragraph", "Grüße, 世界 — «citation» 🙂");
            }),
            "Grüße, 世界 — «citation» 🙂"
        );
    }

    #[test]
    fn the_tag_stripper_reproduces_the_reference_regex() {
        assert_eq!(visible_text("<bold>bold</bold> plain"), "bold plain");
        assert_eq!(visible_text("no tags at all"), "no tags at all");
        assert_eq!(visible_text("a < b"), "a < b", "an unclosed `<` is literal");
        assert_eq!(visible_text("a > b"), "a > b");
        assert_eq!(
            visible_text("a <b <c> d"),
            "a  d",
            "`[^>]*` cannot cross `>`"
        );
        assert_eq!(
            visible_text("<link href=\"https://example.invalid\">link</link>"),
            "link",
            "a link target is an attribute and never reaches the text"
        );
    }

    #[test]
    fn parse_int_reads_a_digit_prefix_and_nothing_else() {
        assert_eq!(parse_int_prefix("2"), Some(2));
        assert_eq!(parse_int_prefix(" 3abc"), Some(3));
        assert_eq!(parse_int_prefix("-1"), Some(-1));
        assert_eq!(parse_int_prefix("abc"), None);
        assert_eq!(parse_int_prefix(""), None);
    }
}
