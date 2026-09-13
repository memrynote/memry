//! T133 — a concurrent core edit and desktop edit converge to a
//! **byte-identical document**, against real adapters.
//!
//! Real `yrs`, real `rusqlite` on disk, the real two-namespace update log, the
//! real outbox transaction. Nothing here is mocked: there is no transport
//! because a merge needs none — the bytes travel through `yjs_updates`, which
//! is where a pull would have put them.
//!
//! | Test                                             | Rule                            |
//! | ------------------------------------------------ | ------------------------------- |
//! | two concurrent edits converge byte for byte      | §12.5.0, §12.5.1, §7.16, FR-033 |
//! | a third device applying in the other order       | chapter 07 §7.14                |
//! | the converged state alone rebuilds a device      | chapter 12 §12.5.1              |
//! | the encode does not depend on the history        | chapter 12 §12.5.1              |
//!
//! ## Why byte identity and not "both contain the words"
//!
//! `extract_text` is a lossy preview walk (§12.1.3): it drops `divider`, drops
//! a callout's type, renumbers every ordered item to `1. `, and eats literal
//! angle brackets (§12.1.3.1). Two documents whose *structure* has diverged —
//! a block in the wrong parent, a root dropped by a named-root rebuild, one
//! peer's update never merged — can still extract to the same string. The only
//! assertion that sees those is the full-state encode of §12.5.1, compared
//! byte for byte.
//!
//! ## The shape the simulated desktop writes
//!
//! There is no desktop in this test; the second `yrs` document is standing in
//! for one, and a fixture in the wrong shape would prove convergence on a
//! document neither real device would ever hold. So both sides write
//! §12.5.0's layout — `prosemirror > blockGroup > blockContainer > <block> >
//! XmlText`, the container carrying a v4-shaped `id` — and locate the
//! `blockGroup` rather than assuming one, exactly as
//! `crates/memry-cli/src/edit/node.rs` does. A `blockContainer` placed beside
//! the `blockGroup` instead of inside it is **silently deleted** by
//! y-prosemirror's repair heuristic, and every layer this test can see —
//! apply, encode, `extract_text` — reports success anyway. [`assert_layout`]
//! is what refuses that document.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::{UpdateSink, client_id_from_device_id};
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{Document, DocumentRegistry, extract_text};
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox;
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, GetString as _, Map as _, ReadTxn as _, Transact as _, TransactionMut, Update, Xml as _,
    XmlElementPrelim, XmlElementRef, XmlFragment as _, XmlOut, XmlTextPrelim,
};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A twelve-character lowercase note id, the form desktop mints (§7.1.0).
const NOTE: &str = "abc123def456";

/// The device that wrote the note. Its Yjs client id is derived from this
/// string and from nothing else (§7.16), so the merge order below is stable.
const DESKTOP: &str = "device-desktop";
/// The device this core is.
const CORE: &str = "device-core";
/// A third device that sees both edits and authors neither.
const OBSERVER: &str = "device-observer";

const NOW: i64 = 1_700_000_000_000;

// ------------------------------------------------------------- §12.5.0 nodes

const BLOCK_GROUP: &str = "blockGroup";
const BLOCK_CONTAINER: &str = "blockContainer";
const PARAGRAPH: &str = "paragraph";
const BODY: &str = "prosemirror";

