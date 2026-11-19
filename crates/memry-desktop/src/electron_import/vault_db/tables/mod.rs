//! Every table of an Electron vault database pair and what the import does with it.
//!
//! `TABLE_MAP` is exhaustive: the coverage tests replay the frozen Electron migrations and
//! scan the Electron sources for tables created in code, and fail when a table has no entry.
//! At run time [`super::preflight`] refuses a source table that has no entry
//! ([`ImportError::UnmappedTable`]) before anything is written.

use super::ImportError;
use super::TableCtx;

mod agent;
pub mod js_json;
mod locks;
pub(super) mod note_file;
mod notes;
pub mod queue;
pub mod records;
mod row_dumps;
pub mod settings;
mod tags;
pub mod unknown_fields;

/// The Electron database a table lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceDb {
    Data,
    Index,
}

impl SourceDb {
    pub fn name(self) -> &'static str {
        match self {
            Self::Data => "data.db",
            Self::Index => "index.db",
        }
    }
}

/// Who creates the table in Electron: a drizzle migration, or code at open (the FTS and vec0
/// virtual tables and `voice_embedding_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Migration,
    Code,
}

/// How the rows of a class that carries data reach the core: an importer, or the stage (`36b`
/// ... `36f`) that writes it. A source table with rows whose importer is still pending fails
/// the import with [`ImportError::NotReady`]. Stage 36g deletes `Pending`.
#[derive(Debug, Clone, Copy)]
pub enum Importer {
    Pending(&'static str),
    Ready(ImportFn),
}

/// `copy`: same columns and values into a core table. `convert`: a value or shape change into
/// a core table or record type. `reseed`: rows dropped, the owner recreates them. `rebuild`:
/// derived data the owner's projector regenerates. `skip`: nothing carried, the reason says why.
/// Only the two classes that carry rows hold an [`Importer`], so neither can be written without
/// one.
#[derive(Debug, Clone, Copy)]
pub enum Class {
    Copy(Importer),
    Convert(Importer),
    Reseed,
    Rebuild,
    Skip,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Copy(_) => "copy",
            Self::Convert(_) => "convert",
            Self::Reseed => "reseed",
            Self::Rebuild => "rebuild",
            Self::Skip => "skip",
        }
    }

    /// The importer of a class that carries rows to the core; `None` for a class whose rows are
    /// dropped.
    pub fn importer(self) -> Option<Importer> {
        match self {
            Self::Copy(importer) | Self::Convert(importer) => Some(importer),
            Self::Reseed | Self::Rebuild | Self::Skip => None,
        }
    }
}

