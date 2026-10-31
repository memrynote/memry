//! The app's note reads (Step 13f, #3530) over a vault the running tier adopted: a note's text
//! comes from its file, read bounded and classified by size before the editor gets it; a list
//! is the records and their rows in one query.

mod device_key;
mod vault_env;

use std::path::Path;
use std::sync::Arc;

use memry_core::domain::note_files::NoteFileStat;
use memry_core::markdown::shared::markdown_class::{NOTE_MAX_BLOCK_BYTES, NOTE_MAX_BYTES};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::{NotesError, Unopenable};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::view::{
    AttachedFileType, LargeFileReasonView, NoteListFields, NoteListOptions, NoteListSortBy,
    SizeClass, SortOrder, TranscriptionStatus,
};
use memry_desktop::session::OpenVault;
use memry_desktop::telemetry::{Context, Sender, Service};
use serde_json::json;
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\ntags:\n  - alpha\nstatus: open\naliases: Plan B\n---\nHello world\n";

/// A vault of a note in a folder and one at the root, opened and walked; the identity makes
/// both notes.
fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    opened_with(&[])
}

/// `opened`, with `more` files beside the two notes.
fn opened_with(more: &[(&str, &str)]) -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write("work/Plan.md", PLAN);
    e.write("Loose.md", "Just text\n");
    for (path, text) in more {
        e.write(path, text);
    }
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    (e, open, kept.expect("the store"))
}

fn id_of(open: &OpenVault, path: &str) -> String {
    read::get_by_path(open, path, None).unwrap().expect(path).id
}

/// Runs `sql` on the open vault's records. The records stamp their instants from the clock
/// and a delete wakes the write-back, so a test that needs exact instants or a tombstone the
/// write-back cannot race plants them.
fn plant(e: &Env, sql: &str, params: impl rusqlite::Params) {
    let conn = rusqlite::Connection::open(e.vault.join(".memry/core/data.db")).unwrap();
    conn.execute(sql, params).unwrap();
}

fn titles(open: &OpenVault, options: &NoteListOptions) -> Vec<String> {
    let page = read::list(open, options).unwrap();
    page.notes.into_iter().map(|note| note.title).collect()
}

/// `link` points at the folder `target`: a symlink on Unix, a junction on Windows, which needs
/// no elevation.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }
}

#[test]
fn a_note_reads_its_text_and_fields_from_its_file() {
    let (_e, open, _) = opened();
    let note = read::get_by_path(&open, "work/Plan.md", None)
        .unwrap()
        .unwrap();
    assert_eq!(note.title, "Plan");
    // The body as the file holds it, final newline and all (`parseNote`).
    assert_eq!(note.content, "Hello world\n");
    assert_eq!(note.header_tags, ["alpha"]);
    assert_eq!(note.tags, ["alpha"]);
    assert_eq!(note.aliases, ["Plan B"]);
    assert_eq!(
        note.properties,
        *json!({ "status": "open" }).as_object().unwrap()
    );
    assert_eq!(note.frontmatter["status"], "open");
    assert_eq!(note.word_count, 2);
    assert_eq!(note.size_class, SizeClass::Note);
    assert!(!note.content_omitted);
    assert_eq!(read::get(&open, &note.id, None).unwrap(), Some(note));
    assert_eq!(read::get(&open, "no-such-note", None).unwrap(), None);
    assert_eq!(
        read::get_by_path(&open, "work/Gone.md", None).unwrap(),
        None
    );
}

#[test]
fn a_frontmatter_that_does_not_parse_costs_the_note_no_body() {
    let (e, open, _) = opened();
    e.write("Loose.md", "---\ntags: [unclosed\n---\nStill here\n");
    let note = read::get_by_path(&open, "Loose.md", None).unwrap().unwrap();
    assert_eq!(note.content, "Still here\n");
    assert!(note.frontmatter.is_empty() && note.header_tags.is_empty());
}