/// Appends `<blockContainer id><paragraph>text</paragraph></blockContainer>`
/// at the end of the document's block list, §12.5.0's layout.
///
/// The parent is **located, never assumed**: the existing top-level
/// `blockGroup`, or one this call creates when the fragment is empty. A
/// fragment holding anything else is refused rather than guessed at, because a
/// block in a parent the schema cannot build is a block y-prosemirror deletes
/// without saying so.
fn append_paragraph(txn: &mut TransactionMut<'_>, block_id: &str, text: &str) {
    let fragment = txn
        .get_xml_fragment(BODY)
        .expect("the `prosemirror` root is typed when the document is opened");

    let mut group: Option<XmlElementRef> = None;
    let mut strangers: Vec<String> = Vec::new();
    for child in fragment.children(&*txn) {
        match child {
            XmlOut::Element(element) if element.tag().as_ref() == BLOCK_GROUP => {
                group = Some(element);
            }
            XmlOut::Element(element) => strangers.push(element.tag().to_string()),
            XmlOut::Text(_) => strangers.push("#text".to_owned()),
            XmlOut::Fragment(_) => strangers.push("#fragment".to_owned()),
        }
    }
    assert!(
        strangers.is_empty(),
        "§12.5.0: the fragment's single top-level child is a `{BLOCK_GROUP}`, \
         and this one also holds {strangers:?}"
    );

    let group =
        group.unwrap_or_else(|| fragment.push_back(txn, XmlElementPrelim::empty(BLOCK_GROUP)));
    let container = group.push_back(txn, XmlElementPrelim::empty(BLOCK_CONTAINER));
    container.insert_attribute(txn, "id", block_id.to_owned());
    let paragraph = container.push_back(txn, XmlElementPrelim::empty(PARAGRAPH));
    paragraph.push_back(txn, XmlTextPrelim::new(text));
}

/// The `prosemirror` fragment rendered as XML — the tree, not the text it
/// happens to extract to.
fn layout(document: &Document) -> String {
    document
        .read(|txn| {
            txn.get_xml_fragment(BODY)
                .expect("the root is typed at open")
                .get_string(txn)
        })
        .expect("read")
}

/// §12.5.0, asserted rather than assumed: exactly one top-level child, and it
/// is the `blockGroup`.
///
/// Without this the whole test can be built on a document a real desktop would
/// silently repair by deleting a block — and every other assertion here would
/// still pass.
fn assert_layout(document: &Document, whose: &str) {
    let children: Vec<String> = document
        .read(|txn| {
            txn.get_xml_fragment(BODY)
                .expect("the root is typed at open")
                .children(txn)
                .map(|child| match child {
                    XmlOut::Element(element) => element.tag().to_string(),
                    XmlOut::Text(_) => "#text".to_owned(),
                    XmlOut::Fragment(_) => "#fragment".to_owned(),
                })
                .collect()
        })
        .expect("read");
    assert_eq!(
        children,
        vec![BLOCK_GROUP.to_owned()],
        "§12.5.0: {whose}'s `{BODY}` fragment must hold exactly one top-level \
         `{BLOCK_GROUP}`; a `{BLOCK_CONTAINER}` beside it is deleted by \
         y-prosemirror without an error anywhere"
    );
}

