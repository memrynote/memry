//! `packages/importers/src/messages.ts`: the stable codes of every warning, skip reason and
//! progress line an importer shows. The renderer maps a code to its translation and falls back
//! to the English `message`. The strings are a contract with the renderer's code-to-key map;
//! `importer_vectors.rs` compares them with `test-vectors/importers/messages.json`, which the
//! TypeScript generator writes from the module itself.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `IMPORT_MESSAGE_CODES`: warnings, errors and skip reasons.
pub mod codes {
    pub const READ_FILE_FAILED: &str = "readFileFailed";
    pub const APPLE_NOTES_LOCKED_NOTE: &str = "appleNotes.lockedNote";
    pub const APPLE_NOTES_LOCKED_WRONG_PASSWORD: &str = "appleNotes.lockedWrongPassword";
    pub const APPLE_NOTES_LOCKED_UNREADABLE: &str = "appleNotes.lockedUnreadable";
    pub const APPLE_NOTES_LOCKED_ATTACHMENT: &str = "appleNotes.lockedAttachment";
    pub const CSV_NO_HEADERS: &str = "csv.noHeaders";
    pub const CSV_EMPTY_TITLE: &str = "csv.emptyTitle";
    pub const CSV_COLUMNS: &str = "csv.columns";
    pub const CSV_TITLE_COLUMN: &str = "csv.titleColumn";
    pub const RAINDROP_CSV_EMPTY: &str = "raindrop.csvEmpty";
    pub const RAINDROP_HEADER_NOT_FOUND: &str = "raindrop.headerNotFound";
    pub const RAINDROP_ROW_NO_URL: &str = "raindrop.rowNoUrl";
    pub const TICKTICK_HEADER_NOT_FOUND: &str = "ticktick.headerNotFound";
    pub const TICKTICK_FOLDERS_DROPPED: &str = "ticktick.foldersDropped";
    pub const TICKTICK_SUBTASK_PARENT_MISSING: &str = "ticktick.subtaskParentMissing";
    pub const TICKTICK_UNKNOWN_PRIORITY: &str = "ticktick.unknownPriority";
    pub const TICKTICK_UNSUPPORTED_REPEAT: &str = "ticktick.unsupportedRepeat";
    pub const TICKTICK_REMINDER_NO_ANCHOR: &str = "ticktick.reminderNoAnchor";
    pub const TODOIST_HEADER_NOT_FOUND: &str = "todoist.headerNotFound";
    pub const TODOIST_SECTION_FLATTENED: &str = "todoist.sectionFlattened";
    pub const TODOIST_ORPHAN_COMMENT: &str = "todoist.orphanComment";
    pub const TODOIST_EMPTY_TITLE: &str = "todoist.emptyTitle";
    pub const TODOIST_UNKNOWN_PRIORITY: &str = "todoist.unknownPriority";
    pub const TODOIST_UNPARSED_DATE: &str = "todoist.unparsedDate";
    pub const TODOIST_SUBTASK_NO_PARENT: &str = "todoist.subtaskNoParent";
    pub const READWISE_TOKEN_MISSING: &str = "readwise.tokenMissing";
    pub const READWISE_TOKEN_INVALID: &str = "readwise.tokenInvalid";
    pub const READWISE_UNREACHABLE: &str = "readwise.unreachable";
    pub const READWISE_CATEGORY_OFF: &str = "readwise.categoryOff";
    pub const READWISE_UNCHANGED: &str = "readwise.unchanged";
    pub const READWISE_SOURCE_DELETED: &str = "readwise.sourceDeleted";
    pub const READWISE_NOTE_DELETED: &str = "readwise.noteDeleted";
    pub const READWISE_BUSY: &str = "readwise.busy";

    /// Every code, keyed by its TypeScript name, for the contract test.
    pub const ALL: [(&str, &str); 33] = [
        ("readFileFailed", READ_FILE_FAILED),
        ("appleNotesLockedNote", APPLE_NOTES_LOCKED_NOTE),
        (
            "appleNotesLockedWrongPassword",
            APPLE_NOTES_LOCKED_WRONG_PASSWORD,
        ),
        ("appleNotesLockedUnreadable", APPLE_NOTES_LOCKED_UNREADABLE),
        ("appleNotesLockedAttachment", APPLE_NOTES_LOCKED_ATTACHMENT),
        ("csvNoHeaders", CSV_NO_HEADERS),
        ("csvEmptyTitle", CSV_EMPTY_TITLE),
        ("csvColumns", CSV_COLUMNS),
        ("csvTitleColumn", CSV_TITLE_COLUMN),
        ("raindropCsvEmpty", RAINDROP_CSV_EMPTY),
        ("raindropHeaderNotFound", RAINDROP_HEADER_NOT_FOUND),
        ("raindropRowNoUrl", RAINDROP_ROW_NO_URL),
        ("ticktickHeaderNotFound", TICKTICK_HEADER_NOT_FOUND),
        ("ticktickFoldersDropped", TICKTICK_FOLDERS_DROPPED),
        (
            "ticktickSubtaskParentMissing",
            TICKTICK_SUBTASK_PARENT_MISSING,
        ),
        ("ticktickUnknownPriority", TICKTICK_UNKNOWN_PRIORITY),
        ("ticktickUnsupportedRepeat", TICKTICK_UNSUPPORTED_REPEAT),
        ("ticktickReminderNoAnchor", TICKTICK_REMINDER_NO_ANCHOR),
        ("todoistHeaderNotFound", TODOIST_HEADER_NOT_FOUND),
        ("todoistSectionFlattened", TODOIST_SECTION_FLATTENED),
        ("todoistOrphanComment", TODOIST_ORPHAN_COMMENT),
        ("todoistEmptyTitle", TODOIST_EMPTY_TITLE),
        ("todoistUnknownPriority", TODOIST_UNKNOWN_PRIORITY),
        ("todoistUnparsedDate", TODOIST_UNPARSED_DATE),
        ("todoistSubtaskNoParent", TODOIST_SUBTASK_NO_PARENT),
        ("readwiseTokenMissing", READWISE_TOKEN_MISSING),
        ("readwiseTokenInvalid", READWISE_TOKEN_INVALID),
        ("readwiseUnreachable", READWISE_UNREACHABLE),
        ("readwiseCategoryOff", READWISE_CATEGORY_OFF),
        ("readwiseUnchanged", READWISE_UNCHANGED),
        ("readwiseSourceDeleted", READWISE_SOURCE_DELETED),
        ("readwiseNoteDeleted", READWISE_NOTE_DELETED),
        ("readwiseBusy", READWISE_BUSY),
    ];
}