#[test]
fn a_note_past_the_size_class_reads_without_its_text() {
    let (e, open, _) = opened();
    // A note grows past the class and stays a note (`notes::identity`); the read goes by the
    // bytes on disk, whatever the watcher made of them yet.
    e.write("Loose.md", &"a".repeat(NOTE_MAX_BLOCK_BYTES + 1));
    // The file is never parsed, so the properties are the record's.
    plant(
        &e,
        "UPDATE notes SET properties = '{\"status\":\"draft\"}' WHERE id = ?1",
        [id_of(&open, "Loose.md").as_str()],
    );
    let by_block = read::get_by_path(&open, "Loose.md", None).unwrap().unwrap();
    assert_eq!(
        by_block.properties,
        *json!({ "status": "draft" }).as_object().unwrap()
    );
    assert_eq!(by_block.size_class, SizeClass::LargeFile);
    assert!(by_block.content_omitted);
    assert_eq!(by_block.content, "");
    let info = by_block.large_file.expect("measured");
    assert_eq!(info.reason, LargeFileReasonView::BlockBytes);
    assert_eq!(
        info.largest_block_bytes,
        Some((NOTE_MAX_BLOCK_BYTES + 1) as u32)
    );

    // Past the byte ceiling the size alone decides: no block was measured.
    e.write("Loose.md", &"word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1));
    let by_size = read::get_by_path(&open, "Loose.md", None).unwrap().unwrap();
    let info = by_size.large_file.expect("measured");
    assert_eq!(info.reason, LargeFileReasonView::FileBytes);
    assert_eq!(info.largest_block_bytes, None);
    assert!(by_size.content_omitted);
}

#[test]
fn a_list_pages_the_notes_of_a_folder_and_the_tree_leaves_out_what_it_never_reads() {
    let (_e, open, _) = opened();
    let by_title = NoteListOptions {
        sort_by: Some(NoteListSortBy::Title),
        sort_order: Some(SortOrder::Asc),
        ..NoteListOptions::default()
    };
    let all = read::list(&open, &by_title).unwrap();
    let titles: Vec<_> = all.notes.iter().map(|note| note.title.as_str()).collect();
    assert_eq!(titles, ["Loose", "Plan"]);
    assert_eq!((all.total, all.has_more), (2, false));

    let page = read::list(
        &open,
        &NoteListOptions {
            limit: Some(1),
            ..by_title.clone()
        },
    )
    .unwrap();
    let titles: Vec<_> = page.notes.iter().map(|note| note.title.as_str()).collect();
    assert_eq!(titles, ["Loose"]);
    assert_eq!((page.total, page.has_more), (2, true));
    let next = read::list(
        &open,
        &NoteListOptions {
            limit: Some(1),
            offset: Some(1),
            ..by_title.clone()
        },
    )
    .unwrap();
    assert_eq!(next.notes[0].title, "Plan");
    assert!(!next.has_more);

    let work = read::list(
        &open,
        &NoteListOptions {
            folder: Some("work".into()),
            ..NoteListOptions::default()
        },
    )
    .unwrap();
    assert_eq!(work.notes.len(), 1);
    assert_eq!(work.notes[0].path, "work/Plan.md");

    let tree = read::list(
        &open,
        &NoteListOptions {
            fields: Some(NoteListFields::Tree),
            ..NoteListOptions::default()
        },
    )
    .unwrap();
    assert_eq!(tree.notes.len(), 2);
    assert!(
        tree.notes
            .iter()
            .all(|note| note.aliases.is_none() && note.mime_type.is_none())
    );
}

#[test]
fn a_note_is_there_by_path_or_by_a_title_a_link_resolves() {
    let (_e, open, _) = opened();
    assert!(read::exists(&open, "work/Plan.md").unwrap());
    assert!(!read::exists(&open, "work/Gone.md").unwrap());
    assert!(read::exists(&open, "Plan").unwrap());
    assert!(!read::exists(&open, "Gone").unwrap());
}

#[test]
fn a_file_note_reads_as_file_metadata_and_a_markdown_note_does_not() {
    let (e, open, store) = opened();
    // No step makes a file note yet (attachments do); its record and row, planted.
    e.write("scan.pdf", "%PDF-1.4\n");
    let core = e.core();
    let id = core
        .notes_writer(store)
        .unwrap()
        .create("scan".into(), None)
        .unwrap();
    core.note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: "scan.pdf".into(),
            file_type: "pdf".into(),
            mime_type: Some("application/pdf".into()),
            file_size: Some(9),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    let pdf = read::get_file(&open, &id).unwrap().expect("a file");
    assert_eq!(pdf.file_type, AttachedFileType::Pdf);
    assert_eq!(pdf.mime_type.as_deref(), Some("application/pdf"));
    assert_eq!((pdf.path.as_str(), pdf.file_size), ("scan.pdf", Some(9)));

    let plan = id_of(&open, "work/Plan.md");
    assert_eq!(read::get_file(&open, &plan).unwrap(), None);
    let path = read::file_path(&open, &plan).unwrap();
    assert_eq!(path, e.vault.join("work/Plan.md"));
}

#[test]
fn a_deleted_note_is_gone_from_the_list_and_every_read() {
    let (e, open, _) = opened();
    let plan = id_of(&open, "work/Plan.md");
    // The tombstone alone: the row and the file stay, as they do until the write-back runs.
    plant(
        &e,
        "UPDATE notes SET deleted_at = 1 WHERE id = ?1",
        [plan.as_str()],
    );
    let page = read::list(&open, &NoteListOptions::default()).unwrap();
    assert_eq!(
        page.notes
            .iter()
            .map(|n| n.title.as_str())
            .collect::<Vec<_>>(),
        ["Loose"]
    );
    assert_eq!(page.total, 1);
    assert_eq!(read::get(&open, &plan, None).unwrap(), None);
    assert_eq!(
        read::get_by_path(&open, "work/Plan.md", None).unwrap(),
        None
    );
    assert!(!read::exists(&open, "work/Plan.md").unwrap());
}

#[test]
fn a_tag_filter_folds_case_and_wants_every_tag() {
    let (e, open, store) = opened();
    let writer = e.core().notes_writer(store).unwrap();
    let plan = id_of(&open, "work/Plan.md");
    writer
        .set_tags(plan.clone(), vec!["Ünal".into(), "Alpha".into()])
        .unwrap();
    writer
        .set_tags(id_of(&open, "Loose.md"), vec!["alpha".into()])
        .unwrap();
    let tagged = |tags: &[&str]| NoteListOptions {
        tags: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
        sort_by: Some(NoteListSortBy::Title),
        sort_order: Some(SortOrder::Asc),
        ..NoteListOptions::default()
    };

    // `ALPHA` is `alpha` and `Alpha`; `ünal` is `Ünal`, a fold `COLLATE NOCASE` misses.
    assert_eq!(titles(&open, &tagged(&["ALPHA"])), ["Loose", "Plan"]);
    assert_eq!(titles(&open, &tagged(&["ünal"])), ["Plan"]);
    assert_eq!(titles(&open, &tagged(&["alpha", "ünal"])), ["Plan"]);
    assert_eq!(
        read::list(&open, &tagged(&["alpha", "ünal"]))
            .unwrap()
            .total,
        1
    );
    assert!(titles(&open, &tagged(&["alpha", "gone"])).is_empty());
    // In the order they were given (`getNoteTags` orders by position), not by name.
    let note = read::get(&open, &plan, None).unwrap().unwrap();
    assert_eq!(note.tags[..2], ["Ünal", "Alpha"]);
}

#[test]
fn a_list_sorts_by_the_instant_it_is_asked_for() {
    let (e, open, _) = opened();
    let stamp = |path: &str, created: i64, modified: i64| {
        plant(
            &e,
            "UPDATE notes SET created_at = ?1, modified_at = ?2 WHERE id = ?3",
            rusqlite::params![created, modified, id_of(&open, path)],
        );
    };
    // Loose was made first and changed last.
    stamp("Loose.md", 1_000, 4_000);
    stamp("work/Plan.md", 2_000, 3_000);
    let by = |sort_by: NoteListSortBy, sort_order: SortOrder| NoteListOptions {
        sort_by: Some(sort_by),
        sort_order: Some(sort_order),
        ..NoteListOptions::default()
    };
    assert_eq!(
        titles(&open, &by(NoteListSortBy::Created, SortOrder::Desc)),
        ["Plan", "Loose"]
    );
    assert_eq!(
        titles(&open, &by(NoteListSortBy::Created, SortOrder::Asc)),
        ["Loose", "Plan"]
    );
    assert_eq!(
        titles(&open, &by(NoteListSortBy::Modified, SortOrder::Desc)),
        ["Loose", "Plan"]
    );
    assert_eq!(
        titles(&open, &by(NoteListSortBy::Modified, SortOrder::Asc)),
        ["Plan", "Loose"]
    );
    // `position` lists as `modified` does (`listNotesFromCache`).
    assert_eq!(
        titles(&open, &by(NoteListSortBy::Position, SortOrder::Desc)),
        ["Loose", "Plan"]
    );
}

#[test]
fn a_folder_lists_what_is_under_it_and_not_a_folder_its_name_starts() {
    let (_e, open, _) = opened_with(&[
        ("workshop/Bench.md", "Saw\n"),
        ("work/deep/Nested.md", "Down\n"),
    ]);
    let work = NoteListOptions {
        folder: Some("work".into()),
        sort_by: Some(NoteListSortBy::Title),
        sort_order: Some(SortOrder::Asc),
        ..NoteListOptions::default()
    };
    assert_eq!(titles(&open, &work), ["Nested", "Plan"]);
    let workshop = NoteListOptions {
        folder: Some("workshop".into()),
        ..work
    };
    assert_eq!(titles(&open, &workshop), ["Bench"]);
}

#[test]
fn a_file_path_through_a_link_out_of_the_vault_is_refused() {
    let (e, open, store) = opened();
    let outside = e._dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("Secret.md"), "not the vault's\n").unwrap();
    link_dir(&e.vault.join("out"), &outside);
    // A row naming a file behind the link, planted: the walk never adopts what a link leads to.
    let core = e.core();
    let id = core
        .notes_writer(store)
        .unwrap()
        .create("Secret".into(), None)
        .unwrap();
    core.note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: "out/Secret.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(16),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    assert!(matches!(
        read::file_path(&open, &id),
        Err(NotesError::Outside)
    ));
    // Nor is its text read.
    assert!(matches!(
        read::get(&open, &id, None),
        Err(NotesError::Outside)
    ));
}

