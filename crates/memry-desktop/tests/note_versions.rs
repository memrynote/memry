//! A note's version history (Step 14d, Electron `notes-versions.ts`) over a real session, tier,
//! watcher, `data.db` and vault files: a restore replaces the body, keeps the text it replaced
//! as the newest version (the file's, and the document's when it is ahead), reaches an open
//! editor as an outside edit and leaves the frontmatter; a locked note or an unknown version
//! changes nothing; a delete takes one version alone; the quit keeps a close version of every
//! open note.

use std::sync::{Arc, Mutex};

use memry_core::api::editor::{Notice, Origin};
use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::editor::versions;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::vault::app_edit::Kept;

use crate::notes_link_rewrite::{id_at, opened};
use crate::vault_env::Env;

const PLAN: &str = "---\nstatus: open\n---\nFirst text\n";

fn save(id: &str, content: &str) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        content: Some(content.to_owned()),
        ..NoteUpdateInput::default()
    }
}

/// The note's versions as the panel lists them, newest first: `(id, file)`.
fn listed(e: &Env, id: &str) -> Vec<(String, String)> {
    let open = e.session.current().unwrap();
    versions::list(&open, id)
        .unwrap()
        .into_iter()
        .map(|view| {
            let detail = versions::get(&open, &view.id).unwrap().expect("listed");
            (view.id, detail.file_content)
        })
        .collect()
}

fn files(e: &Env, id: &str) -> Vec<String> {
    listed(e, id).into_iter().map(|(_, file)| file).collect()
}

#[test]
fn a_restore_replaces_the_body_and_keeps_the_text_it_replaced_as_the_newest_version() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    // The first save keeps the file it found; the second is the run's own and keeps none.
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    notes.update(&open, save(&id, "Third text\n")).unwrap();
    let tags = HeaderTagEditInput {
        add: Some(vec!["later".to_owned()]),
        ..HeaderTagEditInput::default()
    };
    let tagged = NoteUpdateInput {
        id: id.clone(),
        header_tags: Some(tags),
        ..NoteUpdateInput::default()
    };
    notes.update(&open, tagged).unwrap();
    let current = e.read("Plan.md");
    assert_eq!(
        current,
        "---\nstatus: open\ntags:\n  - later\n---\nThird text\n"
    );
    let [(first, file)] = listed(&e, &id).try_into().unwrap();
    assert_eq!(file, PLAN);

    let restored = versions::restore(&notes, &open, &first).unwrap();
    // The body is the version's; the frontmatter is the file's, which its records follow.
    let file = "---\nstatus: open\ntags:\n  - later\n---\nFirst text\n";
    assert_eq!(e.read("Plan.md"), file);
    assert_eq!(e.body(&id), "First text");
    assert_eq!(
        restored.note.map(|note| note.content),
        Some("First text\n".to_owned())
    );
    assert!(!restored.tags_changed);
    // The run's own save, which a save would not keep, is the newest version.
    assert_eq!(files(&e, &id), [current.as_str(), PLAN]);

    // Restoring the text the note holds keeps it again as the newest, as Electron forces it.
    let [(back, _), _] = listed(&e, &id).try_into().unwrap();
    versions::restore(&notes, &open, &back).unwrap();
    assert_eq!(e.read("Plan.md"), current);
    assert_eq!(files(&e, &id), [file, current.as_str(), PLAN]);
}

#[test]
fn a_restore_keeps_the_text_typed_but_not_written_to_the_file_yet() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    // Typed in the editor; the write-back has not written it.
    e.edit_in_app(&store, &id, "Typed, not written");
    assert_eq!(e.read("Plan.md"), "---\nstatus: open\n---\nSecond text\n");

    let first = listed(&e, &id)[0].0.clone();
    versions::restore(&notes, &open, &first).unwrap();
    assert_eq!(e.body(&id), "First text");
    let kept = files(&e, &id);
    assert!(
        kept.iter().any(|file| file.contains("Typed, not written")),
        "the typed text was lost: {kept:?}"
    );
    assert!(
        kept.iter().any(|file| file.contains("Second text")),
        "{kept:?}"
    );
}

