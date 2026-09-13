//! The node `notes edit --append` writes, and nothing else (T125).
//!
//! Split out of [`super`] so the shape lives apart from the plumbing: this
//! file answers "what does a block look like in a Y.Doc", and `edit.rs`
//! answers "which note, loaded from where, recorded how".
//!
//! **The node.** `blockContainer > paragraph > XmlText`, the blockContainer
//! carrying an `id` attribute:
//!
//! ```text
//! <blockContainer id="…"><paragraph>the appended text</paragraph></blockContainer>
//! ```
//!
//! Where each part comes from is worth stating, because chapter 12 does not
//! determine all of it (see the report accompanying T125):
//!
//! - the `prosemirror` fragment name is chapter 12 §12.3;
//! - the `blockContainer` / `paragraph` names and their nesting are §12.1.3's
//!   node classes and, byte for byte, the committed `text-extract` vector
//!   `a plain paragraph document`, whose update decodes to exactly this shape;
//! - `paragraph` is one of §12.9's eighteen block types;
//! - the `id` attribute is **not** in any chapter. It is what BlockNote's own
//!   writer emits for every block and what desktop stamps on a block that has
//!   none, so writing one is the shape both of them already agree on rather
//!   than a guess. §12.6 and §12.7 are about the **markdown** spelling of
//!   blocks and inlines, not about the Y.Doc XML, so neither settles this.
//!
//! **Where it goes.** A y-prosemirror document's top node holds exactly one
//! `blockGroup`, and every block hangs off it. A block appended beside that
//! group rather than inside it is not a document the schema can build, and
//! y-prosemirror answers what it cannot build by deleting it — so the append
//! targets the existing `blockGroup` and refuses a layout it does not
//! recognise instead of guessing.

use memry_core::crdt::text_extract::BODY_FRAGMENT;
use memry_core::crypto::sodium;
use yrs::{
    ReadTxn as _, TransactionMut, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _,
    XmlOut, XmlTextPrelim,
};

use crate::session::CliError;

/// The block a `blockContainer` wraps here. One of chapter 12 §12.9's block
/// types, and the only one this command writes.
const PARAGRAPH: &str = "paragraph";
/// y-prosemirror's wrapper for one BlockNote block (chapter 12 §12.1.3).
const BLOCK_CONTAINER: &str = "blockContainer";
/// The single child of a BlockNote document's top node; every block lives in
/// it.
const BLOCK_GROUP: &str = "blockGroup";

/// Inserts `<blockContainer id><paragraph>text</paragraph></blockContainer>`
/// at the end of the document's block list.
///
/// The parent is chosen, never assumed:
///
/// - the last top-level `blockGroup` — a document written by the editor
///   bundle, which is every real note;
/// - the fragment itself, when it already holds `blockContainer`s directly —
///   the shape the committed `text-extract` vectors use;
/// - a `blockGroup` this call creates, when the fragment is empty;
/// - and **nothing else**: a fragment holding some other top-level shape is
///   refused, because a block put in the wrong parent is a document
///   y-prosemirror cannot build and answers by deleting.
pub(super) fn append_paragraph(
    txn: &mut TransactionMut<'_>,
    block_id: &str,
    text: &str,
) -> Result<(), CliError> {
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return Err(CliError::Refused(format!(
            "this document has no `{BODY_FRAGMENT}` fragment (chapter 12 §12.3)"
        )));
    };

    let mut group: Option<XmlElementRef> = None;
    let mut holds_container = false;
    let mut strangers: Vec<String> = Vec::new();
    for child in fragment.children(&*txn) {
        match child {
            XmlOut::Element(element) => match element.tag().as_ref() {
                BLOCK_GROUP => group = Some(element),
                BLOCK_CONTAINER => holds_container = true,
                other => strangers.push(other.to_string()),
            },
            XmlOut::Text(_) => strangers.push("#text".to_string()),
            XmlOut::Fragment(_) => strangers.push("#fragment".to_string()),
        }
    }

    let container = match (group, holds_container) {
        (Some(group), _) => group.push_back(txn, XmlElementPrelim::empty(BLOCK_CONTAINER)),
        (None, true) => fragment.push_back(txn, XmlElementPrelim::empty(BLOCK_CONTAINER)),
        (None, false) if strangers.is_empty() => {
            let group = fragment.push_back(txn, XmlElementPrelim::empty(BLOCK_GROUP));
            group.push_back(txn, XmlElementPrelim::empty(BLOCK_CONTAINER))
        }
        (None, false) => {
            return Err(CliError::Refused(format!(
                "the body of this document holds [{}] at the top level and no `{BLOCK_GROUP}`: \
                 appending a block to a layout this client does not recognise risks a document \
                 the editor cannot build",
                strangers.join(", ")
            )));
        }
    };

    container.insert_attribute(txn, "id", block_id.to_string());
    let paragraph = container.push_back(txn, XmlElementPrelim::empty(PARAGRAPH));
    paragraph.push_back(txn, XmlTextPrelim::new(text));
    Ok(())
}

