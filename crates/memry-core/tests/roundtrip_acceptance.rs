//! Round-trip acceptance, for the parts a core test can actually prove.
//!
//! R03, R04 and R05 are protocol invariants about what survives an edit and
//! what happens when two devices edit the same block offline. All three are
//! properties of the CRDT layer, so they are tested here against the real
//! writer rather than described in a checklist and hoped for.
//!
//! **R01, R02, R06 and R07 are not here, and are not silently counted as
//! done.** They each need a second client — a desktop writing the vault file,
//! or a server holding chunks — and a test in this crate cannot stand in for
//! one. Asserting a weaker in-process property and labelling it R01 would be
//! worse than leaving it open.

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::text_extract::extract_text;
use yrs::{
    Any, Array as _, Doc, Map as _, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim,
    XmlFragment as _, XmlTextPrelim,
};

fn opened(id: &str, update: &[u8]) -> Arc<Document> {
    opened_on("device-roundtrip", id, update)
}

/// A document open on a **named device**.
///
/// The device id matters and is not decoration: the registry derives the
/// Y.Doc `clientID` from it, and two documents sharing a `clientID` mint
/// conflicting struct ids — their updates then merge into garbled text rather
/// than converging. Every multi-device test below therefore names each side,
/// which is what two real devices are.
fn opened_on(device: &str, id: &str, update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new(device, sink);
    let document = registry.get_or_open(id).expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

/// A note carrying the body **and** the other six roots §12.5.0 names.
///
/// Built as one update so the document a test edits is the document a real
/// note is: a body alone would make R03 pass for the wrong reason.
fn note_with_every_root() -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let meta = doc.get_or_insert_map("meta");
    let tags = doc.get_or_insert_array("tags");
    let markdown_source = doc.get_or_insert_map("markdownSource");
    let definitions = doc.get_or_insert_array("linkReferenceDefinitions");
    let usages = doc.get_or_insert_array("linkReferenceUsages");
    let critic = doc.get_or_insert_array("criticMarkupMarks");

    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for (index, (id, text)) in [("a", "first"), ("b", "second")].iter().enumerate() {
        let container = group.insert(
            &mut txn,
            index as u32,
            XmlElementPrelim::empty("blockContainer"),
        );
        container.insert_attribute(&mut txn, "id", *id);
        let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        block.insert(&mut txn, 0, XmlTextPrelim::new(*text));
    }

    meta.insert(&mut txn, "title", "A note that carries everything");
    tags.push_back(&mut txn, "research");
    markdown_source.insert(&mut txn, "record", "the original spelling");
    definitions.push_back(&mut txn, "[d]: https://example.com");
    usages.push_back(&mut txn, "d");
    critic.push_back(
        &mut txn,
        Any::Map(
            [
                ("id".to_owned(), Any::String("c1".into())),
                ("kind".to_owned(), Any::String("comment".into())),
                ("visibleText".to_owned(), Any::String("first".into())),
                ("start".to_owned(), Any::Number(0.0)),
                ("end".to_owned(), Any::Number(5.0)),
            ]
            .into_iter()
            .collect::<std::collections::HashMap<String, Any>>()
            .into(),
        ),
    );

    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Reads the six non-body roots, so a test can compare before and after.
fn other_roots(document: &Document) -> Vec<String> {
    document
        .read(|txn| {
            let mut out = Vec::new();
            out.push(format!(
                "meta.title={:?}",
                txn.get_map("meta")
                    .and_then(|map| map.get(txn, "title").map(|value| value.to_string(txn)))
            ));
            for name in [
                "tags",
                "linkReferenceDefinitions",
                "linkReferenceUsages",
                "criticMarkupMarks",
            ] {
                let values: Vec<String> = txn
                    .get_array(name)
                    .map(|array| array.iter(txn).map(|value| value.to_string(txn)).collect())
                    .unwrap_or_default();
                out.push(format!("{name}={values:?}"));
            }
            out.push(format!(
                "markdownSource.record={:?}",
                txn.get_map("markdownSource")
                    .and_then(|map| map.get(txn, "record").map(|value| value.to_string(txn)))
            ));
            out
        })
        .expect("read")
}

// MARK: - R03

/// **R03: editing one block must not disturb the other six roots.**
///
/// §12.5.0's root table is a list of what each drop costs, and
/// `criticMarkupMarks` is the worst of them: losing it deletes every
/// suggestion and comment from the user's file on desktop's next write-back,
/// and turns source restoration back on so the body is re-spelled too.
///
/// This is the test that would have caught a writer that rebuilt the document
/// through typed accessors instead of editing it in place.
#[test]
fn editing_a_block_leaves_every_other_root_untouched() {
    let document = opened("r03aaaaaaaaa1", &note_with_every_root());
    let before = other_roots(&document);

    apply(
        &document,
        &BlockEdit::SetText {
            block_id: "a".to_owned(),
            text: "first, edited".to_owned(),
        },
    )
    .expect("edit");
    apply(
        &document,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "appended".to_owned(),
            new_block_id: "c".to_owned(),
        },
    )
    .expect("append");

    assert_eq!(
        other_roots(&document),
        before,
        "an edit to the body changed another root"
    );
    // And the edit really happened, or the comparison above proves nothing.
    assert!(
        extract_text(&document)
            .expect("text")
            .contains("first, edited")
    );
}

