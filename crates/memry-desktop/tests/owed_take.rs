//! The take of an owed file (#3534 L5, `vault::consumer::tier::owed`) under the running vault
//! tier, its watcher, consumer and write-back: the file's frontmatter reaches the record, a
//! write-back between the body pull and the take keeps the file, an outside edit made while the
//! take holds the lane is fed after it, a marker cleared while the take waited for typing is not
//! taken, and an unchanged refused file is passed over before the typing and the lane.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::seams::secure_store::SecureStore;
use memry_core::sync::body_debt;
use memry_desktop::editor::{BARRIER, EditorHost, Subscriber};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal, Rename,
};
use memry_desktop::vault::consumer::{Taken, VaultTier};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::note_file::NoteFile;

use crate::index_support::until;
use crate::notes_outside_tags::{measured, opened, record_tags};
use crate::vault_env::{Creates, Env, QUIET, WAIT, creates, edit_in_app, env, indexed};

type Hook = Box<dyn FnOnce() -> Result<(), IdentityError> + Send>;
/// What a window runs, once, at its next typing barrier.
type AtBarrier = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

/// [`Creates`], whose `on_changed` runs the hook set last, once, and records each note it heard.
struct Told {
    creates: Arc<Creates>,
    next: Mutex<Option<Hook>>,
    heard: Mutex<Vec<String>>,
}

impl NoteIdentity for Told {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        self.creates.adopt_or_create(ctx, file)
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError> {
        self.creates.on_removed(ctx, note_id, path)
    }

    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<Rename, IdentityError> {
        self.creates.on_renamed(ctx, note_id, old_path, new_path)
    }

    fn on_changed(
        &self,
        _: &IdentityCtx<'_>,
        note_id: &str,
        _: &str,
        _: &NoteFile,
    ) -> Result<(), IdentityError> {
        self.heard.lock().unwrap().push(note_id.to_owned());
        let next = self.next.lock().unwrap().take();
        next.map_or(Ok(()), |run| run())
    }
}

/// A vault holding `n.md` ("first words"), served to one window that answers every typing
/// barrier and counts them; `hook` runs, once, at the next barrier, before the answer.
struct Owed {
    e: Env,
    store: Arc<dyn SecureStore>,
    told: Arc<Told>,
    id: String,
    barriers: Arc<AtomicUsize>,
    hook: AtBarrier,
}

fn owed() -> Owed {
    let made = Mutex::new(None);
    let mut e = env(|store| {
        let told = Arc::new(Told {
            creates: creates(store),
            next: Mutex::default(),
            heard: Mutex::default(),
        });
        *made.lock().unwrap() = Some(told.clone());
        Some(told)
    });
    let told = made.into_inner().unwrap().unwrap();
    let store = told.creates.store.clone();
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&e.session);
    e.tier.set_editor_host(&host);
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    e.watcher_live();

    let barriers = Arc::new(AtomicUsize::new(0));
    let hook: AtBarrier = Arc::default();
    let (count, run, answer) = (barriers.clone(), hook.clone(), host.clone());
    let window = Subscriber {
        window_label: "main".into(),
        channel: Arc::new(move |frame: Vec<u8>| {
            if frame.first() == Some(&BARRIER) {
                count.fetch_add(1, Ordering::SeqCst);
                let next = run.lock().unwrap().take();
                if let Some(next) = next {
                    next();
                }
                answer.typing_sent("main", u32::from_le_bytes(frame[1..5].try_into().unwrap()));
            }
            true
        }),
    };
    host.open(&id, Some(&e.vault), window).unwrap();
    Owed {
        e,
        store,
        told,
        id,
        barriers,
        hook,
    }
}

fn owe_server_body(e: &Env, id: &str) {
    let id = id.to_owned();
    let db = e.core().db_handle();
    db.call_blocking(move |conn| body_debt::owe(conn, &id))
        .unwrap();
}

/// The server body arrived: the pull settled its debt.
fn settle(e: &Env, id: &str) {
    let id = id.to_owned();
    let db = e.core().db_handle();
    db.call_blocking(move |conn| body_debt::settle(conn, &id))
        .unwrap();
}