#[test]
fn a_hard_linked_note_file_fails_with_its_reason() {
    let (e, open, _) = opened();
    let plan = id_of(&open, "work/Plan.md");
    std::fs::hard_link(e.vault.join("work/Plan.md"), e._dir.path().join("twin.md")).unwrap();
    let error = read::get(&open, &plan, None).unwrap_err();
    assert!(
        matches!(error, NotesError::Unopenable(Unopenable::HardLinked)),
        "{error:?}"
    );
    assert!(error.to_string().contains("hard link"), "{error}");
}

/// A telemetry service that queues and never sends: its endpoint is never reached.
fn telemetry(dir: &Path) -> Service {
    let context = Context {
        install_id: "11111111-1111-4111-8111-111111111111".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "linux".into(),
        arch: "x64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    let sender = Sender::new(
        "http://127.0.0.1:9/telemetry/batch",
        memry_desktop::seams::transport::NativeTransport::loopback(),
    );
    Service::start(dir, context, sender, true)
}

#[test]
fn a_note_whose_file_is_gone_reads_as_none_and_is_counted() {
    let (e, open, _) = opened();
    let plan = id_of(&open, "work/Plan.md");
    let service = telemetry(e._dir.path());
    // The row names a file that is not there, as when a file goes before the watcher sees it;
    // planted, so the watcher cannot remove the row first.
    plant(
        &e,
        "UPDATE note_files SET path = 'work/Gone.md' WHERE note_id = ?1",
        [plan.as_str()],
    );
    assert_eq!(read::get(&open, &plan, Some(&service)).unwrap(), None);
    let missing: Vec<_> = service
        .queued()
        .into_iter()
        .filter(|event| {
            event.name == "app_log_recorded"
                && event
                    .dimensions
                    .as_ref()
                    .and_then(|d| d.get("log_action"))
                    .is_some_and(|action| action == "note_file_missing")
        })
        .collect();
    assert_eq!(missing.len(), 1, "{:?}", service.queued());
    assert_eq!(missing[0].error_code.as_deref(), Some("NOTE_FILE_MISSING"));
}

