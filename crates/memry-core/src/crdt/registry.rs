//! The `yrs` document registry (research R2, chapter 12 §12.5).
//!
//! One `Arc<Doc>` per document id, minted with a client id derived from the
//! device id so a relaunch does not mint a new Yjs client for the same device.
//!
//! Three rules carry this module and each is a trap the obvious code falls
//! into:
//!
//! 1. **Root types are created before the first `apply_update`.** `yrs`
//!    materialises a root that arrives in an update but was never requested by
//!    name as a bare placeholder, and only upgrades it when a typed accessor is
//!    called later (chapter 12 §12.5.1). Typing the seven known roots up front
//!    is the supported way to have them; it is *not* a licence to rebuild a
//!    document by copying named roots, which is the thing §12.5.1 forbids.
//! 2. **A snapshot is a full-state encode.** [`Document::encode_state`] is
//!    `encode_state_as_update_v1` over an empty state vector and nothing else.
//!    Assembling a document from named roots drops every root this build does
//!    not know about, which is FR-033 and, for `criticMarkupMarks`, user data.
//! 3. **Every exported method opens and closes its own transaction**, through
//!    `try_transact`/`try_transact_mut`, with `TransactionAcqError` mapped to
//!    [`CrdtError::DocumentBusy`]. No transaction is ever held across a return,
//!    because a `TransactionMut` borrows the doc and cannot cross the FFI.
//!
//! The `observe_update_v1` `Subscription` is held for the document's lifetime:
//! dropping it unsubscribes, so it lives in [`Document`] and dies with it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha2::{Digest as _, Sha256};
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, StateVector, Subscription, Transact as _, Transaction, TransactionMut};
use yrs::{IdSet, Origin, ReadTxn, TransactionAcqError, Update};

use super::errors::CrdtError;

/// The seven roots of a note document (chapter 12 §12.5), with the type each
/// one must be given before the first update is applied.
///
/// Seven, not eight: `probe` is set on a throwaway document and cleared, and is
/// not a root of this format.
///
/// **This list is not the set of roots a document may have.** A conforming
/// client preserves every root in the update stream, including roots no
/// specification names; that guarantee comes from the full-state encode, not
/// from this table.
pub const NOTE_DOC_ROOTS: [(&str, RootKind); 7] = [
    ("prosemirror", RootKind::XmlFragment),
    ("meta", RootKind::Map),
    ("tags", RootKind::Array),
    ("markdownSource", RootKind::Map),
    ("linkReferenceDefinitions", RootKind::Array),
    ("linkReferenceUsages", RootKind::Array),
    ("criticMarkupMarks", RootKind::Array),
];

/// The shared type a named root is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    XmlFragment,
    Map,
    Array,
}

/// The origin stamped on a transaction whose bytes the core already holds
/// durably: a replay out of `yjs_updates`, or an update pulled from the server.
///
/// The update observer ignores a transaction carrying it. Without this, a
/// replayed update would come straight back out of the observer and be appended
/// to the local namespace as though this device had just typed it, and every
/// launch would re-push the whole document.
const ORIGIN_DURABLE: &str = "memry.durable";

/// What the registry does with an update this device authored.
///
/// Called from inside the `observe_update_v1` callback, so it runs while the
/// producing transaction is committing: it must not re-enter the document.
pub type UpdateSink = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;

/// The Yjs client id for this device.
///
/// Deterministic in the device id, because a fresh client id per launch grows
/// the document's state vector without bound (research R2).
///
/// **53 bits**, the range `yrs` itself mints and the one it documents as safe
/// for JavaScript: a client id travels inside every update and is read back by
/// JavaScript peers through `lib0`, whose integers stop being exact above
/// 2^53 - 1. Chapter 07 does not specify the derivation, so this takes the
/// narrowest range that cannot surprise the other implementations.
pub fn client_id_from_device_id(device_id: &str) -> u64 {
    let digest = Sha256::digest(device_id.as_bytes());
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(head) & ((1u64 << 53) - 1)
}

/// One open document: the `yrs` document, its id, and the subscription that
/// must outlive every update it reports.
pub struct Document {
    id: String,
    doc: Arc<Doc>,
    /// Held for the document's lifetime. `Subscription`'s `Drop` unsubscribes,
    /// so binding this to `_` at the call site would silence the observer
    /// immediately (research R2).
    _updates: Subscription,
}

