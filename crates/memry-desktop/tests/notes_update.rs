//! A note edited in the app (`notes:update`, #3530 13f-3c) under the running vault tier: a save
//! writes the file and feeds its body, keeping a version only of a file this run did not write,
//! the `tags:` key changes only when the header tag list does, and the watcher reports none of
//! it back; an outside edit that lands during a save wins and the save is kept as a version.

#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use crate::index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::vault::activity::ActivityFilter;
use memry_desktop::vault::app_edit::Kept;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use serde_json::json;
use vault_env::{Env, env, indexed};

/// An open vault holding `files`, its first walk done, and the notes service over its tier.
fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
    let (e, notes, _) = opened_with_store(files);
    (e, notes)
}

/// [`opened`], and the store its notes write with.
fn opened_with_store(files: &[(&str, &str)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

/// The id of the note at `rel`.
fn id_at(e: &Env, rel: &str) -> String {
    e.rows()
        .into_iter()
        .find_map(|(id, path)| (path == rel).then_some(id))
        .expect("a row")
}

fn save(id: &str, content: &str) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        content: Some(content.to_owned()),
        ..NoteUpdateInput::default()
    }
}

fn add_tags(id: &str, tags: &[&str]) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        header_tags: Some(HeaderTagEditInput {
            add: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
            ..HeaderTagEditInput::default()
        }),
        ..NoteUpdateInput::default()
    }
}

/// The facts once the watcher had time to report what the app wrote.
fn quiet_facts(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(vault_env::QUIET);
    e.drain()
}

fn by_watcher(facts: &[Applied]) -> Vec<&Applied> {
    facts
        .iter()
        .filter(|fact| {
            matches!(
                fact,
                Applied::Changed {
                    source: ChangeSource::Watcher,
                    ..
                } | Applied::Added { .. }
            )
        })
        .collect()
}

fn edits(facts: &[Applied]) -> usize {
    facts
        .iter()
        .filter(|fact| {
            matches!(
                fact,
                Applied::Changed {
                    source: ChangeSource::Save,
                    ..
                }
            )
        })
        .count()
}

/// The paths the watcher logged as changed outside the app.
fn activity(e: &Env) -> Vec<String> {
    e.tier
        .activity()
        .list(1000, ActivityFilter::All)
        .entries
        .into_iter()
        .filter_map(|entry| entry.path)
        .collect()
}

fn record_tags(e: &Env, id: &str) -> Vec<String> {
    e.core()
        .note_files()
        .listed_by_id(id)
        .unwrap()
        .expect("the note")
        .tags
}

/// `alpha` is read once: an unchanged list written out would drop it.
const PLAN: &str =
    "---\n# kept as written\nstatus: open\ntags: [Alpha, beta, alpha]\n---\nFirst text\n";

#[test]
fn a_save_writes_the_file_feeds_the_body_and_keeps_only_the_file_it_found() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let updated = notes.update(&open, save(&id, "Second text\n")).unwrap();
    let file =
        "---\n# kept as written\nstatus: open\ntags: [Alpha, beta, alpha]\n---\nSecond text\n";
    assert_eq!(e.read("Plan.md"), file, "the block kept its bytes");
    assert_eq!(updated.note.content, "Second text\n");
    assert!(!updated.tags_changed);
    assert_eq!(e.body(&id), "Second text");
    // The first save of a run cannot tell the file it replaces from an outside edit the editor
    // never showed, so it keeps it, as the write-back does.
    assert_eq!(e.versions(&id), [PLAN]);
    let row = e.core().note_files().by_id(&id).unwrap().unwrap();
    let hash = Some(content_hash(file));
    assert_eq!((row.content_hash, row.file_hash), (hash.clone(), hash));
    let facts = quiet_facts(&mut e);
    assert_eq!(edits(&facts), 1, "{facts:?}");
    assert_eq!(by_watcher(&facts), Vec::<&Applied>::new());
    assert_eq!(
        activity(&e),
        Vec::<String>::new(),
        "the watcher took the save for an outside edit"
    );

    // The same text again is no write and no event.
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    assert_eq!(e.read("Plan.md"), file);
    assert_eq!(edits(&quiet_facts(&mut e)), 0);

    // A save over the run's own save keeps no version of it.
    notes.update(&open, save(&id, "Third text\n")).unwrap();
    assert_eq!(e.body(&id), "Third text");
    assert_eq!(e.versions(&id), [PLAN], "a save is not a version");
}