/// A note for the file at `path`, record and row planted: no step makes a file note yet.
fn file_note(e: &Env, store: &Arc<dyn SecureStore>, path: &str, file_type: &str) -> String {
    let core = e.core();
    let title = path.rsplit('/').next().unwrap().to_owned();
    let id = core
        .notes_writer(store.clone())
        .unwrap()
        .create(title, None)
        .unwrap();
    core.note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: path.into(),
            file_type: file_type.into(),
            mime_type: None,
            file_size: Some(1),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    id
}

#[test]
fn a_filed_voice_memo_reads_with_its_transcription_and_a_gone_file_reads_as_none() {
    let (e, open, store) = opened();
    e.write("audio/memo.m4a", "m");
    let memo = file_note(&e, &store, "audio/memo.m4a", "audio");
    // Two voice captures were filed to the file; the later one's transcription is the file's.
    for (id, filed_at, text, status) in [
        ("v1", 1, "first take", "failed"),
        ("v2", 2, "buy milk", "complete"),
    ] {
        plant(
            &e,
            "INSERT INTO inbox_items (id, type, filed_to, filed_at) VALUES (?1, 'voice', 'audio/memo.m4a', ?2)",
            rusqlite::params![id, filed_at],
        );
        plant(
            &e,
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at) \
             VALUES ('inbox', ?1, ?2, 'plain', 0)",
            rusqlite::params![
                id,
                json!({ "transcription": text, "transcriptionStatus": status }).to_string()
            ],
        );
    }
    let file = read::get_file(&open, &memo).unwrap().expect("a file");
    assert_eq!(file.transcription.as_deref(), Some("buy milk"));
    assert_eq!(
        file.transcription_status,
        Some(TranscriptionStatus::Complete)
    );
    // The platform's separators, as `path.join` gives them (a `/` left in it shows on Windows).
    assert_eq!(
        file.absolute_path,
        e.vault.join("audio").join("memo.m4a").to_string_lossy()
    );

    let scan = file_note(&e, &store, "scan.pdf", "pdf");
    assert_eq!(read::get_file(&open, &scan).unwrap(), None);
}

#[test]
fn a_list_option_the_schema_does_not_name_is_refused() {
    let parse = |options: serde_json::Value| serde_json::from_value::<NoteListOptions>(options);
    assert!(parse(json!({ "sortBy": "title", "sortOrder": "asc", "fields": "tree" })).is_ok());
    assert!(parse(json!({ "sortBy": "size" })).is_err());
    assert!(parse(json!({ "sortOrder": "up" })).is_err());
    assert!(parse(json!({ "fields": "compact" })).is_err());
}
