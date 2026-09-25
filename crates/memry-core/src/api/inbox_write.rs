//! `Inbox` writes (spec 006 IB020-IB028). Every one is local SQLite plus an
//! outbox row; it reaches other devices on the next `VaultSync::sync_now`,
//! which the shell requests after each write.
//!
//! "Local now" arguments are the shell's wall clock, `YYYY-MM-DDTHH:MM`:
//! desktop formats filing dates ("Filed from Inbox on …", "Inbox Note - …")
//! in local time. Stored instants are the core's UTC clock.

use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::api::inbox_records::InboxItemRecord;
use crate::api::tasks_write::now_ms;
use crate::domain::inbox::convert::{self, BulkOutcome, LinkTarget, TaskInput};
use crate::domain::inbox::filing::{self, LocalStamp};
use crate::domain::inbox::write::{self, Captured, NewCapture};

/// A capture, or the live one it would duplicate (`duplicate = true`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxCaptureOutcome {
    pub item: InboxItemRecord,
    pub duplicate: bool,
}

impl From<Captured> for InboxCaptureOutcome {
    fn from(captured: Captured) -> Self {
        match captured {
            Captured::Created(item) => Self {
                item: item.into(),
                duplicate: false,
            },
            Captured::Duplicate(item) => Self {
                item: item.into(),
                duplicate: true,
            },
        }
    }
}

/// Where a filing landed.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxFiled {
    /// The note (or task) created, when there is one.
    pub target_id: Option<String>,
    /// What `filedTo` now says.
    pub filed_to: String,
}

/// One link target: an existing note by id, or a new one by title.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxLinkTarget {
    pub note_id: Option<String>,
    pub new_title: Option<String>,
}

/// Desktop's `BulkResponse`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxBulkResult {
    pub processed: u32,
    pub failed_ids: Vec<String>,
    pub errors: Vec<String>,
}

impl From<BulkOutcome> for InboxBulkResult {
    fn from(outcome: BulkOutcome) -> Self {
        let (failed_ids, errors) = outcome.errors.into_iter().unzip();
        Self {
            processed: outcome.processed,
            failed_ids,
            errors,
        }
    }
}

fn stamp(local_now: &str) -> Result<LocalStamp, StorageError> {
    LocalStamp::parse(local_now).ok_or_else(|| StorageError::Invalid {
        what: format!("`{local_now}` is not a local YYYY-MM-DDTHH:MM instant"),
    })
}

fn metadata_object(json_text: Option<&str>) -> Result<Map<String, Value>, StorageError> {
    match json_text.map(serde_json::from_str::<Value>) {
        None => Ok(Map::new()),
        Some(Ok(Value::Object(map))) => Ok(map),
        Some(_) => Err(StorageError::Invalid {
            what: "metadata must be a JSON object".to_owned(),
        }),
    }
}

impl Inbox {
    pub(crate) fn write<T, F>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&rusqlite::Connection, &str, i64) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |conn| f(conn, &device, now_ms()))
    }

    fn item<F>(&self, f: F) -> Result<InboxItemRecord, StorageError>
    where
        F: FnOnce(
                &rusqlite::Connection,
                &str,
                i64,
            ) -> Result<
                crate::sync::outbox::Durable<crate::domain::inbox::InboxItem>,
                StorageError,
            > + Send
            + 'static,
    {
        self.write(move |conn, device, now| Ok(f(conn, device, now)?.acknowledge().into()))
    }
}

#[uniffi::export]
impl Inbox {
    /// A fresh capture id, for a file the shell stores under
    /// `attachments/inbox/{id}/` before capturing it.
    pub fn new_id(&self) -> String {
        write::mint_id()
    }

    /// The capture type a MIME type becomes, or the error desktop's store
    /// gives (unsupported type, empty, over 50 MB).
    pub fn check_file(&self, mime_type: String, size: u64) -> Result<String, StorageError> {
        write::check_file(&mime_type, size).map(str::to_owned)
    }

