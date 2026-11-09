//! A note's version history (Step 14d, Electron `notes-versions.ts`) over a real session, tier,
//! watcher, `data.db` and vault files: a restore replaces the body, keeps the text it replaced
//! as the newest version (the file's, and the document's when it is ahead), reaches an open
//! editor as an outside edit and leaves the frontmatter; a locked note or an unknown version
//! changes nothing; a delete takes one version alone; the quit keeps a close version of every
//! open note.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::editor::{Notice, Origin};
use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::editor::versions;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::shell::shutdown::{ShutdownCore, ShutdownEffects, ShutdownReason, StepFn};
use memry_desktop::telemetry::crash::ShutdownFailure;
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

/// The note's versions as the panel lists them, newest first: `(id, file kept)`.
fn listed(e: &Env, id: &str) -> Vec<(String, String)> {
    let open = e.session.current().unwrap();
    versions::list(&open, id)
        .unwrap()
        .into_iter()
        .map(|view| {
            let kept = open
                .vault
                .versions()
                .get(&view.id)
                .unwrap()
                .expect("listed");
            (view.id, kept.content)
        })
        .collect()
}

/// Keeps `file` as a version of `id`, as an outside edit would.
fn keep(e: &Env, id: &str, file: &str) -> String {
    let core = e.core();
    assert!(core.write_back().keep_replaced(id, file, file).unwrap());
    listed(e, id)[0].0.clone()
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
fn a_save_over_an_outside_edit_the_editor_never_showed_keeps_it_however_small() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    // Another editor's save of the note: the run's own, under ten words, so no version.
    notes.update(&open, save(&id, "Third text\n")).unwrap();
    assert_eq!(files(&e, &id), [PLAN]);

    // The editor that held that save off writes its typing over it (#4088).
    let over = NoteUpdateInput {
        keep_replaced: true,
        ..save(&id, "Second text, typed on\n")
    };
    notes.update(&open, over).unwrap();
    assert_eq!(e.body(&id), "Second text, typed on");
    let third = "---\nstatus: open\n---\nThird text\n";
    assert_eq!(files(&e, &id), [third, PLAN]);
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

/// The app's own write, not an outside edit: a rule for outside edits (typing wins over them)
/// leaves a restore alone.
#[test]
fn an_open_editor_hears_the_restore_as_the_apps_own_write() {
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
    assert_eq!(*heard.lock().unwrap(), [Origin::System.kind()]);
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

    assert_eq!(versions::keep_close_versions(&open), 1);
    assert_eq!(versions::keep_close_versions(&open), 0);
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

#[derive(Default)]
struct Quit {
    exits: Mutex<Vec<&'static str>>,
    failures: Mutex<Vec<Option<String>>>,
}

impl ShutdownEffects for Quit {
    fn step_started(&self, _: &str) {}
    fn mark_failure(&self, _: ShutdownFailure, step: Option<&str>) {
        self.failures.lock().unwrap().push(step.map(str::to_owned));
    }
    fn clear_marker(&self) {}
    fn exit_clean(&self) {
        self.exits.lock().unwrap().push("exit_clean");
    }
    fn terminate(&self) {
        self.exits.lock().unwrap().push("terminate");
    }
}

/// The vault's quit steps as the shell registers them (`VaultTier::quit_steps`), and a
/// `stop-sync-runtime` that says what was left of the quit when it ran (`None`: it never ran);
/// what the quit came to.
async fn quit(e: &Env, reason: ShutdownReason) -> (Arc<Quit>, Option<Duration>) {
    let core = Arc::new(ShutdownCore::default());
    for (name, step) in e.tier.quit_steps(&e.session) {
        core.registry.register(name, step).unwrap();
    }
    let stopped = Arc::new(Mutex::new(None));
    let stop_sync: StepFn = {
        let stopped = stopped.clone();
        Arc::new(move |_, deadline| {
            *stopped.lock().unwrap() = Some(deadline.remaining());
            Box::pin(async { Ok(()) })
        })
    };
    core.registry
        .register("stop-sync-runtime", stop_sync)
        .unwrap();
    let quit = Arc::new(Quit::default());
    let effects: Arc<dyn ShutdownEffects> = quit.clone();
    core.run(reason, &effects).await;
    let stopped = *stopped.lock().unwrap();
    (quit, stopped)
}

/// No editor was built this launch (a locked keychain refuses the device identity it reads):
/// the quit builds none, keeps nothing and goes on to stop sync.
#[tokio::test(flavor = "multi_thread")]
async fn the_quit_reads_no_keychain_for_close_versions_and_runs_every_step() {
    let (e, _notes, _) = opened(&[("Plan.md", PLAN)]);
    let id = id_at(&e, "Plan.md");
    let (quit, stopped) = quit(&e, ShutdownReason::Quit).await;
    assert!(stopped.is_some(), "stop-sync-runtime never ran");
    assert_eq!(*quit.exits.lock().unwrap(), ["exit_clean"]);
    assert_eq!(*quit.failures.lock().unwrap(), Vec::<Option<String>>::new());
    let open = e.session.current().unwrap();
    assert!(
        open.vault.built_editor().is_none(),
        "the quit built the editor"
    );
    assert_eq!(files(&e, &id), Vec::<String>::new());
}

/// With a note open, the quit's `close-snapshots` keeps it, and the steps behind it run.
#[tokio::test(flavor = "multi_thread")]
async fn the_quit_keeps_a_close_version_of_the_open_note() {
    let (e, _notes, store) = opened(&[("Plan.md", PLAN)]);
    let id = id_at(&e, "Plan.md");
    let open = e.session.current().unwrap();
    open.vault.editor(store).unwrap().open(&id, "main").unwrap();
    let (quit, stopped) = quit(&e, ShutdownReason::Quit).await;
    assert!(stopped.is_some());
    assert_eq!(*quit.exits.lock().unwrap(), ["exit_clean"]);
    assert_eq!(files(&e, &id), [PLAN]);
}

/// The version says what the file says, and the document is ahead of both (typed, not
/// written): the restore still puts the version's body in the document, and keeps the typed
/// text.
#[test]
fn a_restore_of_the_files_own_text_still_reaches_a_document_that_is_ahead() {
    let (e, notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    notes.update(&open, save(&id, "Second text\n")).unwrap();
    let current = keep(&e, &id, &e.read("Plan.md"));
    e.edit_in_app(&store, &id, "Typed, not written");

    versions::restore(&notes, &open, &current).unwrap();
    assert_eq!(e.body(&id), "Second text");
    assert_eq!(e.read("Plan.md"), "---\nstatus: open\n---\nSecond text\n");
    let kept = files(&e, &id);
    assert!(
        kept.iter().any(|file| file.contains("Typed, not written")),
        "the typed text was lost: {kept:?}"
    );
}

/// A version whose file began with a byte order mark and had no frontmatter: the mark stays out
/// of the restored body and of the preview.
#[test]
fn a_restore_leaves_a_versions_byte_order_mark_out_of_the_body() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let old = keep(&e, &id, "\u{feff}Old body\n");

    assert_eq!(
        versions::get(&open, &old).unwrap().map(|v| v.file_content),
        Some("Old body\n".to_owned()),
        "the preview is the body a restore writes"
    );
    versions::restore(&notes, &open, &old).unwrap();
    assert_eq!(e.read("Plan.md"), "---\nstatus: open\n---\nOld body\n");
}

/// The preview is the body a restore writes, not the version's old frontmatter.
#[test]
fn the_preview_shows_the_body_a_restore_writes() {
    let (e, _notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let old = keep(&e, &id, "---\nstatus: closed\n---\nOld body\n");
    let detail = versions::get(&open, &old).unwrap().expect("kept");
    assert_eq!(detail.file_content, "Old body\n");
}

/// Restoring the oldest of fifty versions keeps the text it replaced; the restored version's
/// row is the one pruned, its text now in the note.
#[test]
fn restoring_the_oldest_of_fifty_versions_keeps_what_it_replaced() {
    let (e, notes, _) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    let oldest = keep(&e, &id, "Oldest body\n");
    for n in 1..50 {
        std::thread::sleep(std::time::Duration::from_millis(2));
        keep(&e, &id, &format!("Body {n}\n"));
    }
    assert_eq!(listed(&e, &id).len(), 50);

    versions::restore(&notes, &open, &oldest).unwrap();
    assert_eq!(e.read("Plan.md"), "---\nstatus: open\n---\nOldest body\n");
    let kept = files(&e, &id);
    assert_eq!(kept.len(), 50);
    assert_eq!(kept[0], PLAN, "the replaced text is the newest version");
}

/// A close step stuck on a busy database takes its share of the quit, not all of it: the
/// steps behind it (the sync runtime's stop and its final push) still run, in a session end's
/// short budget too.
#[tokio::test(flavor = "multi_thread")]
async fn a_slow_close_step_leaves_the_steps_behind_it_their_time() {
    let (e, _notes, store) = opened(&[("Plan.md", PLAN)]);
    let id = id_at(&e, "Plan.md");
    let open = e.session.current().unwrap();
    open.vault.editor(store).unwrap().open(&id, "main").unwrap();
    let (held, release) = std::sync::mpsc::channel::<()>();
    let db = open.vault.db_handle();
    let holder = std::thread::spawn(move || {
        db.call_blocking(move |_| {
            held.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(5));
            Ok(())
        })
        .unwrap();
    });
    release.recv().unwrap();

    let (quit, stopped) = quit(&e, ShutdownReason::SessionEnd).await;
    let left = stopped.expect("stop-sync-runtime never ran");
    assert!(
        left >= Duration::from_secs(1),
        "stop-sync-runtime had {left:?}"
    );
    assert_eq!(*quit.exits.lock().unwrap(), ["exit_clean"]);
    holder.join().unwrap();
}

/// Only a markdown note's file is kept at quit.
#[test]
fn the_quit_keeps_no_close_version_of_a_file_that_is_not_markdown() {
    let (e, _notes, store) = opened(&[("Plan.md", PLAN)]);
    let open = e.session.current().unwrap();
    let id = id_at(&e, "Plan.md");
    open.vault.editor(store).unwrap().open(&id, "main").unwrap();
    let row = open.vault.note_files().by_id(&id).unwrap().unwrap();
    open.vault
        .note_files()
        .upsert_stat(memry_core::domain::note_files::NoteFileStat {
            note_id: id.clone(),
            path: row.path,
            file_type: "pdf".to_owned(),
            mime_type: None,
            file_size: row.file_size,
            content_hash: row.content_hash,
            file_hash: row.file_hash,
            indexed_at: 1,
        })
        .unwrap();

    assert_eq!(versions::keep_close_versions(&open), 0);
    assert_eq!(files(&e, &id), Vec::<String>::new());
}
