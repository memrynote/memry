//! A note edited in the app (`notes:update`, #3530 13f-3c) under the running vault tier: a save
//! writes the file and feeds its body with no version of the text the user saw, the `tags:` key
//! changes only when the header tag list does, and the watcher reports none of it back; an
//! outside edit that lands during a save wins and the save is kept as a version.

#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::vault::activity::ActivityFilter;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::note_file::NoteFileError;
use vault_env::{Env, env, indexed};

/// An open vault holding `files`, its first walk done, and the notes service over its tier.
fn opened(files: &[(&str, &str)]) -> (Env, Arc<NotesService>) {
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
    let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
    (e, notes)
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
                    source: ChangeSource::Edit,
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
fn a_save_writes_the_file_and_feeds_the_body_with_no_version_or_echo() {
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
    assert_eq!(
        e.versions(&id),
        Vec::<String>::new(),
        "a save is not a version"
    );
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
        matches!(
            refused,
            Err(NotesError::File(NoteFileError::ChangedUnderWrite))
        ),
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
fn a_save_over_a_file_the_document_never_took_keeps_that_file_first() {
    let (e, notes) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // The row names no text the document holds, as for an outside edit not fed yet.
    e.core().note_files().set_hash(&id, None).unwrap();
    notes.update(&open, save(&id, "The user's save\n")).unwrap();
    assert_eq!(e.versions(&id), [PLAN], "the file's text was lost");
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