    /// A text capture; a duplicate of a live one comes back unless `force`.
    pub fn capture_text(
        &self,
        content: String,
        title: Option<String>,
        capture_source: Option<String>,
        force: bool,
    ) -> Result<InboxCaptureOutcome, StorageError> {
        self.write(move |conn, device, now| {
            Ok(write::capture_text(
                conn,
                &content,
                title.as_deref(),
                capture_source.as_deref(),
                force,
                device,
                now,
            )?
            .into())
        })
    }

    /// A link (or social post) capture awaiting enrichment.
    pub fn capture_link(
        &self,
        url: String,
        capture_source: Option<String>,
        force: bool,
    ) -> Result<InboxCaptureOutcome, StorageError> {
        self.write(move |conn, device, now| {
            Ok(
                write::capture_link(conn, &url, capture_source.as_deref(), force, device, now)?
                    .into(),
            )
        })
    }

    /// A file already stored at `attachment_path` (vault-relative). The title
    /// is the filename without its extension; `metadata_json` adds keys
    /// (`width`, `height`, `format`, `pageCount`, `duration`, ...).
    #[allow(clippy::too_many_arguments)]
    pub fn capture_file(
        &self,
        id: String,
        mime_type: String,
        filename: String,
        size: u64,
        attachment_path: String,
        thumbnail_path: Option<String>,
        metadata_json: Option<String>,
        capture_source: Option<String>,
    ) -> Result<InboxItemRecord, StorageError> {
        let kind = write::check_file(&mime_type, size)?;
        let mut metadata = metadata_object(metadata_json.as_deref())?;
        metadata.insert("originalFilename".to_owned(), json!(filename));
        metadata.insert("fileSize".to_owned(), json!(size));
        metadata
            .entry("mimeType".to_owned())
            .or_insert(json!(mime_type));
        let title = match filename.rsplit_once('.') {
            Some((base, _)) if !base.is_empty() => base.to_owned(),
            _ => filename.clone(),
        };
        self.item(move |conn, device, now| {
            write::capture(
                conn,
                &NewCapture {
                    id: Some(id),
                    item_type: kind.to_owned(),
                    title,
                    metadata: Some(Value::Object(metadata)),
                    capture_source,
                    processing_status: "complete".to_owned(),
                    attachment_path: Some(attachment_path),
                    thumbnail_path,
                    ..NewCapture::default()
                },
                device,
                now,
            )
        })
    }

    /// A voice memo stored at `attachment_path`. `transcription_status` is
    /// `pending` when on-device transcription will run, `failed` when it
    /// cannot (D4), `None` when the user turned it off.
    #[allow(clippy::too_many_arguments)]
    pub fn capture_voice(
        &self,
        id: String,
        duration_seconds: f64,
        format: String,
        size: u64,
        attachment_path: String,
        waveform: Vec<f64>,
        transcription_status: Option<String>,
        capture_source: Option<String>,
    ) -> Result<InboxItemRecord, StorageError> {
        if size > write::MAX_FILE_BYTES {
            return Err(StorageError::Invalid {
                what: "File too large: exceeds limit of 50MB".to_owned(),
            });
        }
        let mut metadata =
            json!({ "duration": duration_seconds, "format": format, "fileSize": size });
        if !waveform.is_empty() {
            metadata["waveform"] = json!(waveform);
        }
        self.item(move |conn, device, now| {
            write::capture(
                conn,
                &NewCapture {
                    id: Some(id),
                    item_type: "voice".to_owned(),
                    title: write::voice_title(duration_seconds),
                    metadata: Some(metadata),
                    capture_source,
                    processing_status: "complete".to_owned(),
                    attachment_path: Some(attachment_path),
                    transcription_status,
                    ..NewCapture::default()
                },
                device,
                now,
            )
        })
    }