impl Document {
    /// Opens a document, typing the known roots before anything is applied.
    fn open(id: &str, client_id: u64, sink: UpdateSink) -> Result<Self, CrdtError> {
        let doc = Arc::new(Doc::with_client_id(client_id));

        // Before the first `apply_update`, and each through its own
        // transaction. These panic if a transaction is already live; none is,
        // because the document is not reachable by any other caller yet.
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

        let doc_id = id.to_owned();
        let subscription = doc
            .observe_update_v1(move |txn, event| {
                if txn.origin() == Some(&Origin::from(ORIGIN_DURABLE)) {
                    return;
                }
                sink(&doc_id, &event.update);
            })
            .map_err(|err| busy(id, err))?;

        Ok(Self {
            id: id.to_owned(),
            doc,
            _updates: subscription,
        })
    }

    /// The document id, exactly as the record feed spells it.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The Yjs client id this document writes under.
    pub fn client_id(&self) -> u64 {
        self.doc.client_id().get()
    }

    /// Applies bytes the core already holds durably: a replay out of the log,
    /// or an update pulled from the server.
    ///
    /// The update sink does **not** see these. They are already recorded, and
    /// re-emitting one would enqueue a peer's edit as this device's own.
    pub fn apply_durable_update(&self, bytes: &[u8]) -> Result<(), CrdtError> {
        self.apply(bytes, Some(ORIGIN_DURABLE)).map(drop)
    }

    /// [`Self::apply_durable_update`], answering whether the bytes changed the
    /// document. `false` when every item and every deletion in them was already
    /// here: a resent update, or a sync-step-2 diff of a replica that holds
    /// nothing new. Bytes that wait on an update this document lacks count as a
    /// change when they add to what it holds back, because they are new to it.
    pub fn apply_durable_update_changed(&self, bytes: &[u8]) -> Result<bool, CrdtError> {
        self.apply(bytes, Some(ORIGIN_DURABLE))
    }

    /// Applies bytes this device authored. The update sink sees them.
    pub fn apply_local_update(&self, bytes: &[u8]) -> Result<(), CrdtError> {
        self.apply(bytes, None).map(drop)
    }

    fn apply(&self, bytes: &[u8], origin: Option<&'static str>) -> Result<bool, CrdtError> {
        let update = Update::decode_v1(bytes).map_err(|err| CrdtError::Undecodable {
            doc_id: self.id.clone(),
            what: err.to_string(),
        })?;

        let mut txn = match origin {
            Some(origin) => self.doc.try_transact_mut_with(origin),
            None => self.doc.try_transact_mut(),
        }
        .map_err(|err| busy(&self.id, err))?;

        let pending_before = pending(&txn);
        txn.apply_update(update)
            .map_err(|err| CrdtError::NotApplicable {
                doc_id: self.id.clone(),
                what: err.to_string(),
            })?;
        Ok(!txn.insert_set().is_empty()
            || !txn.delete_set().is_empty()
            || pending(&txn) != pending_before)
        // `txn` drops here: the transaction this method opened is the
        // transaction this method closes, and the observer fires on the commit.
    }

    /// The whole document as one v1 update — the only correct way to snapshot
    /// one (chapter 12 §12.5.1).
    ///
    /// Roots this build has never heard of are inside these bytes. Any encode
    /// that walks named roots instead would drop them.
    pub fn encode_state(&self) -> Result<Vec<u8>, CrdtError> {
        self.read(|txn| txn.encode_state_as_update_v1(&StateVector::default()))
    }

    /// The state vector, for a diff against a peer.
    pub fn state_vector(&self) -> Result<Vec<u8>, CrdtError> {
        use yrs::updates::encoder::Encode as _;
        self.read(|txn| txn.state_vector().encode_v1())
    }

    /// Whether an update arrived out of order and is still pending an
    /// antecedent (research R2).
    ///
    /// A document with missing updates has not merged everything it was sent,
    /// which is exactly condition 1 of the snapshot gate in chapter 07 §7.13.2.
    pub fn has_missing_updates(&self) -> Result<bool, CrdtError> {
        self.read(|txn| txn.has_missing_updates())
    }

