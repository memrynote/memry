//! `NotesWriter`: create, rename, move and delete, for one opened vault.
//!
//! The write half of [`crate::api::notes`], and a separate object on purpose.
//! Reading a vault needs a database and nothing else; writing one needs a
//! **device identity**, because every field a write touches carries a vector
//! clock keyed by the device that wrote it (chapter 06 §6.1). Folding the two
//! into one object would mean either a read surface that cannot be built
//! without the keychain, or a write surface that invents a device id.
//!
//! **The device id is derived here, not passed in.** It is
//! `local_device_id_hex(signing public key)` (chapter 01 §1.5), read through
//! the shell's own secure store. A shell that computed it would be a second
//! place the derivation lives, and two places is how two devices end up sharing
//! one clock entry.
//!
//! **A locked keychain is not a missing key.** `SecureStoreError::Locked`
//! crosses unchanged rather than being read as "no signing key yet": minting a
//! second identity for a device that already has one splits its clock and makes
//! its own earlier writes look like another device's.
//!
//! **Every method answers only after the change is durable.**
//! [`crate::sync::outbox::Durable`] is constructed after `COMMIT` returned, and
//! these methods consume it — so a shell that got an answer may show it, and a
//! shell that got an error has nothing to undo (data-model §C.4).

use std::sync::Arc;

use crate::api::errors::{AuthError, PropertyWriteError, StorageError};
use crate::crdt::body_edit::{self, BlockEdit};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, update_log};
use crate::crypto::{keys, sodium};
use crate::domain::body_write;
use crate::domain::bookmarks;
use crate::domain::calendar::LocalDateTime;
use crate::domain::note_tasks;
use crate::domain::notes::{self, NewNote};
use crate::domain::properties;
use crate::domain::tasks;
use crate::domain::templates;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;
use serde_json::Value;

// Reminders and folders: the same writer, split out at the line ceiling.
mod folders;

/// The write surface over one opened vault.
#[derive(uniffi::Object)]
pub struct NotesWriter {
    db: Db,
    device_id: String,
}