// ------------------------------------------------------------------ plumbing

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-convergence-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn storage_failure(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// One device: a registry with its own device id, and the updates its own
/// writes produced, in order.
struct Device {
    registry: DocumentRegistry,
    authored: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Device {
    fn new(device_id: &str) -> Self {
        let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: UpdateSink = {
            let authored = Arc::clone(&authored);
            Arc::new(move |_, bytes: &[u8]| authored.lock().expect("lock").push(bytes.to_vec()))
        };
        Self {
            registry: DocumentRegistry::new(device_id, sink),
            authored,
        }
    }

    fn open(&self) -> Arc<Document> {
        self.registry.get_or_open(NOTE).expect("open the document")
    }

    /// The bytes of the most recent write, which is what a peer is sent.
    fn last_authored(&self) -> Vec<u8> {
        self.authored
            .lock()
            .expect("lock")
            .last()
            .cloned()
            .expect("the write reached the sink")
    }
}

/// Records a local edit the way FR-030 requires: the update row and its outbox
/// row in **one** transaction, and only then is the edit acknowledged.
fn record_local(db: &Db, update: &[u8]) -> i64 {
    let change = outbox::Change::crdt_update("note", NOTE, update.to_vec());
    let blob = update.to_vec();
    db.call_blocking(move |conn| {
        outbox::commit(conn, &change, NOW, |tx| {
            update_log::append_local_update_in(tx, NOTE, &blob, NOW).map_err(storage_failure)
        })
    })
    .expect("the local edit commits")
    .acknowledge()
}

/// Records an update the server numbered, the way a body pull does.
fn record_server(db: &Db, seq: i64, update: &[u8]) {
    let blob = update.to_vec();
    db.call_blocking(move |conn| {
        update_log::append_server_update(conn, NOTE, seq, &blob, NOW).map_err(storage_failure)
    })
    .expect("the server update is stored");
}

/// Replays everything on disk into a document, in the order §A.2 requires.
fn replay(db: &Db, document: &Document) {
    let plan = db
        .call_blocking(|conn| update_log::load_plan(conn, NOTE).map_err(storage_failure))
        .expect("the load plan");
    for blob in plan.blobs() {
        document.apply_durable_update(blob).expect("replay");
    }
}

// ------------------------------------------------------------------ fixtures

/// The note as the desktop first wrote it: one `blockGroup` holding one block,
/// plus a root neither this build nor any chapter names.
///
/// The foreign root is the negative control of §12.5.1: it is in these bytes,
/// and it survives the whole merge below only because every encode on the path
/// is a full-state encode rather than a walk of named roots.
fn desktop_creates_the_note(desktop: &Device) -> Vec<u8> {
    let document = desktop.open();
    document
        .write(|txn| {
            append_paragraph(
                txn,
                "11111111-1111-4111-8111-111111111111",
                "Written on desktop.",
            );
            txn.get_map("markdownSource")
                .expect("the root is typed at open")
                .insert(txn, "record", "desktop bytes");
        })
        .expect("write");
    desktop.last_authored()
}

// --------------------------------------------------------------------- tests

/// The one T133 exists for.
///
/// A core edit and a desktop edit that never saw each other, merged through a
/// real update log, land on the **same bytes** — not on two documents that
/// happen to read the same.
#[test]
fn a_concurrent_core_edit_and_desktop_edit_converge_byte_for_byte() {
    let core_db = scratch_db("core");
    let desktop_db = scratch_db("desktop");

    // §7.16: the client id is derived from the device id, so these two are
    // different peers and stay different across a relaunch. Two devices that
    // mint the same id corrupt a document that merges both.
    assert_ne!(
        client_id_from_device_id(CORE),
        client_id_from_device_id(DESKTOP),
        "two devices must not write under one Yjs client id"
    );

    let desktop = Device::new(DESKTOP);
    let core = Device::new(CORE);

    // The desktop creates the note and the core pulls it: one server update.
    let base = desktop_creates_the_note(&desktop);
    record_server(&core_db, 1, &base);
    record_server(&desktop_db, 1, &base);
    let core_doc = core.open();
    replay(&core_db, &core_doc);

    let base_state = core_doc.encode_state().expect("encode");
    assert_eq!(
        base_state,
        desktop.open().encode_state().expect("encode"),
        "the two devices start from the same document"
    );

    // ---- the concurrent moment: neither edit has seen the other ----

    core_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "22222222-2222-4222-8222-222222222222",
                "from the phone",
            )
        })
        .expect("write");
    let core_edit = core.last_authored();
    let core_seq = record_local(&core_db, &core_edit);
    assert_eq!(core_seq, 1, "the first row of the `local.<id>` namespace");

    let desktop_doc = desktop.open();
    desktop_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "33333333-3333-4333-8333-333333333333",
                "from the desktop",
            )
        })
        .expect("write");
    let desktop_edit = desktop.last_authored();

    assert_ne!(
        core_doc.encode_state().expect("encode"),
        desktop_doc.encode_state().expect("encode"),
        "before the exchange the two documents have genuinely diverged"
    );

    // ---- the exchange, through the log rather than through memory ----

    // The desktop's edit reaches the core as the next server update.
    record_server(&core_db, 2, &desktop_edit);
    let pulled = core_db
        .call_blocking(|conn| {
            update_log::updates_after(conn, Namespace::Server, NOTE, 1).map_err(storage_failure)
        })
        .expect("read the server namespace");
    assert_eq!(pulled.len(), 1, "exactly the desktop's edit is new");
    core_doc
        .apply_durable_update(&pulled[0].update_blob)
        .expect("merge the desktop's edit");

    // The core's edit reaches the desktop out of the core's own local log,
    // which is what a push actually sends.
    let pushed = core_db
        .call_blocking(|conn| {
            update_log::updates_after(conn, Namespace::Local, NOTE, 0).map_err(storage_failure)
        })
        .expect("read the local namespace");
    assert_eq!(pushed.len(), 1);
    assert_eq!(
        pushed[0].update_blob, core_edit,
        "the log holds the edit verbatim"
    );
    record_server(&desktop_db, 2, &pushed[0].update_blob);
    desktop_doc
        .apply_durable_update(&pushed[0].update_blob)
        .expect("merge the core's edit");

    // ---- the assertion ----

    let converged = core_doc.encode_state().expect("encode");
    assert_eq!(
        converged,
        desktop_doc.encode_state().expect("encode"),
        "a merge converges on the document, not merely on the words: the \
         full-state encode of §12.5.1 must match byte for byte"
    );
    assert_ne!(
        converged, base_state,
        "and it is not the state they started from"
    );

    // Byte identity is the assertion; these say *what* it converged on, so a
    // failure above is readable rather than a diff of two blobs.
    assert_layout(&core_doc, "the core");
    assert_layout(&desktop_doc, "the desktop");
    assert_eq!(
        layout(&core_doc),
        "<blockGroup>\
         <blockContainer id=\"11111111-1111-4111-8111-111111111111\">\
         <paragraph>Written on desktop.</paragraph></blockContainer>\
         <blockContainer id=\"22222222-2222-4222-8222-222222222222\">\
         <paragraph>from the phone</paragraph></blockContainer>\
         <blockContainer id=\"33333333-3333-4333-8333-333333333333\">\
         <paragraph>from the desktop</paragraph></blockContainer>\
         </blockGroup>",
        "§12.5.0's layout, with the two concurrent blocks ordered by the Yjs \
         conflict rule and not by arrival"
    );
    assert_eq!(
        extract_text(&core_doc).expect("extract"),
        "Written on desktop.\nfrom the phone\nfrom the desktop"
    );

    // FR-033 and §12.5.1: a root neither device's build names is inside the
    // converged bytes, because nothing on this path rebuilt the document from
    // named roots.
    let reader = Doc::new();
    reader
        .transact_mut()
        .apply_update(Update::decode_v1(&converged).expect("decode"))
        .expect("apply");
    let preserved = reader
        .get_or_insert_map("markdownSource")
        .get(&reader.transact(), "record");
    assert_eq!(
        preserved.map(|value| value.to_string(&reader.transact())),
        Some("desktop bytes".to_owned()),
        "the merge carried a root this test never typed on the reader"
    );
}