    pub fn rename(&self, id: String, title: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::update(conn, &id, Some(&title), None, device, now)
        })
    }

    /// A note capture's body; `nil` clears it (an explicit `null`).
    pub fn set_content(
        &self,
        id: String,
        content: Option<String>,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::update(conn, &id, None, Some(content.as_deref()), device, now)
        })
    }

    /// The on-device link preview's result (D3): never overwrites a richer
    /// value a peer wrote.
    pub fn complete_link(
        &self,
        id: String,
        title: Option<String>,
        description: Option<String>,
        metadata_json: String,
    ) -> Result<InboxItemRecord, StorageError> {
        let patch = metadata_object(Some(&metadata_json))?;
        self.item(move |conn, device, now| {
            write::complete_link(
                conn,
                &id,
                title.as_deref(),
                description.as_deref(),
                &patch,
                device,
                now,
            )
        })
    }

    pub fn set_transcription(
        &self,
        id: String,
        transcription: Option<String>,
        status: String,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::set_transcription(conn, &id, transcription.as_deref(), &status, device, now)
        })
    }

    pub fn mark_viewed(&self, id: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| write::mark_viewed(conn, &id, device, now))
    }

    pub fn snooze(
        &self,
        id: String,
        until_ms: i64,
        reason: Option<String>,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::snooze(conn, &id, until_ms, reason.as_deref(), device, now)
        })
    }

    pub fn unsnooze(&self, id: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| write::unsnooze(conn, &id, device, now))
    }

    /// The snooze scheduler's pass: due snoozes cleared and pushed.
    pub fn resurface_due(&self) -> Result<Vec<InboxItemRecord>, StorageError> {
        self.write(|conn, device, now| {
            Ok(write::resurface_due(conn, device, now)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn archive(&self, id: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| write::archive(conn, &id, device, now))
    }

    pub fn unarchive(&self, id: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| write::unarchive(conn, &id, device, now))
    }

    /// A tombstone. The shell removes the capture's files.
    pub fn delete_permanently(&self, id: String) -> Result<(), StorageError> {
        self.write(move |conn, device, now| {
            write::delete_permanent(conn, &id, device, now)?.acknowledge();
            Ok(())
        })
    }

    pub fn add_tag(&self, id: String, tag: String) -> Result<(), StorageError> {
        self.write(move |conn, _, now| write::add_tag(conn, &id, &tag, now))
    }

    pub fn remove_tag(&self, id: String, tag: String) -> Result<(), StorageError> {
        self.write(move |conn, _, _| write::remove_tag(conn, &id, &tag))
    }

    /// Marks a capture filed (the shell's half of filing a file capture).
    pub fn mark_filed(
        &self,
        id: String,
        filed_to: String,
        action: String,
    ) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| {
            write::mark_filed(conn, &id, &filed_to, &action, device, now)
        })
    }

    pub fn undo_file(&self, id: String) -> Result<InboxItemRecord, StorageError> {
        self.item(move |conn, device, now| write::undo_file(conn, &id, device, now))
    }

    /// Files a text capture into `folder` (`nil` = vault root) as a new note.
    pub fn file_to_folder(
        &self,
        id: String,
        folder: Option<String>,
        tags: Vec<String>,
        local_now: String,
    ) -> Result<InboxFiled, StorageError> {
        let now_local = stamp(&local_now)?;
        self.write(move |conn, device, now| {
            let (note, path) = filing::file_text(
                conn,
                &id,
                folder.as_deref(),
                &tags,
                "folder",
                &now_local,
                device,
                now,
            )?;
            Ok(InboxFiled {
                target_id: Some(note),
                filed_to: path,
            })
        })
    }

    /// Convert → Note: a note at the vault root.
    pub fn convert_to_note(
        &self,
        id: String,
        local_now: String,
    ) -> Result<InboxFiled, StorageError> {
        let now_local = stamp(&local_now)?;
        self.write(move |conn, device, now| {
            let (note, path) =
                filing::file_text(conn, &id, None, &[], "note", &now_local, device, now)?;
            Ok(InboxFiled {
                target_id: Some(note),
                filed_to: path,
            })
        })
    }

    /// The empty note a file capture is filed into; the shell uploads the file
    /// into it, then calls [`Inbox::mark_filed`].
    pub fn create_note_for_file(
        &self,
        id: String,
        folder: Option<String>,
        tags: Vec<String>,
        local_now: String,
    ) -> Result<InboxFiled, StorageError> {
        let now_local = stamp(&local_now)?;
        self.write(move |conn, device, now| {
            let item = write::require_live(conn, &id)?;
            let (note, path) = filing::create_filed_note(
                conn,
                &item,
                folder.as_deref(),
                &tags,
                false,
                &now_local,
                device,
                now,
            )?;
            Ok(InboxFiled {
                target_id: Some(note),
                filed_to: path,
            })
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn convert_to_task(
        &self,
        id: String,
        project_id: Option<String>,
        due_date: Option<String>,
        due_time: Option<String>,
        priority: i64,
        local_now: String,
    ) -> Result<InboxFiled, StorageError> {
        let now_local = stamp(&local_now)?;
        self.write(move |conn, device, now| {
            let input = TaskInput {
                project_id,
                due_date,
                due_time,
                priority,
            };
            let task = convert::convert_to_task(conn, &id, &input, &now_local, device, now)?;
            Ok(InboxFiled {
                target_id: Some(task.clone()),
                filed_to: task,
            })
        })
    }

    pub fn convert_to_reminder(
        &self,
        id: String,
        remind_at_ms: i64,
        local_now: String,
    ) -> Result<InboxFiled, StorageError> {
        let now_local = stamp(&local_now)?;
        let iso =
            crate::storage::repositories::instants::to_iso8601(remind_at_ms).ok_or_else(|| {
                StorageError::Invalid {
                    what: "reminder time out of range".to_owned(),
                }
            })?;
        self.write(move |conn, device, now| {
            let note = convert::convert_to_reminder(
                conn,
                &id,
                &iso,
                remind_at_ms,
                &now_local,
                device,
                now,
            )?;
            let filed_to = crate::domain::inbox::get(conn, &id)?
                .and_then(|i| i.filed_to)
                .unwrap_or_default();
            Ok(InboxFiled {
                target_id: Some(note),
                filed_to,
            })
        })
    }

    /// Links a capture into notes (existing or new, in order).
    pub fn link_to_notes(
        &self,
        id: String,
        targets: Vec<InboxLinkTarget>,
        tags: Vec<String>,
        folder: Option<String>,
        local_now: String,
    ) -> Result<Vec<String>, StorageError> {
        let now_local = stamp(&local_now)?;
        let targets: Vec<LinkTarget> = targets
            .into_iter()
            .filter_map(|t| match (t.note_id, t.new_title) {
                (Some(id), _) => Some(LinkTarget::Note(id)),
                (None, Some(title)) if !title.trim().is_empty() => Some(LinkTarget::New(title)),
                _ => None,
            })
            .collect();
        self.write(move |conn, device, now| {
            convert::link_to_notes(
                conn,
                &id,
                &targets,
                &tags,
                folder.as_deref(),
                &now_local,
                device,
                now,
            )
        })
    }

    pub fn bulk_archive(&self, ids: Vec<String>) -> Result<InboxBulkResult, StorageError> {
        self.write(move |conn, device, now| {
            Ok(convert::bulk_archive(conn, &ids, device, now).into())
        })
    }

    pub fn bulk_snooze(
        &self,
        ids: Vec<String>,
        until_ms: i64,
        reason: Option<String>,
    ) -> Result<InboxBulkResult, StorageError> {
        self.write(move |conn, device, now| {
            Ok(convert::bulk_snooze(conn, &ids, until_ms, reason.as_deref(), device, now).into())
        })
    }

    pub fn bulk_tag(
        &self,
        ids: Vec<String>,
        tags: Vec<String>,
    ) -> Result<InboxBulkResult, StorageError> {
        self.write(move |conn, _, now| Ok(convert::bulk_tag(conn, &ids, &tags, now).into()))
    }

    pub fn bulk_file(
        &self,
        ids: Vec<String>,
        folder: Option<String>,
        tags: Vec<String>,
        local_now: String,
    ) -> Result<InboxBulkResult, StorageError> {
        let now_local = stamp(&local_now)?;
        self.write(move |conn, device, now| {
            Ok(convert::bulk_file(
                conn,
                &ids,
                folder.as_deref(),
                &tags,
                &now_local,
                device,
                now,
            )
            .into())
        })
    }
}
