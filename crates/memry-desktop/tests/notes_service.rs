//! The app's note reads (Step 13f, #3530) over a vault the running tier adopted: a note's text
//! comes from its file, read bounded and classified by size before the editor gets it; a list
//! is the records and their rows in one query.

mod device_key;
mod vault_env;

use std::sync::Arc;

use memry_core::domain::note_files::NoteFileStat;
use memry_core::markdown::shared::markdown_class::{NOTE_MAX_BLOCK_BYTES, NOTE_MAX_BYTES};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::view::{
    AttachedFileType, LargeFileReasonView, NoteListOptions, SizeClass,
};
use memry_desktop::session::OpenVault;
use serde_json::json;
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\ntags:\n  - alpha\nstatus: open\naliases: Plan B\n---\nHello world\n";

/// A vault of a note in a folder and one at the root, opened and walked; the identity makes
/// both notes.
fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write("work/Plan.md", PLAN);
    e.write("Loose.md", "Just text\n");
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    (e, open, kept.expect("the store"))
}

fn id_of(open: &OpenVault, path: &str) -> String {
    read::get_by_path(open, path).unwrap().expect(path).id
}

#[test]
fn a_note_reads_its_text_and_fields_from_its_file() {
    let (_e, open, _) = opened();
    let note = read::get_by_path(&open, "work/Plan.md").unwrap().unwrap();
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
    assert_eq!(read::get(&open, &note.id).unwrap(), Some(note));
    assert_eq!(read::get(&open, "no-such-note").unwrap(), None);
    assert_eq!(read::get_by_path(&open, "work/Gone.md").unwrap(), None);
}

#[test]
fn a_frontmatter_that_does_not_parse_costs_the_note_no_body() {
    let (e, open, _) = opened();
    e.write("Loose.md", "---\ntags: [unclosed\n---\nStill here\n");
    let note = read::get_by_path(&open, "Loose.md").unwrap().unwrap();
    assert_eq!(note.content, "Still here\n");
    assert!(note.frontmatter.is_empty() && note.header_tags.is_empty());
}

#[test]
fn a_note_past_the_size_class_reads_without_its_text() {
    let (e, open, _) = opened();
    // A note grows past the class and stays a note (`notes::identity`); the read goes by the
    // bytes on disk, whatever the watcher made of them yet.
    e.write("Loose.md", &"a".repeat(NOTE_MAX_BLOCK_BYTES + 1));
    let by_block = read::get_by_path(&open, "Loose.md").unwrap().unwrap();
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
    let by_size = read::get_by_path(&open, "Loose.md").unwrap().unwrap();
    let info = by_size.large_file.expect("measured");
    assert_eq!(info.reason, LargeFileReasonView::FileBytes);
    assert_eq!(info.largest_block_bytes, None);
    assert!(by_size.content_omitted);
}

#[test]
fn a_list_pages_the_notes_of_a_folder_and_the_tree_leaves_out_what_it_never_reads() {
    let (_e, open, _) = opened();
    let by_title = NoteListOptions {
        sort_by: Some("title".into()),
        sort_order: Some("asc".into()),
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
            fields: Some("tree".into()),
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