/// Order-insensitivity, which is the half of convergence a two-device test
/// cannot see: each of the two devices above applied the *other's* edit last,
/// so neither ever applied them in the same order.
///
/// A third device that authored nothing and applies both in the opposite order
/// must land on the identical bytes (§7.14: reordering delivered updates
/// changes nothing).
#[test]
fn a_third_device_applying_the_two_edits_in_the_other_order_lands_on_the_same_bytes() {
    let desktop = Device::new(DESKTOP);
    let core = Device::new(CORE);
    let db = scratch_db("observer");

    let base = desktop_creates_the_note(&desktop);
    let desktop_doc = desktop.open();

    let core_doc = core.open();
    core_doc.apply_durable_update(&base).expect("baseline");
    core_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "22222222-2222-4222-8222-222222222222",
                "from the phone",
            )
        })
        .expect("write");
    let core_edit = core.last_authored();

    desktop_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "33333333-3333-4333-8333-333333333333",
                "from the desktop",
            )
        })
        .expect("write");
    let desktop_edit = desktop.last_authored();

    core_doc.apply_durable_update(&desktop_edit).expect("merge");
    desktop_doc.apply_durable_update(&core_edit).expect("merge");

    // The observer takes all three through the durable log, in the order a
    // pull happens to hand them over: base, then the desktop's, then the
    // core's — the reverse of what the core itself saw.
    record_server(&db, 1, &base);
    record_server(&db, 2, &desktop_edit);
    record_server(&db, 3, &core_edit);
    let observer = Device::new(OBSERVER);
    let observer_doc = observer.open();
    replay(&db, &observer_doc);

    let expected = core_doc.encode_state().expect("encode");
    assert_eq!(
        observer_doc.encode_state().expect("encode"),
        expected,
        "a device that applied the two edits in the other order must hold the \
         identical document (§7.14)"
    );
    assert_eq!(
        desktop_doc.encode_state().expect("encode"),
        expected,
        "and so must the desktop"
    );
    assert!(
        observer.authored.lock().expect("lock").is_empty(),
        "the observer authored nothing: its bytes are the merge and nothing else"
    );
    assert_layout(&observer_doc, "the observer");
}