fn owes(e: &Env, id: &str) -> bool {
    e.core().note_files().owes_file_body(id).unwrap()
}

fn take(e: &Env, id: &str) -> Taken {
    e.tier.take_owed_file(&e.core(), id)
}

fn row_hashes(e: &Env, id: &str) -> (Option<String>, Option<String>) {
    let row = e.core().note_files().by_id(id).unwrap().expect("a row");
    (row.content_hash, row.file_hash)
}

impl Owed {
    /// An edit outside the app while the note's server body is not pulled: the file is owed.
    fn owe_outside(&self, rel: &str, text: &str) {
        owe_server_body(&self.e, &self.id);
        self.e.write(rel, text);
        until("the outside edit owes its file", || owes(&self.e, &self.id));
    }

    fn tier(&self) -> &Arc<VaultTier> {
        &self.e.tier
    }
}

/// The reviewer's probe (REVIEW-5145): tags edited outside while the body was owed reach the
/// record when the file is taken, as Electron's `takeOwedFile` lets the file win whole. Red
/// without `on_changed` in the take: the record keeps `["x"]`.
#[test]
fn an_owed_files_tags_reach_the_record_when_it_is_taken() {
    let (mut e, store) = opened();
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "Plan".into(),
        content: "About it".into(),
        tags: vec!["x".into()],
        ..NewNoteFile::default()
    };
    let id = notes.create(&open, note).unwrap().id;
    assert_eq!(record_tags(&e, "note", &id), ["x"]);
    measured(&e, &id);
    std::thread::sleep(QUIET);
    e.drain();

    owe_server_body(&e, &id);
    e.write("Plan.md", "---\ntags: [x, y]\n---\nOutside text\n");
    until("the outside edit owes its file", || owes(&e, &id));
    settle(&e, &id);

    assert_eq!(take(&e, &id), Taken::Took);
    assert_eq!(e.body(&id), "Outside text");
    assert_eq!(record_tags(&e, "note", &id), ["x", "y"]);
}

/// A record that refused the taken file's frontmatter leaves the row naming the older file: the
/// body holds the file and the marker is gone, and the next read (the open walk) tells the record
/// again.
#[test]
fn a_record_that_refuses_the_taken_file_is_told_again_at_the_next_read() {
    let mut o = owed();
    let before = row_hashes(&o.e, &o.id).0;
    o.owe_outside("n.md", "taken\n");
    settle(&o.e, &o.id);
    *o.told.next.lock().unwrap() = Some(Box::new(|| Err(IdentityError::Other("busy".into()))));

    assert_eq!(take(&o.e, &o.id), Taken::Failed);
    assert!(!owes(&o.e, &o.id));
    assert_eq!(o.e.body(&o.id), "taken");
    assert_eq!(
        row_hashes(&o.e, &o.id).0,
        before,
        "the row names the older file"
    );

    o.told.heard.lock().unwrap().clear();
    o.e.close();
    o.e.open();
    let hash = content_hash("taken\n");
    until("the open walk told the record", || {
        o.told.heard.lock().unwrap().contains(&o.id)
            && row_hashes(&o.e, &o.id).0.as_deref() == Some(hash.as_str())
    });
}

/// The write-back that runs between the body pull and the take (a page's schedule) keeps the
/// owed file, and the take then writes nothing over it: the body is the file's, the row names it.
#[test]
fn a_write_back_flushed_between_the_pull_and_the_take_keeps_the_file() {
    let o = owed();
    o.owe_outside("n.md", "owed text\n");
    settle(&o.e, &o.id);
    o.tier().schedule(&o.id);
    assert!(o.tier().flush(WAIT));
    assert_eq!(o.e.read("n.md"), "owed text\n");

    assert_eq!(take(&o.e, &o.id), Taken::Took);
    assert!(o.tier().flush(WAIT));
    assert_eq!(o.e.read("n.md"), "owed text\n");
    assert_eq!(o.e.body(&o.id), "owed text");
    let hash = content_hash("owed text\n");
    assert_eq!(row_hashes(&o.e, &o.id).0.as_deref(), Some(hash.as_str()));
}

