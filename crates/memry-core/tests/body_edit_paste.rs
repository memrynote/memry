//! `PasteMarkdown`, plain text pasted into a block (iOS, as desktop's paste
//! handler reads `text/plain`): the blocks the markdown makes go in at the
//! caret, the text after the caret below them.

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::markdown_seed::plan;
use memry_core::crdt::registry::Document;
use memry_core::crdt::registry::UpdateSink;
use yrs::{
    Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim,
};

fn opened(blocks: &[(&str, &str, &str)]) -> Arc<Document> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for (index, (id, kind, text)) in blocks.iter().enumerate() {
        let container = group.insert(
            &mut txn,
            index as u32,
            XmlElementPrelim::empty("blockContainer"),
        );
        container.insert_attribute(&mut txn, "id", *id);
        let block = container.insert(&mut txn, 0, XmlElementPrelim::empty(*kind));
        if !text.is_empty() {
            block.insert(&mut txn, 0, XmlTextPrelim::new(*text));
        }
    }
    let update = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-body-paste", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(&update).expect("apply");
    document
}

/// The edit with one id per block the paste writes, `p0`, `p1`, …, then
/// `tail` when the caret is inside the block's text.
fn paste(block_id: &str, at: u32, markdown: &str, tail: bool) -> BlockEdit {
    let count = plan(markdown).blocks.len();
    let mut ids: Vec<String> = (0..count).map(|index| format!("p{index}")).collect();
    if tail {
        ids.push("tail".to_owned());
    }
    BlockEdit::PasteMarkdown {
        block_id: block_id.to_owned(),
        at,
        markdown: markdown.to_owned(),
        new_block_ids: ids,
    }
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

/// Each block as `id kind "text"`, with a heading's level after its kind.
fn shown(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .map(|block| {
            let text: String = block.inline.iter().map(|run| run.text.as_str()).collect();
            let level = block
                .props
                .iter()
                .find(|prop| block.kind == "heading" && prop.name == "level")
                .map(|prop| format!(" {}", prop.value))
                .unwrap_or_default();
            format!(
                "{} {}{level} {text:?}",
                block.id.unwrap_or_default(),
                block.kind
            )
        })
        .collect()
}

const REPORT: &str = "# Coral Reef Bleaching\n\
## Why it happens\n\
**Primary drivers:**\n\
1. **Ocean warming** — heat stress\n\
2. **Acidification** — lower pH\n\
\n\
---\n\
- one bullet";

#[test]
fn a_document_pasted_into_an_empty_block_becomes_its_blocks() {
    let document = opened(&[("a", "paragraph", ""), ("b", "paragraph", "after")]);
    edit(&document, paste("a", 0, REPORT, false));
    assert_eq!(
        shown(&document),
        [
            "p0 heading 1 \"Coral Reef Bleaching\"",
            "p1 heading 2 \"Why it happens\"",
            "p2 paragraph \"Primary drivers:\"",
            "p3 numberedListItem \"Ocean warming — heat stress\"",
            "p4 numberedListItem \"Acidification — lower pH\"",
            "p5 divider \"\"",
            "p6 bulletListItem \"one bullet\"",
            "b paragraph \"after\"",
        ]
    );
    let blocks = extract_blocks(&document).expect("blocks");
    let bold = |index: usize, text: &str| {
        blocks[index]
            .inline
            .iter()
            .any(|run| run.text == text && run.marks.iter().any(|mark| mark == "bold"))
    };
    assert!(bold(2, "Primary drivers:"), "{:?}", blocks[2].inline);
    assert!(bold(3, "Ocean warming"), "{:?}", blocks[3].inline);
}

#[test]
fn the_text_after_the_caret_goes_below_the_pasted_blocks() {
    let document = opened(&[("a", "bulletListItem", "abcd")]);
    edit(&document, paste("a", 2, "x\n\n**y**", true));
    assert_eq!(
        shown(&document),
        [
            "a bulletListItem \"ab\"",
            "p0 paragraph \"x\"",
            "p1 paragraph \"y\"",
            "tail bulletListItem \"cd\"",
        ]
    );
}

#[test]
fn at_a_blocks_end_or_start_the_block_stays_whole() {
    let document = opened(&[("a", "paragraph", "ab")]);
    edit(&document, paste("a", 2, "# x\ny", false));
    assert_eq!(
        shown(&document),
        [
            "a paragraph \"ab\"",
            "p0 heading 1 \"x\"",
            "p1 paragraph \"y\""
        ]
    );

    let document = opened(&[("a", "paragraph", "ab")]);
    edit(&document, paste("a", 0, "# x\ny", false));
    assert_eq!(
        shown(&document),
        [
            "p0 heading 1 \"x\"",
            "p1 paragraph \"y\"",
            "a paragraph \"ab\""
        ]
    );
}

#[test]
fn crlf_line_endings_parse_as_desktop_reads_them() {
    let document = opened(&[("a", "paragraph", "")]);
    edit(&document, paste("a", 0, "- one\r\n- two\r\n", false));
    assert_eq!(
        shown(&document),
        ["p0 bulletListItem \"one\"", "p1 bulletListItem \"two\""]
    );
}

#[test]
fn a_code_block_or_a_wrong_id_count_is_refused_and_nothing_changes() {
    let document = opened(&[("a", "codeBlock", "let x")]);
    assert!(apply(&document, &paste("a", 5, "# x\ny", false)).is_err());
    assert_eq!(shown(&document), ["a codeBlock \"let x\""]);

    let document = opened(&[("a", "paragraph", "abcd")]);
    assert!(apply(&document, &paste("a", 2, "# x\ny", false)).is_err());
    assert_eq!(shown(&document), ["a paragraph \"abcd\""]);
}

/// What an assistant's answer copied as markdown holds: each construct is the
/// block desktop's converter builds, not its source lines as text.
const ASSISTANT: &str = "| Name | Value |\n|---|---|\n| alpha | 1 |\n\n\
> [!note]\n> Callout body\n\n\
$$\nE = mc^2\n$$\n\n\
![chart](https://e.com/c.png)\n\n\
<details data-memry-toggle>\n<summary>Toggle title</summary>\n\nHidden body\n\n</details>\n\n\
```mermaid\ngraph TD\n```";

#[test]
fn an_assistant_answer_pasted_becomes_memry_blocks() {
    let document = opened(&[("a", "paragraph", "")]);
    edit(&document, paste("a", 0, ASSISTANT, false));
    let shown = shown(&document);
    let pasted: Vec<&str> = shown
        .iter()
        .map(String::as_str)
        .filter(|line| line.starts_with('p'))
        .collect();
    assert_eq!(
        pasted,
        [
            "p0 table \"\"",
            "p1 callout \"Callout body\"",
            "p2 mathBlock \"\"",
            "p3 image \"\"",
            "p4 toggleListItem \"Toggle title\"",
            "p5 diagram \"graph TD\"",
        ]
    );
    for nested in [" tableParagraph \"alpha\"", " paragraph \"Hidden body\""] {
        assert!(shown.iter().any(|line| line.ends_with(nested)), "{shown:?}");
    }
}