/// The converged bytes are a **full-state encode** (§12.5.1), so a device that
/// has never seen this document can be brought up to date with them alone.
///
/// This is the property a snapshot rests on. An encode assembled by walking
/// named roots would pass every assertion above and fail here on the root this
/// build does not name.
#[test]
fn the_converged_state_alone_rebuilds_the_document_on_a_fresh_device() {
    let desktop = Device::new(DESKTOP);
    let core = Device::new(CORE);

    let base = desktop_creates_the_note(&desktop);
    let core_doc = core.open();
    core_doc.apply_durable_update(&base).expect("baseline");
    core_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "22222222-2222-4222-8222-222222222222",
                "from the phone",
            )
        })
        .expect("write");
    let converged = core_doc.encode_state().expect("encode");

    let fresh = Device::new(OBSERVER);
    let fresh_doc = fresh.open();
    fresh_doc
        .apply_durable_update(&converged)
        .expect("one full-state update is a whole document");

    assert_eq!(
        fresh_doc.encode_state().expect("encode"),
        converged,
        "re-encoding what was just applied must reproduce it byte for byte"
    );
    assert_eq!(layout(&fresh_doc), layout(&core_doc));
    assert_layout(&fresh_doc, "the fresh device");
    assert_eq!(
        fresh_doc.state_vector().expect("state vector"),
        core_doc.state_vector().expect("state vector"),
        "and the two devices agree on what they have seen"
    );
}

/// The full-state encode is canonical: the same document reached by two
/// different histories encodes identically, and encoding twice does not move.
///
/// Without this, "byte-identical" above could be an accident of both sides
/// having applied the same number of transactions.
#[test]
fn the_full_state_encode_does_not_depend_on_how_the_document_was_reached() {
    let desktop = Device::new(DESKTOP);
    let base = desktop_creates_the_note(&desktop);
    let desktop_doc = desktop.open();
    desktop_doc
        .write(|txn| {
            append_paragraph(
                txn,
                "33333333-3333-4333-8333-333333333333",
                "from the desktop",
            )
        })
        .expect("write");
    let second = desktop.last_authored();

    // One device that saw the two updates separately, one that saw them as a
    // single merged blob.
    let stepwise = Device::new(OBSERVER).open();
    stepwise.apply_durable_update(&base).expect("apply");
    stepwise.apply_durable_update(&second).expect("apply");

    let at_once = Device::new(OBSERVER).open();
    at_once
        .apply_durable_update(&desktop_doc.encode_state().expect("encode"))
        .expect("apply");

    let encoded = stepwise.encode_state().expect("encode");
    assert_eq!(encoded, at_once.encode_state().expect("encode"));
    assert_eq!(
        encoded,
        stepwise.encode_state().expect("encode again"),
        "the encode is a function of the state, not of the encoder's history"
    );
    assert_eq!(
        encoded,
        desktop_doc.encode_state().expect("the author's own state"),
        "including the device that authored the edits rather than receiving them"
    );
}