// MARK: - R04

/// **R04: a block type this build has never seen survives an edit to its
/// neighbour** (FR-033).
///
/// The failure this guards against is a writer that rebuilds the body from
/// the types it knows: every unknown block would vanish, and the user would
/// lose content that another client wrote perfectly correctly.
#[test]
fn a_block_type_this_build_has_never_seen_survives_an_edit_beside_it() {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let update = {
        let mut txn = doc.transact_mut();
        let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));

        let known = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        known.insert_attribute(&mut txn, "id", "known");
        let paragraph = known.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new("ordinary"));

        // A type from a future version, with props this build cannot name.
        let strange = group.insert(&mut txn, 1, XmlElementPrelim::empty("blockContainer"));
        strange.insert_attribute(&mut txn, "id", "strange");
        let block = strange.insert(&mut txn, 0, XmlElementPrelim::empty("mermaidDiagram"));
        block.insert_attribute(&mut txn, "diagramKind", "sequence");
        block.insert(&mut txn, 0, XmlTextPrelim::new("A->>B: hello"));

        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    let document = opened("r04aaaaaaaaa1", &update);

    apply(
        &document,
        &BlockEdit::SetText {
            block_id: "known".to_owned(),
            text: "ordinary, edited".to_owned(),
        },
    )
    .expect("edit the neighbour");

    let blocks = extract_blocks(&document).expect("blocks");
    let strange = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("strange"))
        .expect("the unknown block must survive an edit to its neighbour");
    assert_eq!(strange.kind, "mermaidDiagram", "its type must be preserved");
    assert_eq!(
        strange
            .inline
            .iter()
            .map(|run| run.text.as_str())
            .collect::<String>(),
        "A->>B: hello",
        "and its content"
    );
    // And its unknown prop, which is the part a rebuild would drop first.
    assert!(
        strange
            .props
            .iter()
            .any(|prop| prop.name == "diagramKind" && prop.value == "sequence"),
        "an unknown prop must survive too: {:?}",
        strange.props
    );
}

/// Turning a block into another must not take its unknown neighbour with it.
#[test]
fn an_unknown_block_survives_a_neighbour_changing_type() {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let update = {
        let mut txn = doc.transact_mut();
        let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let known = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        known.insert_attribute(&mut txn, "id", "known");
        known.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        let strange = group.insert(&mut txn, 1, XmlElementPrelim::empty("blockContainer"));
        strange.insert_attribute(&mut txn, "id", "strange");
        strange.insert(&mut txn, 0, XmlElementPrelim::empty("someFutureBlock"));
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    let document = opened("r04aaaaaaaaa2", &update);

    apply(
        &document,
        &BlockEdit::TurnInto {
            block_id: "known".to_owned(),
            kind: "heading".to_owned(),
        },
    )
    .expect("turn into");

    let blocks = extract_blocks(&document).expect("blocks");
    assert!(
        blocks.iter().any(|block| block.kind == "someFutureBlock"),
        "the unknown block vanished when its neighbour changed type"
    );
}

// MARK: - R05

/// **R05: two devices editing the same block offline converge, and neither
/// edit is lost.**
///
/// This is the property the whole CRDT choice exists for, and the one
/// §12.5.0.1 says a whole-fragment replace quietly breaks: there, both devices
/// agree afterwards and one device's work is simply gone. Convergence alone is
/// therefore not the assertion — **both edits surviving** is.
#[test]
fn two_devices_editing_the_same_note_offline_converge_with_neither_edit_lost() {
    let seed = note_with_every_root();

    // Two devices, each holding the same starting note and neither able to
    // see the other.
    let phone = opened_on("the-phone", "r05aaaaaaaaa1", &seed);
    let desktop = opened_on("the-desktop", "r05aaaaaaaaa1", &seed);

    apply(
        &phone,
        &BlockEdit::InsertParagraph {
            after_block_id: Some("a".to_owned()),
            text: "written on the phone".to_owned(),
            new_block_id: "phone-1".to_owned(),
        },
    )
    .expect("the phone's edit");
    apply(
        &desktop,
        &BlockEdit::InsertParagraph {
            after_block_id: Some("b".to_owned()),
            text: "written on the desktop".to_owned(),
            new_block_id: "desktop-1".to_owned(),
        },
    )
    .expect("the desktop's edit");

    // They reconnect and exchange everything they have.
    let from_phone = phone
        .read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()))
        .expect("encode");
    let from_desktop = desktop
        .read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()))
        .expect("encode");
    desktop.apply_durable_update(&from_phone).expect("merge");
    phone.apply_durable_update(&from_desktop).expect("merge");

    let phone_text = extract_text(&phone).expect("text");
    let desktop_text = extract_text(&desktop).expect("text");

    // Converged.
    assert_eq!(phone_text, desktop_text, "the two devices did not converge");
    // And — the part that matters — neither edit was lost.
    assert!(
        phone_text.contains("written on the phone"),
        "the phone's own edit is missing: {phone_text}"
    );
    assert!(
        phone_text.contains("written on the desktop"),
        "the desktop's edit was lost in the merge: {phone_text}"
    );
    // The original content is still there too.
    assert!(phone_text.contains("first") && phone_text.contains("second"));
}