/// An outside edit made after the take read the file and before it recorded the row (here, while
/// the record hears the take, under the lane) is fed once the take lets the lane go: the row
/// names the taken file, so the consumer reads the second edit as an outside edit.
#[test]
fn an_outside_edit_made_while_the_take_holds_the_lane_is_fed_after_it() {
    let o = owed();
    o.owe_outside("n.md", "taken\n");
    settle(&o.e, &o.id);
    let path = o.e.vault.join("n.md");
    *o.told.next.lock().unwrap() = Some(Box::new(move || {
        std::fs::write(&path, "second outside\n").unwrap();
        Ok(())
    }));

    assert_eq!(take(&o.e, &o.id), Taken::Took);
    until("the second edit is fed", || {
        o.e.body(&o.id) == "second outside"
    });
    assert!(o.tier().flush(WAIT));
    assert_eq!(o.e.read("n.md"), "second outside\n");
    assert!(!owes(&o.e, &o.id));
}

/// The marker goes (the consumer fed the file) and the app edits the body while the take waits
/// for the window's typing: the take, once it holds the lane, finds nothing owed and leaves the
/// body. Red without the take's second read of the marker under the lane: the take feeds the
/// owed file over the app's edit.
#[test]
fn a_marker_cleared_while_the_take_waited_for_typing_is_not_taken() {
    let o = owed();
    o.owe_outside("n.md", "owed text\n");
    settle(&o.e, &o.id);
    let (core, store, id) = (o.e.core(), o.store.clone(), o.id.clone());
    let ran = Arc::new(AtomicUsize::new(0));
    let hook_ran = ran.clone();
    *o.hook.lock().unwrap() = Some(Box::new(move || {
        assert!(core.note_files().clear_owed_file_body(&id).unwrap());
        edit_in_app(&core, &store, &id, "typed after the feed");
        hook_ran.fetch_add(1, Ordering::SeqCst);
    }));

    assert_eq!(take(&o.e, &o.id), Taken::NotOwed);
    assert_eq!(
        ran.load(Ordering::SeqCst),
        1,
        "the take waited for the typing"
    );
    assert_eq!(o.e.body(&o.id), "typed after the feed");
}

/// A marker whose server body is still owed, and a large file the feed refused whose bytes did
/// not change, cost no typing barrier (and so no lane) on a later pass; once the file changes it
/// is tried again. Red without the pass-over: every take asks the window for its typing.
#[test]
fn an_unchanged_refused_file_is_passed_over_without_typing_or_the_lane() {
    let o = owed();
    let large = |word: &str| format!("{word} ").repeat(300_000) + "\n";
    o.e.write("n.md", &large("one"));
    until("the large file owes its body", || owes(&o.e, &o.id));
    std::thread::sleep(QUIET);
    let asked = || o.barriers.load(Ordering::SeqCst);

    let before = asked();
    assert_eq!(take(&o.e, &o.id), Taken::StillOwed);
    assert_eq!(asked(), before + 1, "the first take reads the file");
    assert_eq!(take(&o.e, &o.id), Taken::StillOwed);
    assert_eq!(asked(), before + 1, "unchanged bytes are passed over");

    owe_server_body(&o.e, &o.id);
    o.e.write("n.md", &large("two"));
    let hash = content_hash(&large("two"));
    until("the consumer read the new bytes", || {
        row_hashes(&o.e, &o.id).1.as_deref() == Some(hash.as_str())
    });
    std::thread::sleep(QUIET);
    let before = asked();
    assert_eq!(take(&o.e, &o.id), Taken::StillOwed);
    assert_eq!(asked(), before, "a server body still owed is passed over");

    settle(&o.e, &o.id);
    assert_eq!(take(&o.e, &o.id), Taken::StillOwed);
    assert_eq!(asked(), before + 1, "changed bytes are tried again");
}