/// A v4-shaped UUID from the CSPRNG, which is what BlockNote's own `id`
/// generator emits and what desktop stamps on a block missing one.
pub(super) fn block_id() -> String {
    let b = sodium::random_bytes(16);
    let (v, r) = ((b[6] & 0x0f) | 0x40, (b[8] & 0x3f) | 0x80);
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{v:02x}{:02x}-{r:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[7], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

/// Fixtures shared by this module's tests and `edit.rs`'s.
#[cfg(test)]
pub(super) mod fixtures {
    use super::*;
    use memry_core::crdt::registry::{NOTE_DOC_ROOTS, RootKind};
    use yrs::updates::decoder::Decode as _;
    use yrs::{Doc, GetString as _, ReadTxn, Transact as _, Update, XmlFragment};

    /// The committed `text-extract` vector `a plain paragraph document`
    /// (`packages/contracts/test-vectors/text-extract.json`), which decodes to
    /// `blockContainer > paragraph > "One plain paragraph."` and is the only
    /// byte-level fixture of this node shape in the tree.
    pub const PLAIN_PARAGRAPH_VECTOR: &str = "0104f2da95eb060007010b70726f73656d6972726f72030e626c6f636b436f6e7461696e65720700f2da95eb060003097061726167726170680700f2da95eb0601060400f2da95eb0602144f6e6520706c61696e207061726167726170682e00";

    pub fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// A document with the roots typed, as the registry opens one.
    pub fn doc() -> Doc {
        let doc = Doc::with_client_id(7);
        for (name, kind) in NOTE_DOC_ROOTS {
            match kind {
                RootKind::XmlFragment => {
                    doc.get_or_insert_xml_fragment(name);
                }
                RootKind::Map => {
                    doc.get_or_insert_map(name);
                }
                RootKind::Array => {
                    doc.get_or_insert_array(name);
                }
            }
        }
        doc
    }

    pub fn apply(doc: &Doc, bytes: &[u8]) {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(bytes).expect("a v1 update"))
            .expect("applies");
    }

    pub fn text_of(doc: &Doc) -> String {
        let mut lines: Vec<String> = Vec::new();
        let txn = doc.transact();
        let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("the fragment");
        walk(&fragment, &txn, &mut lines);
        lines.join("\n")
    }

    /// The node shape, as names, so a test asserts the tree rather than the
    /// text it happens to produce.
    pub fn shape(doc: &Doc) -> String {
        let txn = doc.transact();
        let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("the fragment");
        fragment.get_string(&txn)
    }

    fn walk<F: XmlFragment, T: ReadTxn>(node: &F, txn: &T, lines: &mut Vec<String>) {
        for child in node.children(txn) {
            match child {
                XmlOut::Element(element) => walk(&element, txn, lines),
                XmlOut::Text(text) => lines.push(text.get_string(txn)),
                XmlOut::Fragment(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use yrs::Transact as _;

    /// The whole point of T125: the node the append writes is the node the
    /// vector pins, so a desktop that renders the vector renders this.
    #[test]
    fn the_appended_node_is_block_container_paragraph_text() {
        let doc = doc();
        apply(&doc, &from_hex(PLAIN_PARAGRAPH_VECTOR));

        {
            let mut txn = doc.transact_mut();
            append_paragraph(&mut txn, "id-1", "from cli").expect("appends");
        }

        let rendered = shape(&doc);
        assert!(
            rendered.contains(
                "<blockContainer id=\"id-1\"><paragraph>from cli</paragraph></blockContainer>"
            ),
            "{rendered}"
        );
        // The existing block is untouched and still first.
        assert_eq!(
            text_of(&doc),
            "One plain paragraph.\nfrom cli",
            "the original text plus the appended paragraph, in that order"
        );
    }

    /// A real note: y-prosemirror's top node holds one `blockGroup`, and a
    /// block appended beside it rather than inside it is a document the schema
    /// cannot build.
    #[test]
    fn a_block_group_document_gets_the_block_inside_the_group() {
        let doc = doc();
        {
            let mut txn = doc.transact_mut();
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("fragment");
            let group = fragment.push_back(&mut txn, XmlElementPrelim::empty(BLOCK_GROUP));
            let container = group.push_back(&mut txn, XmlElementPrelim::empty(BLOCK_CONTAINER));
            container.insert_attribute(&mut txn, "id", "block-0".to_string());
            let paragraph = container.push_back(&mut txn, XmlElementPrelim::empty(PARAGRAPH));
            paragraph.push_back(&mut txn, XmlTextPrelim::new("Written on desktop."));
        }

        {
            let mut txn = doc.transact_mut();
            append_paragraph(&mut txn, "block-1", "from cli").expect("appends");
        }

        let rendered = shape(&doc);
        // One group, still: the new block is a sibling of the old one inside
        // it, never a second top-level node.
        assert_eq!(rendered.matches("<blockGroup>").count(), 1, "{rendered}");
        assert!(
            rendered.ends_with(
                "<blockContainer id=\"block-1\"><paragraph>from cli</paragraph>\
                 </blockContainer></blockGroup>"
            ),
            "{rendered}"
        );
        assert_eq!(text_of(&doc), "Written on desktop.\nfrom cli");
    }

    /// An empty body gets the group the editor would have made, not a bare
    /// block at the top level.
    #[test]
    fn an_empty_body_gets_a_block_group_first() {
        let doc = doc();
        {
            let mut txn = doc.transact_mut();
            append_paragraph(&mut txn, "block-1", "from cli").expect("appends");
        }
        assert_eq!(
            shape(&doc),
            "<blockGroup><blockContainer id=\"block-1\"><paragraph>from cli</paragraph>\
             </blockContainer></blockGroup>"
        );
    }

    /// A layout this client does not recognise is refused rather than guessed
    /// at. A block in the wrong parent is deleted by y-prosemirror's repair,
    /// and a silent delete is a lost edit.
    #[test]
    fn an_unrecognised_top_level_layout_is_refused() {
        let doc = doc();
        {
            let mut txn = doc.transact_mut();
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("fragment");
            fragment.push_back(&mut txn, XmlElementPrelim::empty("somethingElse"));
        }
        let mut txn = doc.transact_mut();
        let refused = append_paragraph(&mut txn, "block-1", "from cli");
        assert!(
            matches!(&refused, Err(CliError::Refused(message)) if message.contains("somethingElse")),
            "{refused:?}"
        );
    }

    /// What the desktop actually receives is the update, not this process's
    /// document: the same bytes applied to a peer holding only the original
    /// state must produce the same tree.
    #[test]
    fn the_update_alone_carries_the_append_to_a_peer() {
        let base = from_hex(PLAIN_PARAGRAPH_VECTOR);
        let author = doc();
        apply(&author, &base);

        let before = author.transact().state_vector();
        {
            let mut txn = author.transact_mut();
            append_paragraph(&mut txn, "id-1", "from cli").expect("appends");
        }
        let update = author.transact().encode_diff_v1(&before);

        let peer = doc();
        apply(&peer, &base);
        apply(&peer, &update);

        assert_eq!(text_of(&peer), "One plain paragraph.\nfrom cli");
        assert_eq!(shape(&peer), shape(&author));
    }

    /// The `id` BlockNote's own writer emits is a v4 UUID, and desktop stamps
    /// `crypto.randomUUID()` on a block missing one; this is the same shape
    /// from the same kind of source.
    #[test]
    fn a_block_id_is_a_v4_shaped_uuid_and_never_repeats() {
        let first = block_id();
        assert_eq!(first.len(), 36);
        assert_eq!(first.as_bytes()[14], b'4');
        assert_ne!(first, block_id());
    }
}