#[test]
fn an_open_editor_hears_the_restore_as_an_outside_edit() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    let editor = open.vault.editor(store).unwrap();
    editor.open(&id, "main").unwrap();
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = {
        let heard = heard.clone();
        move |notice: Notice<'_>| {
            if let Notice::Update(_, origin) = notice {
                heard.lock().unwrap().push(origin.kind().to_owned());
            }
        }
    };
    editor.subscribe(&id, listener);

    let first = listed(&e, &id)[0].0.clone();
    versions::restore(&notes, &open, &first).unwrap();
    assert_eq!(*heard.lock().unwrap(), [Origin::External.kind()]);
}

#[test]
fn a_locked_note_or_an_unknown_version_is_not_restored_and_nothing_changes() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    let before = (e.read("Plan.md"), files(&e, &id));
    let first = listed(&e, &id)[0].0.clone();

    let unknown = versions::restore(&notes, &open, "no-such-version").unwrap_err();
    assert!(matches!(unknown, NotesError::NotFound(_)), "{unknown:?}");
    e.core().locks().set(TargetKind::Note, &id, true).unwrap();
    let locked = versions::restore(&notes, &open, &first).unwrap_err();
    assert!(
        matches!(locked, NotesError::EditKept(Kept::Locked)),
        "{locked:?}"
    );

    assert_eq!((e.read("Plan.md"), files(&e, &id)), before);
    assert_eq!(e.body(&id), "Second text");
}

#[test]
fn a_delete_takes_that_version_alone_and_leaves_the_note() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN), ("Other.md", PLAN)]);
    let open = e.session.current().unwrap();
    let (id, other) = (id_at(&e, "Plan.md"), id_at(&e, "Other.md"));
    for (note, text) in [(&id, "Second text\n"), (&other, "Elsewhere\n")] {
        notes.update(&open, save(note, text)).unwrap();
    }
    let first = listed(&e, &id)[0].0.clone();
    versions::restore(&notes, &open, &first).unwrap();
    let file = e.read("Plan.md");
    let [(newest, _), (oldest, _)] = listed(&e, &id).try_into().unwrap();

    assert!(versions::delete(&open, &newest).unwrap());
    assert!(!versions::delete(&open, &newest).unwrap());
    assert_eq!(versions::get(&open, &newest).unwrap(), None);
    assert_eq!(
        listed(&e, &id)
            .into_iter()
            .map(|(v, _)| v)
            .collect::<Vec<_>>(),
        [oldest]
    );
    assert_eq!(files(&e, &other), [PLAN]);
    assert_eq!(e.read("Plan.md"), file);
    assert_eq!(e.body(&id), "First text");
}

#[test]
fn the_quit_keeps_the_file_of_every_open_note_once() {
    let (e, _notes, store) = opened(&[("Plan.md", PLAN), ("Closed.md", PLAN)]);
    let open = e.session.current().unwrap();
    let (id, closed) = (id_at(&e, "Plan.md"), id_at(&e, "Closed.md"));
    open.vault
        .editor(store.clone())
        .unwrap()
        .open(&id, "main")
        .unwrap();

    assert_eq!(versions::keep_close_versions(&open, store.clone()), Ok(1));
    assert_eq!(versions::keep_close_versions(&open, store), Ok(0));
    let listed = versions::list(&open, &id).unwrap();
    let reasons: Vec<_> = listed.iter().map(|view| view.reason.as_str()).collect();
    assert_eq!(reasons, ["close"]);
    assert_eq!(files(&e, &id), [PLAN]);
    assert_eq!(files(&e, &closed), Vec::<String>::new());
}

#[test]
fn a_save_over_the_runs_own_file_keeps_it_when_ten_words_move() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    notes
        .update(&open, save(&id, "Second text, two more\n"))
        .unwrap();
    assert_eq!(files(&e, &id), [PLAN], "nine words or fewer keep none");

    let own = e.read("Plan.md");
    let longer = "Second text, two more, then one two three four five six seven eight nine ten\n";
    notes.update(&open, save(&id, longer)).unwrap();
    assert_eq!(files(&e, &id), [own.as_str(), PLAN]);
}