#[test]
fn the_tags_key_is_written_only_when_the_header_list_changes() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // `alpha` folds to a tag the list holds: the list and its spelling stay.
    let same = notes.update(&open, add_tags(&id, &["alpha"])).unwrap();
    assert!(!same.tags_changed);
    assert_eq!(e.read("Plan.md"), PLAN);
    assert_eq!(edits(&quiet_facts(&mut e)), 0, "nothing changed");

    let added = notes.update(&open, add_tags(&id, &["gamma"])).unwrap();
    assert!(added.tags_changed);
    assert_eq!(
        e.read("Plan.md"),
        "---\n# kept as written\nstatus: open\ntags:\n  - Alpha\n  - beta\n  - gamma\n---\nFirst text\n",
        "only the tags key was rewritten"
    );
    assert_eq!(added.note.header_tags, ["Alpha", "beta", "gamma"]);
    assert_eq!(record_tags(&e, &id), ["Alpha", "beta", "gamma"]);
    assert_eq!(e.body(&id), "First text", "a tag edit moves no body");
    let facts = quiet_facts(&mut e);
    assert_eq!(edits(&facts), 1, "{facts:?}");
    assert_eq!(by_watcher(&facts), Vec::<&Applied>::new());
    assert_eq!(activity(&e), Vec::<String>::new());
}

#[test]
fn a_plain_tag_typed_into_the_body_joins_the_header() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let updated = notes
        .update(&open, save(&id, "First text #idea\n"))
        .unwrap();
    assert!(updated.tags_changed);
    assert_eq!(updated.note.header_tags, ["Alpha", "beta", "idea"]);
    assert!(
        e.read("Plan.md").contains("  - idea\n"),
        "{}",
        e.read("Plan.md")
    );
}

#[test]
fn an_outside_edit_that_lands_during_a_save_wins_and_the_save_is_kept() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let outside = "---\nstatus: open\n---\nFrom another editor\n";
    let vault = e.vault.clone();
    let refused = notes.update_checked(&open, save(&id, "The user's save\n"), &mut || {
        std::fs::write(vault.join("Plan.md"), outside).unwrap();
    });
    assert!(
        matches!(refused, Err(NotesError::EditKept(Kept::FileChanged))),
        "{refused:?}"
    );
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    });
    assert_eq!(
        e.read("Plan.md"),
        outside,
        "the outside edit was written over"
    );
    assert_eq!(e.body(&id), "From another editor");
    let versions = e.versions(&id);
    assert!(
        versions.iter().any(|v| v.contains("The user's save")),
        "the save was lost: {versions:?}"
    );
}

#[test]
fn a_refused_save_leaves_the_record_as_the_file_says() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let tags = record_tags(&e, &id);
    // The outside edit keeps the header, which its record then takes (#3825); only the refused
    // save could add `gamma` or the icon.
    let outside = PLAN.replace("First text", "From another editor");
    let vault = e.vault.clone();
    let input = NoteUpdateInput {
        emoji: Some(Some("🌱".to_owned())),
        ..add_tags(&id, &["gamma"])
    };
    let refused = notes.update_checked(&open, input, &mut || {
        std::fs::write(vault.join("Plan.md"), &outside).unwrap();
    });
    assert!(refused.is_err(), "{refused:?}");
    let listed = |e: &Env| e.core().note_files().listed_by_id(&id).unwrap().unwrap();
    assert_eq!((listed(&e).tags, listed(&e).emoji), (tags.clone(), None));
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    });
    assert_eq!(e.read("Plan.md"), outside);
    assert_eq!(
        (listed(&e).tags, listed(&e).emoji),
        (vec!["Alpha".to_owned(), "beta".to_owned()], None)
    );
}

#[test]
fn a_save_after_an_outside_edit_the_editor_never_showed_keeps_that_edit() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    let outside = "---\nstatus: open\n---\nFrom another editor\n";
    let vault = e.vault.clone();
    let refused = notes.update_checked(&open, save(&id, "The user's next save\n"), &mut || {
        std::fs::write(vault.join("Plan.md"), outside).unwrap();
    });
    assert!(refused.is_err(), "{refused:?}");
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    });
    assert_eq!(e.body(&id), "From another editor");
    // The editor still shows the user's text and saves it again.
    notes
        .update(&open, save(&id, "The user's next save, again\n"))
        .unwrap();
    assert_eq!(e.body(&id), "The user's next save, again");
    assert!(
        e.versions(&id).iter().any(|v| v == outside),
        "the outside edit was lost: {:?}",
        e.versions(&id)
    );
}