    /// Runs `f` inside a read transaction this method opens and closes.
    ///
    /// The one door for a reader such as `extract_text`. It hands out a
    /// `Transaction` and never the `Doc`, so no caller can keep one open.
    pub fn read<F, T>(&self, f: F) -> Result<T, CrdtError>
    where
        F: FnOnce(&Transaction<'_>) -> T,
    {
        let txn = self.doc.try_transact().map_err(|err| busy(&self.id, err))?;
        Ok(f(&txn))
    }

    /// Runs `f` inside a write transaction this method opens and closes.
    ///
    /// The mirror of [`Document::read`], and the only door a local edit is
    /// authored through. The update the commit produces reaches this
    /// registry's [`UpdateSink`] exactly once, because the transaction this
    /// method opens is the transaction it closes: the caller takes the bytes
    /// from the sink rather than diffing a second document against this one,
    /// which is what chapter 12 §12.5.1 forbids.
    ///
    /// It hands out a `TransactionMut` and never the `Doc`, so a caller can
    /// neither keep one open nor reach `encode_state_as_update_v1` around the
    /// unknown roots this document is carrying.
    pub fn write<F, T>(&self, f: F) -> Result<T, CrdtError>
    where
        F: FnOnce(&mut TransactionMut<'_>) -> T,
    {
        let mut txn = self
            .doc
            .try_transact_mut()
            .map_err(|err| busy(&self.id, err))?;
        Ok(f(&mut txn))
    }
}

/// What the document holds back until an update it lacks arrives: structs and
/// deletions. Compared before and after an apply, so only bytes that added to it
/// count as a change, and data stuck there does not make every later apply one.
fn pending(txn: &TransactionMut<'_>) -> (Option<Vec<u8>>, Option<IdSet>) {
    use yrs::updates::encoder::Encode as _;
    let store = ReadTxn::store(txn);
    (
        store
            .pending_update()
            .map(|pending| pending.update.encode_v1()),
        store.pending_ds().cloned(),
    )
}

fn busy(doc_id: &str, err: TransactionAcqError) -> CrdtError {
    CrdtError::DocumentBusy {
        doc_id: doc_id.to_owned(),
        what: err.to_string(),
    }
}

/// Every document this process currently holds in memory.
///
/// The registry decides *identity* — one `Arc<Document>` per id, so two
/// surfaces asking for the same note get the same document rather than two that
/// silently diverge. It does not decide *residency*: how many documents stay
/// open and for how long is [`super::lifecycle`]'s answer.
pub struct DocumentRegistry {
    client_id: u64,
    sink: UpdateSink,
    open: Mutex<HashMap<String, Arc<Document>>>,
}

impl DocumentRegistry {
    /// `device_id` is `meta`'s `device.id` (data-model §A.2).
    pub fn new(device_id: &str, sink: UpdateSink) -> Self {
        Self::with_client_id(client_id_from_device_id(device_id), sink)
    }

    /// A registry writing under `client_id`: a writer's, from
    /// [`super::epoch::client_id`].
    pub(crate) fn with_client_id(client_id: u64, sink: UpdateSink) -> Self {
        Self {
            client_id,
            sink,
            open: Mutex::new(HashMap::new()),
        }
    }

    /// The Yjs client id every document in this registry writes under.
    pub fn client_id(&self) -> u64 {
        self.client_id
    }

    /// The document for `doc_id`, opening an empty one if this process does not
    /// hold it yet.
    ///
    /// An id is opaque: a note id and a journal id take the same path
    /// (chapter 07 §7.1).
    pub fn get_or_open(&self, doc_id: &str) -> Result<Arc<Document>, CrdtError> {
        let mut open = self.lock();
        if let Some(existing) = open.get(doc_id) {
            return Ok(Arc::clone(existing));
        }
        let document = Arc::new(Document::open(
            doc_id,
            self.client_id,
            Arc::clone(&self.sink),
        )?);
        open.insert(doc_id.to_owned(), Arc::clone(&document));
        Ok(document)
    }

    /// The document for `doc_id` if it is already open, without opening one.
    pub fn peek(&self, doc_id: &str) -> Option<Arc<Document>> {
        self.lock().get(doc_id).cloned()
    }

    /// Drops this registry's reference to `doc_id`.
    ///
    /// The document itself dies when the last `Arc` goes, which is what takes
    /// its `Subscription` with it. A holder that is still reading keeps it
    /// alive, and that is deliberate: eviction must not pull a document out
    /// from under a reader.
    pub fn release(&self, doc_id: &str) -> bool {
        self.lock().remove(doc_id).is_some()
    }

    /// How many documents this process holds.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Document>>> {
        // A panic inside the map's own critical section is not recoverable
        // state; the map is a plain `HashMap` and a poisoned guard still holds
        // a consistent one, so the lock is taken through the poison.
        self.open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
