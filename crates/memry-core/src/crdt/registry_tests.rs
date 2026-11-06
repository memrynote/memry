//! Tests of [`super`]: the registry's rules, each against a real `yrs` document.

use super::*;
use yrs::{GetString as _, Map as _, XmlFragment as _, XmlTextPrelim};

impl Document {
    /// A minimal write used only by this module's tests: the smallest thing
    /// that produces an update, with no block shape around the text.
    fn write_text_for_test(&self, value: &str) -> Result<(), CrdtError> {
        let mut txn = self
            .doc
            .try_transact_mut()
            .map_err(|err| busy(&self.id, err))?;
        let fragment = txn
            .get_xml_fragment("prosemirror")
            .expect("the root is typed at open");
        let len = fragment.len(&txn);
        fragment.insert(&mut txn, len, XmlTextPrelim::new(value));
        Ok(())
    }
}

/// Every `(doc_id, update)` the sink was handed, in order.
type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

fn collector() -> (UpdateSink, Seen) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    let sink: UpdateSink = Arc::new(move |id: &str, bytes: &[u8]| {
        sink_seen
            .lock()
            .expect("sink mutex")
            .push((id.to_owned(), bytes.to_vec()));
    });
    (sink, seen)
}

fn registry(device_id: &str) -> (DocumentRegistry, Seen) {
    let (sink, seen) = collector();
    (DocumentRegistry::new(device_id, sink), seen)
}

#[test]
fn the_client_id_is_stable_per_device_and_inside_the_yjs_range() {
    let a = client_id_from_device_id("device-a");
    let b = client_id_from_device_id("device-b");

    assert_eq!(a, client_id_from_device_id("device-a"));
    assert_ne!(a, b);
    assert!(
        a < 1u64 << 53,
        "a client id must stay inside JavaScript's exact range"
    );
    assert!(b < 1u64 << 53);
}

#[test]
fn the_same_id_gives_the_same_document() {
    let (registry, _) = registry("device-a");

    let first = registry.get_or_open("abc123def456").expect("open");
    let second = registry.get_or_open("abc123def456").expect("reopen");

    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(registry.len(), 1);
    assert_eq!(first.client_id(), client_id_from_device_id("device-a"));
}

#[test]
fn a_journal_id_takes_the_same_path_as_a_note_id() {
    let (registry, _) = registry("device-a");

    let note = registry.get_or_open("abc123def456").expect("note");
    let journal = registry.get_or_open("j2026-04-16").expect("journal");

    assert_eq!(note.client_id(), journal.client_id());
    assert_eq!(registry.len(), 2);
}

#[test]
fn the_seven_roots_are_typed_before_the_first_update() {
    let (registry, _) = registry("device-a");
    let document = registry.get_or_open("abc123def456").expect("open");

    let named: Vec<String> = document
        .read(|txn| txn.root_refs().map(|(name, _)| name.to_owned()).collect())
        .expect("read");

    for (root, _) in NOTE_DOC_ROOTS {
        assert!(named.contains(&root.to_owned()), "missing root {root}");
    }
    assert_eq!(named.len(), NOTE_DOC_ROOTS.len());
}

#[test]
fn a_local_edit_reaches_the_sink_and_a_durable_apply_does_not() {
    let (registry, seen) = registry("device-a");
    let document = registry.get_or_open("abc123def456").expect("open");

    // An update authored elsewhere: a replay or a pulled row. Already
    // durable, so the sink must not see it.
    document
        .apply_durable_update(&authored(99, "from a peer"))
        .expect("replay");
    assert!(seen.lock().expect("seen").is_empty());

    // An update this device authored, arriving through the same door a
    // pushed-back local row would.
    document
        .apply_local_update(&authored(77, "mine"))
        .expect("local");
    // And one written straight through the document.
    document.write_text_for_test("typed").expect("write");

    let captured = seen.lock().expect("seen").clone();
    assert_eq!(captured.len(), 2);
    assert!(
        captured
            .iter()
            .all(|(id, bytes)| id == "abc123def456" && !bytes.is_empty())
    );
}

/// A v1 update carrying `text` in `prosemirror`, authored by `client_id`.
fn authored(client_id: u64, text: &str) -> Vec<u8> {
    let author = Doc::with_client_id(client_id);
    let fragment = author.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = author.transact_mut();
        fragment.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    author
        .transact()
        .encode_state_as_update_v1(&StateVector::default())
}

#[test]
fn undecodable_bytes_are_a_variant_not_a_panic() {
    let (registry, _) = registry("device-a");
    let document = registry.get_or_open("abc123def456").expect("open");

    let error = document
        .apply_durable_update(&[0xff, 0xff, 0xff, 0xff])
        .expect_err("garbage must not decode");

    assert!(matches!(error, CrdtError::Undecodable { .. }));
}

#[test]
fn a_full_state_encode_carries_a_root_this_build_never_names() {
    // The negative control of chapter 12 §12.5.1: a foreign root survives
    // an apply-then-encode cycle only because the encode is full-state.
    let author = Doc::with_client_id(99);
    let foreign = author.get_or_insert_map("someFutureRoot");
    let body = author.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = author.transact_mut();
        foreign.insert(&mut txn, "kept", "yes");
        body.insert(&mut txn, 0, XmlTextPrelim::new("body"));
    }
    let authored = author
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    let (registry, _) = registry("device-a");
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(&authored).expect("apply");

    let round_tripped = document.encode_state().expect("encode");

    let reader = Doc::new();
    reader
        .transact_mut()
        .apply_update(Update::decode_v1(&round_tripped).expect("decode"))
        .expect("apply");
    let value = reader
        .get_or_insert_map("someFutureRoot")
        .get(&reader.transact(), "kept");

    assert_eq!(
        value.map(|v| v.to_string(&reader.transact())),
        Some("yes".to_owned())
    );
}

#[test]
fn two_devices_converge_on_the_same_bytes() {
    let (left_registry, _) = registry("device-a");
    let (right_registry, _) = registry("device-b");
    let left = left_registry.get_or_open("abc123def456").expect("left");
    let right = right_registry.get_or_open("abc123def456").expect("right");

    let left_edit = edit(&left, "left ");
    let right_edit = edit(&right, "right ");

    left.apply_durable_update(&right_edit).expect("merge right");
    right.apply_durable_update(&left_edit).expect("merge left");

    assert_eq!(
        text(&left),
        text(&right),
        "a CRDT merge converges on the value, not merely on the words"
    );
}

/// Writes `insert` and returns the whole state afterwards, which is what a
/// peer merges. A full-state encode, never a walk of named roots.
fn edit(document: &Document, insert: &str) -> Vec<u8> {
    let before = document.encode_state().expect("before");
    document
        .write_text_for_test(insert)
        .expect("write through the document");
    let after = document.encode_state().expect("after");
    assert_ne!(before, after);
    after
}

fn text(document: &Document) -> String {
    document
        .read(|txn| {
            txn.get_xml_fragment("prosemirror")
                .expect("the root is typed at open")
                .get_string(txn)
        })
        .expect("read")
}