/// A save, then an outside edit the watcher feeds, then `between` (an edit with no body), then
/// the editor's save of the text it still shows: the outside edit must be kept as a version.
fn outside_edit_kept_across(between: impl FnOnce(&str) -> NoteUpdateInput) {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    std::fs::write(
        e.vault.join("Plan.md"),
        "---\nstatus: open\n---\nFrom another editor\n",
    )
    .unwrap();
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    });
    assert_eq!(e.body(&id), "From another editor");
    notes.update(&open, between(&id)).unwrap();
    notes
        .update(&open, save(&id, "The user's save, again\n"))
        .unwrap();
    assert_eq!(e.body(&id), "The user's save, again");
    assert!(
        e.versions(&id)
            .iter()
            .any(|v| v.contains("From another editor")),
        "the outside edit was lost: {:?}",
        e.versions(&id)
    );
}

#[test]
fn a_tag_edit_after_an_outside_edit_leaves_that_edit_to_be_kept_by_the_next_save() {
    outside_edit_kept_across(|id| add_tags(id, &["gamma"]));
}

#[test]
fn an_icon_change_after_an_outside_edit_leaves_that_edit_to_be_kept_by_the_next_save() {
    outside_edit_kept_across(|id| NoteUpdateInput {
        id: id.to_owned(),
        emoji: Some(Some("🌱".to_owned())),
        ..NoteUpdateInput::default()
    });
}

#[test]
fn a_tag_edit_between_two_saves_keeps_the_file_the_run_wrote() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    notes.update(&open, add_tags(&id, &["gamma"])).unwrap();
    notes
        .update(&open, save(&id, "The user's next save\n"))
        .unwrap();
    assert_eq!(
        e.versions(&id),
        [PLAN],
        "a save over the run's own file kept a version"
    );
}

/// Waits for the watcher to feed the outside edit of `rel`.
fn fed_by_watcher(e: &mut Env) {
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    });
}

const OUTSIDE: &str = "---\nstatus: open\n---\nFrom another editor\n";

#[test]
fn a_save_over_an_outside_edit_the_watcher_fed_keeps_that_edit() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    std::fs::write(e.vault.join("Plan.md"), OUTSIDE).unwrap();
    fed_by_watcher(&mut e);
    assert_eq!(e.body(&id), "From another editor");
    // The editor never showed it and saves what it still holds.
    notes
        .update(&open, save(&id, "The user's save, again\n"))
        .unwrap();
    assert!(
        e.versions(&id).iter().any(|v| v == OUTSIDE),
        "the outside edit was lost: {:?}",
        e.versions(&id)
    );
}

/// The editor learns of an outside edit the watcher fed from its event; of one the save reached
/// first, only from the save that replaced it.
#[test]
fn a_save_says_when_it_replaced_an_outside_edit_not_fed_yet() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // The run's first save keeps the file it found, which the editor showed.
    let first = notes.update(&open, save(&id, "The user's save\n")).unwrap();
    assert!(!first.kept_outside_edit);
    // No wait for the watcher: the save lands on a file its row does not name.
    std::fs::write(e.vault.join("Plan.md"), OUTSIDE).unwrap();
    let over = notes.update(&open, save(&id, "Typed over it\n")).unwrap();
    assert!(over.kept_outside_edit);
    assert!(e.versions(&id).iter().any(|v| v == OUTSIDE));
    let next = notes.update(&open, save(&id, "Typed again\n")).unwrap();
    assert!(!next.kept_outside_edit, "a save over the run's own file");

    quiet_facts(&mut e);
    std::fs::write(
        e.vault.join("Plan.md"),
        OUTSIDE.replace("another", "a third"),
    )
    .unwrap();
    fed_by_watcher(&mut e);
    let fed = notes.update(&open, save(&id, "Typed after it\n")).unwrap();
    assert!(
        !fed.kept_outside_edit,
        "the editor had the fed edit's event"
    );
}