/// The same, for two edits to the **same block's text**, which is the case
/// where a naive implementation quietly keeps one and drops the other.
#[test]
fn two_devices_editing_the_same_block_both_end_up_with_the_same_answer() {
    let seed = note_with_every_root();
    let phone = opened_on("the-phone", "r05aaaaaaaaa3", &seed);
    let desktop = opened_on("the-desktop", "r05aaaaaaaaa3", &seed);

    apply(
        &phone,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "textColor".to_owned(),
            value: "red".to_owned(),
        },
    )
    .expect("the phone's edit");
    apply(
        &desktop,
        &BlockEdit::SetProp {
            block_id: "b".to_owned(),
            name: "textAlignment".to_owned(),
            value: "center".to_owned(),
        },
    )
    .expect("the desktop's edit");

    let from_phone = phone
        .read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()))
        .expect("encode");
    let from_desktop = desktop
        .read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()))
        .expect("encode");
    desktop.apply_durable_update(&from_phone).expect("merge");
    phone.apply_durable_update(&from_desktop).expect("merge");

    let phone_blocks = extract_blocks(&phone).expect("blocks");
    let desktop_blocks = extract_blocks(&desktop).expect("blocks");
    assert_eq!(phone_blocks, desktop_blocks, "the two devices disagree");

    // Both props survived, on their own blocks.
    let prop = |blocks: &[memry_core::crdt::blocks::Block], id: &str, name: &str| {
        blocks
            .iter()
            .find(|block| block.id.as_deref() == Some(id))
            .and_then(|block| {
                block
                    .props
                    .iter()
                    .find(|prop| prop.name == name)
                    .map(|prop| prop.value.clone())
            })
    };
    assert_eq!(
        prop(&phone_blocks, "a", "textColor").as_deref(),
        Some("red")
    );
    assert_eq!(
        prop(&phone_blocks, "b", "textAlignment").as_deref(),
        Some("center")
    );
}

/// And the roots survive a merge, not only a local edit: a device that
/// rebuilt its document on receiving an update would drop them here instead.
#[test]
fn the_other_roots_survive_a_merge_from_another_device() {
    let seed = note_with_every_root();
    let phone = opened_on("the-phone", "r05aaaaaaaaa5", &seed);
    let desktop = opened_on("the-desktop", "r05aaaaaaaaa5", &seed);
    let before = other_roots(&phone);

    apply(
        &desktop,
        &BlockEdit::SetText {
            block_id: "a".to_owned(),
            text: "edited elsewhere".to_owned(),
        },
    )
    .expect("edit");
    let from_desktop = desktop
        .read(|txn| txn.encode_state_as_update_v1(&yrs::StateVector::default()))
        .expect("encode");
    phone.apply_durable_update(&from_desktop).expect("merge");

    assert_eq!(
        other_roots(&phone),
        before,
        "a merge from another device disturbed a root"
    );
    assert!(
        extract_text(&phone)
            .expect("text")
            .contains("edited elsewhere")
    );
}