/// Counts one importer reports for its table.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TableStats {
    pub written: u64,
    /// Source rows not written, by named reason (`staleQueueRows`, `snapshotsWithoutNote`, ...).
    pub dropped: Vec<(&'static str, u64)>,
    /// Source rows written with less than the source held, by named reason (`unreadNoteFiles`).
    pub notices: Vec<(&'static str, u64)>,
}

pub type ImportFn = fn(&mut TableCtx<'_>) -> Result<TableStats, ImportError>;

#[derive(Debug, Clone, Copy)]
pub struct TableMapping {
    pub db: SourceDb,
    pub table: &'static str,
    pub origin: Origin,
    pub owner_step: u8,
    pub class: Class,
    pub reason: &'static str,
}

macro_rules! map {
    ($db:ident $origin:ident $table:literal [$owner:literal, $class:ident => $import:path]: $reason:literal) => {
        map!(@ $db $origin $table $owner, Class::$class(Importer::Ready($import)), $reason)
    };
    ($db:ident $origin:ident $table:literal [$owner:literal, $class:ident, $pending:literal]: $reason:literal) => {
        map!(@ $db $origin $table $owner, Class::$class(Importer::Pending($pending)), $reason)
    };
    ($db:ident $origin:ident $table:literal [$owner:literal, $class:ident]: $reason:literal) => {
        map!(@ $db $origin $table $owner, Class::$class, $reason)
    };
    (@ $db:ident $origin:ident $table:literal $owner:literal, $class:expr, $reason:literal) => {
        TableMapping {
            db: SourceDb::$db,
            table: $table,
            origin: Origin::$origin,
            owner_step: $owner,
            class: $class,
            reason: $reason,
        }
    };
}

/// The last journal entry (`when`) of each frozen Electron migration directory
/// (`tests/fixtures/electron-schema`): `0083_inbox_attachment_id` and `0036_note_task_checks`.
/// A source whose `__drizzle_migrations` ledger ends elsewhere has another schema than the one
/// `TABLE_MAP` describes, and the import refuses it.
pub const ELECTRON_DATA_LAST_MIGRATION: i64 = 1_794_152_091_237;
pub const ELECTRON_INDEX_LAST_MIGRATION: i64 = 1_792_900_300_000;

/// The drizzle migration ledger; never imported, and the core refuses a database holding it.
pub const LEDGER_TABLE: &str = "__drizzle_migrations";

#[rustfmt::skip]
pub const TABLE_MAP: &[TableMapping] = &[
    // data.db, 64 tables (and sync_unknown_fields, last).
    map!(Data Migration "agent_conversations" [16, Convert => agent::agent_conversations]: "agent_conversation records; clock, field clocks and the version 1 title envelope copied byte for byte, never opened"),
    map!(Data Migration "agent_messages" [16, Convert => agent::agent_messages]: "agent_message records; content and attachments envelopes copied byte for byte, never opened"),
    map!(Data Migration "attachment_download_failures" [18, Reseed]: "retry state; rows are dropped and the Step 18 redrive recomputes failures from the manifest"),
    map!(Data Migration "attachment_files" [18, Convert, "36f"]: "Step 18 attachment table (note id, path, attachment id, recorded at)"),
    map!(Data Migration "attachment_upload_queue" [18, Convert, "36f"]: "Step 18 upload queue; pending uploads must survive"),
    map!(Data Migration "bookmarks" [29, Convert, "36d1"]: "core bookmarks table (data 0009) with the Electron clock columns"),
    map!(Data Migration "calendar_bindings" [28, Convert, "36d1"]: "core calendar_bindings; created_at kept verbatim in created_at_raw and parsed to ms"),
    map!(Data Migration "calendar_events" [28, Convert, "36d1"]: "core calendar_events; ISO instants to ms, JSON columns unchanged"),
    map!(Data Migration "calendar_external_events" [28, Convert, "36d1"]: "split by source provider: google and caldav into calendar_external_events, ics and apple-eventkit into calendar_local_events"),
    map!(Data Migration "calendar_sources" [28, Convert, "36d1"]: "core calendar_sources; ISO instants to ms, last_synced_at stays ISO text"),
    map!(Data Migration "canvas_assets" [29, Convert, "36f"]: "Step 30 canvas asset rows with chunk hashes"),
    map!(Data Migration "canvas_entity_edges" [29, Rebuild]: "derived from the canvas scene by the Step 30 projector"),
    map!(Data Migration "canvas_entity_refs" [29, Rebuild]: "derived from the canvas scene by the Step 30 projector"),
    map!(Data Migration "canvas_folders" [16, Convert => records::canvas_folders]: "canvas_folder records as Electron pushes them; created_at and updated_at are not in the payload and are dropped"),
    map!(Data Migration "canvas_library_items" [29, Convert, "36f"]: "decrypted with the vault key into canvases/library.excalidrawlib when that file is absent"),
    map!(Data Migration "canvases" [29, Convert, "36f"]: "Step 30 canvas rows; canvases/*.excalidraw files stay canonical"),
    map!(Data Migration "crdt_body_debts" [17, Convert => super::docs::crdt_body_debts]: "core body debt meta rows sync.body_owed:<docId> through Step 17"),
    map!(Data Migration "crdt_body_withheld" [17, Convert => super::docs::crdt_body_withheld]: "each row becomes a core body debt sync.body_owed:<docId>"),
    map!(Data Migration "crdt_owed_file_bodies" [12, Convert => super::docs::crdt_owed_file_bodies]: "Step 12 owed file body markers through owed_file_body::record, at the original record time"),
    map!(Data Migration "custom_icons" [13, Convert => row_dumps::custom_icons]: "custom_icon sync_items records with the base64 payload; .memry/icons/ files untouched"),
    map!(Data Migration "deleted_asset_releases" [18, Convert, "36f"]: "Step 18 release queue; deleted_at keeps the 30 day grace"),
    map!(Data Migration "filing_history" [26, Skip]: "derived: core derives filing history from filed inbox_items (Inbox::filing_history)"),
    map!(Data Migration "folder_configs" [13, Convert => records::folder_configs]: "core folders table (data 0002, item id is the folder path)"),
    map!(Data Migration "home_pages" [16, Convert => row_dumps::home_pages]: "home_page records, the drizzle row Electron pushes"),
    map!(Data Migration "inbox_attachment_uploads" [27, Convert, "36d1"]: "core inbox_attachment_uploads (data 0016)"),
    map!(Data Migration "inbox_item_tags" [26, Convert, "36d1"]: "core inbox_item_tags table (data 0004)"),
    map!(Data Migration "inbox_items" [26, Convert, "36d1"]: "core inbox table (data 0004) with clocks and attachment_id; dirty rows re-enqueued"),
    map!(Data Migration "inbox_jobs" [26, Reseed]: "transient enrichment jobs; Step 27 re-queues jobs for items without a result"),
    map!(Data Migration "inbox_stats" [26, Rebuild]: "derived counters rebuilt by the Step 27 stats projector"),
    map!(Data Migration "note_metadata" [13, Convert => notes::note_metadata]: "note and journal records built as Electron pushes them (file and index copy) plus the Step 12 note_files row; ids and clocks bit exact"),
    map!(Data Migration "note_positions" [13, Convert => notes::note_positions]: "Step 13 manual order rows (data 0021)"),
    map!(Data Migration "project_links" [21, Convert, "36d2"]: "core project_links table"),
    map!(Data Migration "projects" [21, Convert, "36d2"]: "core projects table; clock JSON kept"),
    map!(Data Migration "property_definitions" [13, Convert => records::property_definitions]: "core property_definitions table"),
    map!(Data Migration "readwise_highlights" [32, Convert, "36f"]: "Step 33 Readwise highlight rows"),
    map!(Data Migration "readwise_links" [32, Convert, "36f"]: "Step 33 Readwise link rows"),
    map!(Data Migration "recently_opened" [29, Convert, "36f"]: "Step 30 recently_opened (device-local, cap 50 kept)"),
    map!(Data Migration "reminders" [21, Convert, "36d2"]: "core reminders; triggered becomes pending plus a reminder_fires row"),
    map!(Data Migration "saved_filters" [21, Convert, "36d2"]: "core saved_filters (data 0003) and saved_filter_expressions (data 0015)"),
    map!(Data Migration "search_reasons" [29, Convert, "36f"]: "Step 30 search_reasons (device-local, cap 20 kept)"),
    map!(Data Migration "settings" [9, Convert => settings::settings]: "per-key rules in tables/settings.rs: synced record, meta, local_settings, skipped config caches"),
    map!(Data Migration "statuses" [21, Convert, "36d2"]: "core project_statuses table"),
    map!(Data Migration "sticky_drafts" [16, Convert => row_dumps::sticky_drafts]: "sticky_draft records, the drizzle row Electron pushes"),
    map!(Data Migration "suggestion_feedback" [26, Convert, "36d1"]: "Step 27 inbox_suggestion_feedback (device-local)"),
    map!(Data Migration "sync_devices" [19, Skip]: "device list comes from the server, device id from memry-config.json; the key check is Step 37"),
    map!(Data Migration "sync_history" [17, Convert, "36c3"]: "Step 17 sync_history: type becomes kind, epoch seconds to ms, newest 500 rows"),
    map!(Data Migration "sync_intents" [17, Convert, "36c2"]: "each row becomes one core outbox record row for its type and item id"),
    map!(Data Migration "sync_pending_deletes" [17, Convert, "36c2"]: "core outbox delete rows plus tombstone sync items"),
    map!(Data Migration "sync_state" [17, Convert, "36c3"]: "per-key rules in sync_state.rs (SYNC_STATE_KEYS)"),
    map!(Data Migration "tag_categories" [13, Convert => tags::tag_categories]: "core tag_categories table"),
    map!(Data Migration "tag_definitions" [13, Convert => tags::tag_definitions]: "core tag_definitions table"),
    map!(Data Migration "task_activity" [21, Convert, "36d2"]: "core task_activity table"),
    map!(Data Migration "task_canvases" [21, Convert, "36d2"]: "payload linkedCanvasIds of the task; task_links rebuilt afterwards"),
    map!(Data Migration "task_notes" [21, Convert, "36d2"]: "core tasks.linked_note_ids and payload linkedNoteIds; task_links rebuilt afterwards"),
    map!(Data Migration "task_tags" [21, Convert, "36d2"]: "core tasks.tags JSON column and tags of the payload"),
    map!(Data Migration "tasks" [21, Convert, "36d2"]: "core tasks table; 16 field clocks kept"),
    map!(Data Migration "templates" [13, Convert => row_dumps::templates]: "core templates table"),
    map!(Data Migration "vault_lock_baselines" [14, Convert => locks::vault_lock_baselines]: "Step 14 vault_lock_baselines (data 0025) through vault_locks::write_baseline, updated_at to ms"),
    map!(Data Migration "vault_lock_file_modes" [14, Convert => locks::vault_lock_file_modes]: "Step 14 vault_lock_file_modes (data 0025) through vault_locks::record_file_mode"),
    map!(Data Migration "vault_locks" [14, Convert => locks::vault_locks]: "vault_lock records as Electron pushes them; unclocked rows staged unclocked"),
    map!(Data Migration "vault_metadata" [8, Copy => records::vault_metadata]: "singleton vault uuid into core meta vault.id, bit exact; Step 37 opens the vault under it"),
    // index.db, 16 tables.
    map!(Index Migration "block_link_refs" [13, Rebuild]: "derived link table; rebuilt from vault files"),
    map!(Index Migration "extracted_text" [25, Copy, "36e"]: "Step 25 extracted_text; kept when the file signature and OCR language set match"),
    map!(Index Migration "file_text_jobs" [25, Copy, "36e"]: "Step 25 file_text_jobs; done rows keep their signature, others reset to pending"),
    map!(Index Migration "graph_layouts" [29, Copy, "36f"]: "Step 30 graph_layouts in data.db, time to ms, so pinned nodes survive"),
    map!(Index Migration "image_embedding_state" [23, Copy, "36e"]: "copied with its vec rows (width 256, same input_version), else dropped with them"),
    map!(Index Migration "note_cache" [13, Rebuild]: "derived note cache rebuilt from vault files and core notes"),
    map!(Index Migration "note_embedding_state" [23, Copy, "36e"]: "copied with its vec rows (width 256, same input_version), else dropped with them"),
    map!(Index Migration "note_fold_chunks" [14, Rebuild]: "90 day cache"),
    map!(Index Migration "note_links" [13, Rebuild]: "derived links"),
    map!(Index Migration "note_names" [13, Rebuild]: "derived names"),
    map!(Index Migration "note_properties" [13, Rebuild]: "derived properties"),
    map!(Index Migration "note_snapshots" [14, Copy => notes::note_snapshots]: "core note_snapshots (data 0018); user data in a derived database"),
    map!(Index Migration "note_tags" [13, Rebuild]: "derived tags"),
    map!(Index Migration "portal_refs" [13, Rebuild]: "derived portal references"),
    map!(Index Migration "property_definitions" [13, Rebuild]: "cache copy of the data row"),
    map!(Index Migration "property_refs" [13, Rebuild]: "derived property references"),
    // Created in code at open: 8 virtual tables and one state table.
    map!(Data Code "fts_tasks" [21, Rebuild]: "created by the owner step code at open, filled by its projector"),
    map!(Data Code "fts_inbox" [26, Rebuild]: "created by the owner step code at open, filled by its projector"),
    map!(Index Code "fts_notes" [23, Rebuild]: "created by the owner step code at open, filled by its projector"),
    map!(Index Code "vec_notes" [23, Copy, "36e"]: "vec0 rows copied when width is 256 and input_version matches Step 23"),
    map!(Index Code "vec_note_chunks" [23, Copy, "36e"]: "same rule as vec_notes"),
    map!(Index Code "vec_note_similar" [23, Copy, "36e"]: "same rule as vec_notes"),
    map!(Index Code "vec_images" [23, Copy, "36e"]: "same rule as vec_notes, with image_embedding_state"),
    map!(Index Code "vec_voice" [23, Copy, "36e"]: "same rule as vec_notes, with voice_embedding_state"),
    map!(Index Code "voice_embedding_state" [23, Copy, "36e"]: "copied with vec_voice (same width and input_version rule), else dropped with it"),
    // After every record table: queued pushes are planned against the staged records.
    map!(Data Migration "sync_tombstone_clocks" [17, Copy => queue::sync_tombstone_clocks]: "core sync_tombstone_clocks (data 0005); the note family row under note and journal"),
    map!(Data Migration "sync_queue" [17, Convert => queue::sync_queue]: "folded per item into core outbox rows through outbox::enqueue; deletes write their tombstone; note_body rows become CRDT outbox rows (docs.rs)"),
    map!(Data Migration "note_body_sync" [17, Convert => super::docs::note_body_sync]: "Step 17 note_body_sync; pushed_state_vector dropped and counted (not in core); after note_metadata and sync_queue, its in-flight full states name a staged note"),
    // Last: it counts the merge into the records every table above wrote.
    map!(Data Migration "sync_unknown_fields" [16, Convert => unknown_fields::import]: "merged into the verbatim sync_items.payload of the same (type, item_id)"),
];

/// What a refused user is told a pending stage carries, in their words. `None` for a name that
/// is no stage (the coverage test holds every pending entry to a known one).
pub fn pending_area(stage: &str) -> Option<&'static str> {
    Some(match stage {
        "36b" => "settings, vault locks, AI chats or canvas folders",
        // `sync_pending_deletes` holds every local delete until the manifest check sees the
        // server no longer lists it, so a synced vault nearly always has rows; `sync_intents`
        // holds local changes still owed to the server.
        "36c2" => "deletes the sync server has not confirmed yet, or changes waiting to sync",
        "36c3" => "sync progress",
        "36c4" => "note edit history",
        "36d1" => "inbox items, calendars or bookmarks",
        "36d2" => "tasks or projects",
        "36e" => "search and similar-note data",
        "36f" => "attachments, whiteboards or Readwise highlights",
        _ => return None,
    })
}

pub fn mapping(db: SourceDb, table: &str) -> Option<&'static TableMapping> {
    TABLE_MAP.iter().find(|m| m.db == db && m.table == table)
}

#[cfg(test)]
mod coverage_tests;