#[test]
fn a_tag_edit_while_the_document_is_ahead_leaves_the_document() {
    let (e, notes, store) = opened_with_store(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // An edit in the app the write-back has not written to the file yet.
    e.edit_in_app(&store, &id, "Edited in the app");
    let stamp = |e: &Env| {
        e.core()
            .note_files()
            .by_id(&id)
            .unwrap()
            .unwrap()
            .indexed_at
    };
    let before = stamp(&e);
    notes.update(&open, add_tags(&id, &["gamma"])).unwrap();
    assert_eq!(
        stamp(&e),
        before,
        "a fresh stamp says the file holds the document, so the write-back leaves it behind"
    );
    assert!(
        e.read("Plan.md").contains("  - gamma\n"),
        "{}",
        e.read("Plan.md")
    );
    assert_eq!(
        e.body(&id),
        "Edited in the app",
        "the file's old body went over the document"
    );
}

#[test]
fn a_tag_edit_over_an_outside_edit_not_fed_yet_is_not_the_runs_own_file() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    // No wait for the watcher: the tag edit lands on a file its row does not name.
    std::fs::write(e.vault.join("Plan.md"), OUTSIDE).unwrap();
    notes.update(&open, add_tags(&id, &["gamma"])).unwrap();
    // Once the watcher brought the tagged file in, only the mark tells it from the run's own.
    until("the row to name the tagged file", || {
        let row = e.core().note_files().by_id(&id).unwrap().unwrap();
        row.content_hash == Some(content_hash(&e.read("Plan.md")))
    });
    assert_eq!(e.body(&id), "From another editor");
    notes
        .update(&open, save(&id, "The user's save, again\n"))
        .unwrap();
    assert!(
        e.versions(&id)
            .iter()
            .any(|v| v.contains("From another editor")),
        "the outside edit was lost: {:?}",
        e.versions(&id)
    );
}

#[test]
fn a_save_over_the_runs_own_file_its_row_does_not_name_keeps_it() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    let saved = e.read("Plan.md");
    // The document holds the file, but the row no longer says so.
    e.core().note_files().set_hash(&id, None).unwrap();
    notes.update(&open, save(&id, "The next save\n")).unwrap();
    assert!(
        e.versions(&id).contains(&saved),
        "a file the row does not name was replaced with no version: {:?}",
        e.versions(&id)
    );
}

#[test]
fn the_saves_of_a_new_note_keep_no_version_of_the_file_its_create_wrote() {
    let (e, notes) = opened(&[]);
    let open = e.session.current().unwrap();
    let note = notes
        .create(
            &open,
            NewNoteFile {
                title: "Plan".into(),
                ..NewNoteFile::default()
            },
        )
        .unwrap();
    notes.update(&open, save(&note.id, "First text\n")).unwrap();
    notes
        .update(&open, save(&note.id, "Second text\n"))
        .unwrap();
    assert_eq!(e.body(&note.id), "Second text");
    assert_eq!(e.versions(&note.id), Vec::<String>::new());
}

#[test]
fn a_tag_with_fields_typed_into_the_body_changes_the_tags_and_not_the_header() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let record = InboundRecord {
        item_type: "tag_definition".to_owned(),
        item_id: "person".to_owned(),
        payload_json: json!({
            "name": "person", "color": "blue", "schema": { "t": 1, "fields": [{ "name": "role" }] }
        })
        .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1_760_000_000_000,
        deleted_at: None,
    };
    e.core()
        .db_handle()
        .call_blocking(move |data| sync_items::apply_remote(data, &record, 1_760_000_000_000))
        .unwrap();
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let updated = notes
        .update(&open, save(&id, "First text #person\n"))
        .unwrap();
    assert!(updated.tags_changed);
    assert_eq!(updated.note.header_tags, ["Alpha", "beta"]);
    assert!(e.read("Plan.md").contains("tags: [Alpha, beta, alpha]\n"));
}