/// `IMPORT_STATUS_CODES` with the English line of `IMPORT_STATUS`, keyed by the TypeScript
/// name. `importingItem` and `onenoteDownloadingAttachment` interpolate and have functions.
pub const STATUS: [(&str, &str, &str); 15] = [
    (
        "scanningFiles",
        "status.scanningFiles",
        "Scanning files\u{2026}",
    ),
    (
        "scanningExport",
        "status.scanningExport",
        "Scanning export\u{2026}",
    ),
    (
        "appleNotesCopyingDatabase",
        "status.appleNotes.copyingDatabase",
        "Copying Apple Notes database\u{2026}",
    ),
    (
        "bearScanning",
        "status.bear.scanning",
        "Scanning Bear export\u{2026}",
    ),
    (
        "csvImporting",
        "status.csv.importing",
        "Importing CSV notes\u{2026}",
    ),
    (
        "evernoteScanning",
        "status.evernote.scanning",
        "Scanning .enex files\u{2026}",
    ),
    (
        "htmlScanning",
        "status.html.scanning",
        "Scanning HTML files\u{2026}",
    ),
    (
        "notePlanScanning",
        "status.noteplan.scanning",
        "Scanning NotePlan folder\u{2026}",
    ),
    (
        "onenoteLoadingNotebooks",
        "status.onenote.loadingNotebooks",
        "Loading OneNote notebooks\u{2026}",
    ),
    (
        "onenoteRateLimited",
        "status.onenote.rateLimited",
        "OneNote is rate-limiting; waiting before retrying\u{2026}",
    ),
    (
        "raindropImporting",
        "status.raindrop.importing",
        "Importing Raindrop bookmarks\u{2026}",
    ),
    (
        "roamReading",
        "status.roam.reading",
        "Reading Roam export\u{2026}",
    ),
    (
        "ticktickImporting",
        "status.ticktick.importing",
        "Importing TickTick tasks\u{2026}",
    ),
    (
        "todoistImporting",
        "status.todoist.importing",
        "Importing Todoist tasks\u{2026}",
    ),
    (
        "readwiseFetching",
        "status.readwise.fetching",
        "Reading your Readwise library\u{2026}",
    ),
];

pub const IMPORTING_ITEM_CODE: &str = "status.importingItem";
pub const ONENOTE_DOWNLOADING_ATTACHMENT_CODE: &str = "status.onenote.downloadingAttachment";

/// `ImportMessage`: a code the renderer translates, the English text it shows otherwise, and
/// the values the translation interpolates (strings or numbers, in insertion order).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Map<String, Value>>,
}

impl ImportMessage {
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.to_owned()),
            message: message.into(),
            params: None,
        }
    }

    pub fn with_param(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params
            .get_or_insert_with(Map::new)
            .insert(key.to_owned(), value.into());
        self
    }
}

/// `string | ImportMessage` (`ImportPreviewMessage`): a status line, warning or skip reason.
/// Plain text renders verbatim; payloads of older builds carry it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ImportText {
    Text(String),
    Message(ImportMessage),
}

impl ImportText {
    /// The code, when the text has one.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Text(_) => None,
            Self::Message(message) => message.code.as_deref(),
        }
    }

    /// The English text.
    pub fn text(&self) -> &str {
        match self {
            Self::Text(text) => text,
            Self::Message(message) => &message.message,
        }
    }
}

impl From<&str> for ImportText {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<ImportMessage> for ImportText {
    fn from(message: ImportMessage) -> Self {
        Self::Message(message)
    }
}

/// One fixed line of `IMPORT_STATUS` by its TypeScript name.
///
/// # Panics
/// On a name [`STATUS`] does not hold: a typo, caught by the importer's first test.
pub fn status(name: &str) -> ImportMessage {
    let (_, code, message) = STATUS
        .iter()
        .find(|(key, _, _)| *key == name)
        .unwrap_or_else(|| panic!("no import status line named {name}"));
    ImportMessage::coded(code, *message)
}

/// `importingItemStatus`: the per-item line.
pub fn importing_item(title: &str) -> ImportMessage {
    ImportMessage::coded(IMPORTING_ITEM_CODE, format!("Importing {title}"))
        .with_param("title", title)
}

/// `onenoteDownloadingAttachmentStatus`.
pub fn onenote_downloading_attachment(name: &str) -> ImportMessage {
    ImportMessage::coded(
        ONENOTE_DOWNLOADING_ATTACHMENT_CODE,
        format!("Downloading attachment {name}"),
    )
    .with_param("name", name)
}