impl NotesWriter {
    /// Built by [`crate::api::vault::Vault::notes_writer`], which is the only
    /// caller that has the database this writes to.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    // Not a write failure and not an empty vault: this device has
                    // never registered, and registering is what mints the key.
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }

    /// A new note id: 128 bits of libsodium randomness, hex.
    ///
    /// Minted in the core because a note id **is** its CRDT document id
    /// (chapter 07 §7.1) and has to satisfy `/^[a-zA-Z0-9_-]+$/`. A shell that
    /// minted one could produce a note whose body can never be pushed.
    fn new_id() -> String {
        sodium::random_bytes(16)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[uniffi::export]
impl NotesWriter {
    /// Creates an empty note and returns its id.
    ///
    /// `folder_path` is `nil` for the vault root, which travels as an explicit
    /// `null`: an absent key means "the sender does not know this field" and
    /// every other device would keep its own value (chapter 13 §13.4).
    ///
    /// The body is **not** written here. A note's text lives in its Y.Doc, and
    /// chapter 12 §12.2's create-time `content` is best-effort by its own
    /// words; sending `""` keeps one authority for the body instead of two.
    pub fn create(
        &self,
        title: String,
        folder_path: Option<String>,
    ) -> Result<String, StorageError> {
        let id = Self::new_id();
        let device_id = self.device_id.clone();
        let minted = id.clone();
        self.db.call_blocking(move |conn| {
            let note = NewNote {
                id: &minted,
                title: &title,
                folder_path: folder_path.as_deref(),
                content: "",
                tags: &[],
                properties: None,
            };
            // The domain hands back the payload it wrote, not the id. Consumed
            // and dropped: taking it is what marks the write acknowledged, and
            // the payload itself is the sync record's business, not a shell's.
            let _payload = notes::create(conn, &note, &device_id, now_ms())?.acknowledge();
            Ok(())
        })?;
        Ok(id)
    }

    /// Retitles a note.
    ///
    /// The title is a field, so it merges per field: a rename here and an edit
    /// to the same note's body elsewhere do not collide (chapter 06 §6.1).
    pub fn rename(&self, id: String, title: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::rename(conn, &id, &title, &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Moves a note to a folder, or to the vault root with `nil`.
    pub fn move_to_folder(
        &self,
        id: String,
        folder_path: Option<String>,
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::move_to_folder(conn, &id, folder_path.as_deref(), &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Tombstones a note.
    ///
    /// A tombstone, never a row that vanishes: a delete has to reach every
    /// other device, and a deleted row with nothing left to send is a note that
    /// comes back on the next pull.
    pub fn delete(&self, id: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::delete(conn, &id, &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Applies one block edit to a note's body.
    ///
    /// - Returns: `false` when this vault holds no live note by that id — an
    ///   answer, like the read surface's `nil`. A block the body does not hold
    ///   **throws**: the note is here, and the edit did not land, so a caller
    ///   that carried on would be showing a change it never made.
    ///
    /// The error is `CrdtError` because a body is a CRDT document: a log row
    /// that will not decode is permanent, and a failed disk write is not, and
    /// the two must not arrive as one sentence.
    pub fn edit_block(&self, note_id: String, edit: BlockEdit) -> Result<bool, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                // FR-058: a task line's checkbox flipped in the note completes
                // or reopens the task. Read before the edit lands, applied
                // after it did.
                let flip = note_tasks::detect_checkbox_flip(conn, &note_id, &edit)
                    .ok()
                    .flatten();
                let now = now_ms();
                let applied = body_write::edit_block(conn, &note_id, &edit, &device_id, now);
                if let (Ok(true), Some(flip)) = (&applied, flip) {
                    // Through the same bookkeeping as `Tasks::complete`, so the
                    // flip is in the task's activity log as desktop's
                    // `tasks:complete` puts it there. Best effort: the body
                    // edit is already durable, and a task that is gone (deleted
                    // on another device) leaves the line ticked, as desktop does.
                    if let Ok(before) = crate::api::tasks_write::source_notes(conn) {
                        let write = if flip.checked {
                            tasks::complete(
                                conn,
                                &flip.task_id,
                                LocalDateTime::from_ms(now),
                                &device_id,
                                now,
                            )
                            .map(|completion| completion.write)
                        } else {
                            tasks::uncomplete(conn, &flip.task_id, &device_id, now)
                        };
                        if let Ok(write) = write {
                            crate::api::tasks_write::after(conn, &write, &before, &device_id, now);
                        }
                    }
                }
                Ok(applied)
            })
            .map_err(CrdtError::from)?
    }

    /// Reads one block, with everything nested under it, as the snapshot
    /// [`BlockEdit::RestoreBlock`] puts back (iOS undo of a delete or a type
    /// change).
    ///
    /// - Returns: `None` when this vault holds no live note by that id, as
    ///   [`Self::edit_block`] answers `false`. A block the body does not hold
    ///   throws.
    ///
    /// Writes nothing: the snapshot belongs to the shell's undo stack and is
    /// never stored or synced.
    pub fn block_snapshot(
        &self,
        note_id: String,
        block_id: String,
    ) -> Result<Option<String>, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                if !crate::domain::reads::note_exists(conn, &note_id) {
                    return Ok(Ok(None));
                }
                let read = || -> Result<Option<String>, CrdtError> {
                    let sink: UpdateSink = Arc::new(|_, _| {});
                    let document = DocumentRegistry::new(&device_id, sink).get_or_open(&note_id)?;
                    for blob in update_log::load_plan(conn, &note_id)?.blobs() {
                        document.apply_durable_update(blob)?;
                    }
                    body_edit::snapshot_block(&document, &block_id).map(Some)
                };
                Ok(read())
            })
            .map_err(CrdtError::from)?
    }

    /// Appends a block read with [`Self::block_snapshot`] (from any note) to
    /// the end of `note_id`'s body, with its children, marks and inline
    /// nodes: the target half of desktop's block menu "Move to".
    ///
    /// A container id the target already holds is minted afresh; the rest
    /// are kept.
    ///
    /// - Returns: `false` when this vault holds no live note by that id. The
    ///   caller removes the source block only after this answered `true`, so
    ///   a failed append leaves the block where it was.
    pub fn append_block_snapshot(
        &self,
        note_id: String,
        snapshot: String,
    ) -> Result<bool, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(body_write::append_snapshot(
                    conn,
                    &note_id,
                    &snapshot,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)?
    }

    /// Sets or clears a note's icon (N701).
    ///
    /// The payload spells it `emoji` (§13.7.1); it is `icon` here because that
    /// is what it is on every surface, and because nothing restricts it to an
    /// emoji — a shell may store a symbol name.
    ///
    /// `nil` writes an explicit **null**, never an absent key: §13.4 says an
    /// absent key means "this sender does not know", so dropping the key would
    /// tell every other device nothing had changed rather than that the user
    /// cleared their icon.
    pub fn set_icon(&self, id: String, icon: Option<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::set_icon(conn, &id, icon.as_deref(), &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Sets or clears a note's cover (N703), in desktop's `cover` payload
    /// field (chapter 13 §13.7.1.1), which desktop writes to the note's
    /// frontmatter.
    ///
    /// `url` is desktop's `cover` value: `attachments/<noteId>/<file>` for a
    /// picture uploaded to this note, `wash:<id>`, or an http(s) URL.
    /// `offset_y` is the 0-1 framing, stored as desktop's 0-100 `focus`. The
    /// photographer credit stays while `url` is unchanged and is dropped with
    /// a new picture.
    ///
    /// `nil` clears, writing an explicit null rather than removing the key.
    pub fn set_cover(
        &self,
        id: String,
        url: Option<String>,
        offset_y: f64,
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::set_cover(conn, &id, url.as_deref(), offset_y, &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Replaces a note's tags (N705).
    ///
    /// `tags` is a field of the note payload (§13.7.1); the tag rows one layer
    /// down are a projection of it. Writing a *property* called `tags` would
    /// create a second, unrelated thing no other client reads.
    pub fn set_tags(&self, id: String, tags: Vec<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::set_tags(conn, &id, &tags, &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Replaces a note's aliases (N706).
    ///
    /// Whole-array rather than add-one, because that is the shape of the field
    /// and of §13.2's field-level merge. An alias is what lets a wiki link
    /// resolve to a note by a name the note itself declares.
    pub fn set_aliases(&self, id: String, aliases: Vec<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            notes::set_aliases(conn, &id, &aliases, &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Sets one property on a note (N700).
    ///
    /// The value crosses as **JSON text**, not as a typed union, for the same
    /// reason `NoteProperty::value_json` is read that way: §13.7.1 lets a
    /// property hold any JSON, and a closed enum here would have to drop or
    /// coerce whatever did not fit. A shell serialises against the declared
    /// `type_name` it already reads, which is what makes one call serve all
    /// ten property types rather than ten calls.
    ///
    /// - Throws: `Retyped` when the edit would change a property's JSON type
    ///   (FR-048). Deliberately not folded into a storage failure: a surface
    ///   has to tell "that is not a valid value for this property" from "the
    ///   disk is full", and a silent coercion would be invisible at the call
    ///   site and permanent on the wire, since the merged payload is what
    ///   every other device then reads.
    pub fn set_property(
        &self,
        id: String,
        name: String,
        value_json: String,
    ) -> Result<(), PropertyWriteError> {
        let device_id = self.device_id.clone();
        let value: Value =
            serde_json::from_str(&value_json).map_err(|error| StorageError::Failed {
                what: format!("that property value is not JSON: {error}"),
            })?;
        self.db
            .call_blocking(move |conn| {
                Ok(properties::set(
                    conn,
                    notes::ITEM_TYPE,
                    &id,
                    &name,
                    value,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(PropertyWriteError::from)?
            .map(|_| ())
            .map_err(PropertyWriteError::from)
    }

    /// Clears one property, **leaving the key present and `null`** (§13.4).
    ///
    /// Not a removal: an absent key means "this sender does not know", so a
    /// removed key would tell every other device nothing had changed rather
    /// than that the user cleared it.
    pub fn clear_property(&self, id: String, name: String) -> Result<(), PropertyWriteError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(properties::clear(
                    conn,
                    notes::ITEM_TYPE,
                    &id,
                    &name,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(PropertyWriteError::from)?
            .map(|_| ())
            .map_err(PropertyWriteError::from)
    }

    /// Renames one property on this note, keeping its value, as desktop's
    /// `properties:rename` does: the old key is dropped rather than left
    /// `null`, a missing `from` is `NotFound`, and a `to` the note already
    /// carries is `Invalid`. The vault-wide definition is not renamed.
    pub fn rename_property(
        &self,
        id: String,
        from: String,
        to: String,
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            properties::rename(
                conn,
                notes::ITEM_TYPE,
                &id,
                &from,
                &to,
                &device_id,
                now_ms(),
            )
            .map(|_| ())
        })
    }

    /// Reorders a note's properties, desktop's `reorderProperties`: the named
    /// properties first in the given order, the rest after in their current
    /// order. The order travels as the payload's `properties` key order, which
    /// is what desktop reads, so it syncs both ways. An unchanged order writes
    /// nothing.
    pub fn reorder_properties(&self, id: String, names: Vec<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            properties::reorder(conn, notes::ITEM_TYPE, &id, &names, &device_id, now_ms())
                .map(|_| ())
        })
    }

    /// Creates a note from a template (N803).
    ///
    /// The template's content, tags and properties seed the new note, which
    /// is what makes this different from a create plus a paste: the
    /// properties arrive as properties rather than as text.
    pub fn create_from_template(
        &self,
        template_id: String,
        title: String,
        folder_path: Option<String>,
    ) -> Result<String, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let note_id = Self::new_id();
            templates::create_note(
                conn,
                &templates::NoteFromTemplate {
                    template_id: &template_id,
                    note_id: &note_id,
                    title: &title,
                    folder_path: folder_path.as_deref(),
                },
                &device_id,
                now_ms(),
            )?;
            Ok(note_id)
        })
    }

    /// Copies a note into a new one titled `title`, beside it (same folder),
    /// with its icon, cover, tags, properties and body. Returns the new id,
    /// or `nil` when this vault holds no live note `source_id`.
    pub fn duplicate(&self, source_id: String, title: String) -> Result<Option<String>, CrdtError> {
        let id = Self::new_id();
        let device_id = self.device_id.clone();
        let minted = id.clone();
        let copied = self
            .db
            .call_blocking(move |conn| {
                Ok(notes::duplicate(
                    conn,
                    &source_id,
                    &minted,
                    &title,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)??;
        Ok(copied.then_some(id))
    }

    /// Desktop's `bookmarks:toggle`: bookmarks the item, or removes its
    /// bookmark. `item_type` is `note` or `journal` (a journal record id).
    /// Returns whether the item is bookmarked afterwards.
    pub fn toggle_bookmark(
        &self,
        item_type: String,
        item_id: String,
    ) -> Result<bool, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            bookmarks::toggle(conn, &item_type, &item_id, &device_id, now_ms())
        })
    }

    /// The device identity these writes are recorded under. Exposed for the
    /// wiring tests, which is the only way to assert that the production graph
    /// derives it rather than accepting one.
    pub fn device_id(&self) -> String {
        self.device_id.clone()
    }
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