#[test]
fn a_tag_edit_of_a_marked_file_with_no_frontmatter_keeps_one_mark() {
    let (e, notes) = opened(&[("Plan.md", "\u{feff}First text\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, add_tags(&id, &["gamma"])).unwrap();
    let file = e.read("Plan.md");
    assert_eq!(file.matches('\u{feff}').count(), 1, "{file:?}");
    assert!(file.starts_with("\u{feff}---\n"), "{file:?}");
    assert!(file.ends_with("---\nFirst text\n"), "{file:?}");
}

/// The body a save reports is the one the note's read (and its event) gives: a marked file with
/// no frontmatter keeps the mark in its body (#3967).
#[test]
fn a_save_of_a_marked_file_with_no_frontmatter_reports_the_body_as_read() {
    let (e, notes) = opened(&[("Plan.md", "\u{feff}First text\n")]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let updated = notes.update(&open, save(&id, "Typed text\n")).unwrap();
    assert_eq!(e.read("Plan.md"), "\u{feff}Typed text\n");
    assert_eq!(
        updated.saved_content.as_deref(),
        Some(updated.note.content.as_str())
    );
}

/// The two texts a guess at where the seam puts the mark back got wrong: a save that changes
/// nothing on a marked file, and typing that starts with a mark on a file without one.
#[test]
fn a_save_reports_the_mark_where_the_file_has_it() {
    let (e, notes) = opened(&[
        ("Marked.md", "\u{feff}First text\n"),
        ("Plain.md", "Plain\n"),
    ]);
    let open = e.session.current().unwrap();
    let (marked, plain) = (id_at(&e, "Marked.md"), id_at(&e, "Plain.md"));

    let same = notes.update(&open, save(&marked, "First text\n")).unwrap();
    assert_eq!(e.read("Marked.md"), "\u{feff}First text\n");
    assert_eq!(
        same.saved_content.as_deref(),
        Some(same.note.content.as_str())
    );

    let typed = notes
        .update(&open, save(&plain, "\u{feff}Typed\n"))
        .unwrap();
    assert_eq!(
        typed.saved_content.as_deref(),
        Some(typed.note.content.as_str())
    );
}

#[test]
fn a_save_over_a_file_the_document_never_took_keeps_that_file_first() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // The row names no text the document holds, as for an outside edit not fed yet.
    e.core().note_files().set_hash(&id, None).unwrap();
    let saved = notes.update(&open, save(&id, "The user's save\n")).unwrap();
    assert_eq!(e.versions(&id), [PLAN], "the file's text was lost");
    // A row with no hash is no outside edit: nothing changed the file.
    assert!(!saved.kept_outside_edit);
    assert_eq!(e.body(&id), "The user's save");
}

#[test]
fn an_icon_is_the_records_alone() {
    let (mut e, notes) = opened(&[]);
    let open = e.session.current().unwrap();
    let note = notes
        .create(
            &open,
            NewNoteFile {
                title: "Plan".into(),
                content: "Hello".into(),
                ..NewNoteFile::default()
            },
        )
        .unwrap();
    let file = e.read(&note.path);
    e.drain();
    let icon = |emoji: Option<&str>| NoteUpdateInput {
        id: note.id.clone(),
        emoji: Some(emoji.map(str::to_owned)),
        ..NoteUpdateInput::default()
    };
    let set = notes.update(&open, icon(Some("🌱"))).unwrap();
    assert_eq!(set.note.emoji.as_deref(), Some("🌱"));
    assert_eq!(e.read(&note.path), file);
    assert_eq!(edits(&quiet_facts(&mut e)), 1);
    let cleared = notes.update(&open, icon(None)).unwrap();
    assert_eq!(cleared.note.emoji, None);
    // An absent icon leaves it.
    notes.update(&open, icon(Some("🌱"))).unwrap();
    let kept = notes.update(&open, save(&note.id, "Hello again")).unwrap();
    assert_eq!(kept.note.emoji.as_deref(), Some("🌱"));
}

/// A save whose feed the document did not take writes the file and leaves it to the watcher to
/// bring in. The watcher's report of those bytes, the app's own, is the app's fact: a watcher
/// one sends an outside edit, on which the editor drops what was typed since the save.
#[test]
fn a_save_the_watcher_brings_in_keeps_the_saves_source() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.fail_next_save_feed();
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    until("the watcher fed the save", || e.body(&id) == "Second text");
    let facts = quiet_facts(&mut e);
    assert_eq!(by_watcher(&facts), Vec::<&Applied>::new(), "{facts:?}");
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed { note_id, source: ChangeSource::Save, .. } if *note_id == id
        )),
        "the save's own source, so the note's views refresh: {facts:?}"
    );
}

/// A file the app wrote is its own only until an outside edit replaces it: the same bytes
/// written back later (a stash pop, an undo elsewhere) are an outside edit the editor shows,
/// and the next save keeps them as a version.
#[test]
fn bytes_the_app_wrote_put_back_outside_are_an_outside_edit() {
    let (mut e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Mine\n")).unwrap();
    let mine = e.read("Plan.md");
    quiet_facts(&mut e);

    e.write("Plan.md", &mine.replace("Mine", "Theirs"));
    until("the outside edit was fed", || e.body(&id) == "Theirs");
    e.write("Plan.md", &mine);
    until("the put-back was fed", || e.body(&id) == "Mine");
    let facts = quiet_facts(&mut e);
    assert_eq!(by_watcher(&facts).len(), 2, "{facts:?}");

    notes.update(&open, save(&id, "Next\n")).unwrap();
    assert!(
        e.versions(&id).contains(&mine),
        "the put-back file is kept before the save replaces it"
    );
}
