//! The Readwise run (`readwise::engine`, Electron's `sync-service.ts` v2 path and
//! `note-writer.ts`) on a real vault under the running tier and an editor host, against a local
//! stand-in for the Readwise API. Never calls Readwise.
//!
//! | Test                                                              | Electron                         |
//! | ----------------------------------------------------------------- | -------------------------------- |
//! | a new book creates its note; an unchanged library writes nothing  | `sync-service.test.ts:246`, `:311`, `:718` |
//! | a touched section gets only the new highlight appended            | `sync-service.test.ts:379`       |
//! | an open note waits on the retry list, written after it closes     | `sync-service.test.ts:580`       |
//! | a server update defers a user-started write for 2 s               | `note-writer.ts:223-245` (dep. 12) |
//! | the cursor stays put on an empty window and never moves back      | `sync-service.test.ts:809`       |
//! | a cancelled run writes nothing and keeps the cursor               | `sync-service.test.ts:284`       |
//! | a book deleted in Readwise keeps its note and stops syncing       | `sync-service.test.ts:401`       |
//! | a missing note becomes `note-deleted`, not while indexing         | `sync-service.test.ts:424`, D9   |
//! | a note naming the book by `readwise_url` is adopted               | `rebuild-links.ts`, D11          |
//! | a re-import over stray markers leaves one readable section        | `note-writer.ts:318-341`         |

mod device_key;
mod editor_window;
mod readwise_server;
mod vault_env;

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::DateTime;
use memry_core::api::errors::StorageError;
use memry_core::crdt::update_log;
use memry_core::domain::readwise::LinkState;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::attachments::RemoteImages;
use memry_desktop::editor::{EditorHost, Subscriber};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::notes::view::NoteView;
use memry_desktop::readwise::engine::Engine;
use memry_desktop::readwise::library::{BUSY_WINDOW, Library};
use memry_desktop::readwise::plan_note::BookPlan;
use memry_desktop::readwise::run_state::{RunCounts, RunState};
use memry_desktop::readwise::run_types::{RunObserver, RunResult, Ungated, Unobserved};
use memry_desktop::readwise::section::{SECTION_START, SectionRead, read_section};
use memry_desktop::readwise::types::{CategorySwitches, FolderLayout, ReadwiseBook, SavedImages};
use memry_desktop::readwise::writer::{Outcome, PlanBase, SkipReason, UpsertOptions, Writer};
use memry_desktop::vault::activity::{ActivityFilter, ActivityLog};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use memry_desktop::readwise::limiter::RequestLimiter;

#[path = "readwise_run/after.rs"]
mod after;

use editor_window::Window;
use readwise_server::{Reply, Seen, Server};
use vault_env::{Env, QUIET, WAIT, env, indexed};

const END_PREFIX: &str = "<!-- readwise:end";

fn ms(iso: &str) -> i64 {
    DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis()
}

fn highlight(id: i64, text: &str, updated: &str) -> Value {
    json!({
        "id": id,
        "text": text,
        "location": id,
        "location_type": "location",
        "highlighted_at": updated,
        "created_at": updated,
        "updated_at": updated,
    })
}

fn book(id: i64, highlights: Vec<Value>) -> Value {
    json!({
        "user_book_id": id,
        "title": format!("Book {id}"),
        "author": "Ann Author",
        "category": "books",
        "source": "kindle",
        "readwise_url": format!("https://readwise.io/bookreview/{id}"),
        "highlights": highlights,
    })
}

type Books = Arc<Mutex<Vec<Value>>>;
/// Runs while the fake answers an image request: an edit made during a download.
type ImageHook = Arc<Mutex<Option<Box<dyn Fn() + Send>>>>;

/// A 1x1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// A path prefix the fake answers with a status instead.
type Fail = Arc<Mutex<Option<(&'static str, u16)>>>;

/// The fake Readwise: the v2 export, the Reader list (`docs`, all under `new`), and `/img/`.
fn serve(books: &Books, docs: &Books, image: &ImageHook, fail: &Fail, seen: &Seen) -> Reply {
    if let Some((prefix, status)) = *fail.lock().unwrap()
        && seen.path().starts_with(prefix)
    {
        return Reply::status(status);
    }
    match seen.path() {
        "/api/v3/list/" => {
            let all = docs.lock().unwrap().clone();
            let listed = match seen.param("location").as_deref() {
                Some("new") => all,
                _ => Vec::new(),
            };
            Reply::page(Value::Array(listed), None)
        }
        path if path.starts_with("/img/") => {
            if let Some(hook) = image.lock().unwrap().as_ref() {
                hook();
            }
            Reply::Answer {
                status: 200,
                headers: vec![("content-type", "image/png".to_owned())],
                body: PNG.to_vec(),
            }
        }
        _ => export(books, seen),
    }
}

/// `GET /api/v2/export/`: `ids=` answers the whole books, `updatedAfter` the books with a newer
/// highlight (only those highlights) or a newer `touched_at`, nothing else the whole library.
fn export(books: &Books, seen: &Seen) -> Reply {
    if seen.path() != "/api/v2/export/" {
        return Reply::status(404);
    }
    let all = books.lock().unwrap().clone();
    let id_of = |book: &Value| book["user_book_id"].as_i64().unwrap();
    let picked: Vec<Value> = if let Some(ids) = seen.param("ids") {
        let ids: Vec<i64> = ids.split(',').map(|id| id.parse().unwrap()).collect();
        all.into_iter()
            .filter(|b| ids.contains(&id_of(b)))
            .collect()
    } else if let Some(after) = seen.param("updatedAfter") {
        let after = ms(&after);
        let newer = |at: &Value| at.as_str().is_some_and(|at| ms(at) > after);
        all.into_iter()
            .filter_map(|mut book| {
                let changed: Vec<Value> = book["highlights"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|h| newer(&h["updated_at"]))
                    .cloned()
                    .collect();
                if changed.is_empty() && !newer(&book["touched_at"]) {
                    return None;
                }
                book["highlights"] = Value::Array(changed);
                Some(book)
            })
            .collect()
    } else {
        all
    };
    Reply::page(Value::Array(picked), None)
}

struct Vault {
    e: Env,
    host: Arc<EditorHost>,
    library: Library,
    engine: Engine,
    books: Books,
    docs: Books,
    image: ImageHook,
    fail: Fail,
    store: Arc<dyn SecureStore>,
    server_url: String,
    indexing: Arc<AtomicBool>,
    activity: Arc<ActivityLog>,
    _server: Server,
    // Last: the library's handle must not outlive it.
    _rt: tokio::runtime::Runtime,
}

/// A vault holding `files`, its notes served by an editor host, and a Readwise library of
/// `books`.
fn vault(files: &[(&str, &str)], books: Vec<Value>) -> Vault {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let kept = Mutex::new(None);
    let mut e = env(|store| {
        *kept.lock().unwrap() = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    let store: Arc<dyn SecureStore> = kept.into_inner().unwrap().expect("the store");
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&e.session);
    e.tier.set_editor_host(&host);
    for (rel, text) in files {
        e.write(rel, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let books: Books = Arc::new(Mutex::new(books));
    let served = Arc::clone(&books);
    let docs: Books = Arc::default();
    let image: ImageHook = Arc::default();
    let fail: Fail = Arc::default();
    let (served_docs, hook, failing) = (Arc::clone(&docs), Arc::clone(&image), Arc::clone(&fail));
    let server = rt.block_on(Server::start(move |seen, _| {
        serve(&served, &served_docs, &hook, &failing, seen)
    }));
    let server_url = server.url();
    let client = server.client();
    let images = RemoteImages::new(memry_desktop::http::builder().no_proxy()).unwrap();
    let indexing = Arc::new(AtomicBool::new(false));
    let is_indexing = Arc::clone(&indexing);
    let activity = ActivityLog::new();
    let open = e.session.current().unwrap();
    activity.open(&open.path);
    let library = Library::new(
        open,
        notes,
        Arc::clone(&host),
        Arc::new(images),
        Arc::new(move || is_indexing.load(Ordering::SeqCst)),
        rt.handle().clone(),
        Arc::clone(&activity),
    );
    let engine = Engine::new(
        client,
        Arc::new(Ungated),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
        Arc::new(|| Ok(chrono_tz::UTC)),
    )
    .with_reader_limiter(Arc::new(RequestLimiter::new(1000, Duration::from_secs(1))));
    Vault {
        e,
        host,
        library,
        engine,
        books,
        docs,
        image,
        fail,
        store,
        server_url,
        indexing,
        activity,
        _server: server,
        _rt: rt,
    }
}

impl Vault {
    fn run(&self) -> RunResult {
        self.run_with(&Unobserved, &CancellationToken::new())
    }

    fn run_with(&self, observer: &dyn RunObserver, cancel: &CancellationToken) -> RunResult {
        self.engine
            .run(&self.library, "token", observer, cancel)
            .expect("the run")
    }

    fn state(&self) -> RunState {
        RunState::new(self.library.store())
    }

    fn link(&self, book_id: i64) -> Option<(String, LinkState)> {
        let link = self.library.store().link_for_book(book_id, None).unwrap()?;
        Some((link.note_id, link.state))
    }

    fn note(&self, book_id: i64) -> NoteView {
        let (id, _) = self.link(book_id).expect("the book's link");
        read::get(&self.library.open, &id, None)
            .unwrap()
            .expect("the book's note")
    }

    fn file(&self, note: &NoteView) -> Vec<u8> {
        fs::read(self.e.vault.join(&note.path)).unwrap()
    }

    fn edit(&self, note: &NoteView, content: String) {
        let input = NoteUpdateInput {
            id: note.id.clone(),
            content: Some(content),
            ..NoteUpdateInput::default()
        };
        self.library
            .notes
            .update(&self.library.open, input)
            .unwrap();
    }

    fn with_book(&self, id: i64, change: impl FnOnce(&mut Value)) {
        let mut books = self.books.lock().unwrap();
        let book = books.iter_mut().find(|b| b["user_book_id"] == id).unwrap();
        change(book);
    }

    fn readwise_lines(&self) -> usize {
        let list = self.activity.list(100, ActivityFilter::All);
        let readwise = list.entries.iter();
        readwise
            .filter(|entry| entry.importer.as_deref() == Some("readwise"))
            .count()
    }

    fn markdown_files(&self) -> usize {
        fn walk(dir: &std::path::Path, count: &mut usize) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name();
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    walk(&path, count);
                } else if path.extension().is_some_and(|ext| ext == "md") {
                    *count += 1;
                }
            }
        }
        let mut count = 0;
        walk(&self.e.vault, &mut count);
        count
    }

    /// `note_id` open in the window `main`.
    fn open_window(&self, note_id: &str) -> Window {
        let subscriber = Subscriber {
            window_label: "main".to_owned(),
            channel: Arc::new(|_| true),
        };
        let opened = self
            .host
            .open(note_id, Some(&self.e.vault), subscriber)
            .unwrap();
        Window::from_state(&opened.state)
    }

    fn until(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + 3 * WAIT;
        while !done() {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn full_book(&self, id: i64) -> ReadwiseBook {
        let books = self.books.lock().unwrap();
        let book = books.iter().find(|b| b["user_book_id"] == id).unwrap();
        serde_json::from_value(book.clone()).unwrap()
    }
}

fn base() -> PlanBase {
    PlanBase {
        root: "Readwise".to_owned(),
        folder_layout: FolderLayout::ByCategory,
        categories: CategorySwitches::default(),
        time_zone: chrono_tz::UTC,
    }
}

fn two_highlights() -> Vec<Value> {
    vec![book(
        1,
        vec![
            highlight(11, "First idea", "2026-10-22T18:05:00.000Z"),
            highlight(12, "Second idea", "2026-10-22T18:06:00.000Z"),
        ],
    )]
}

fn changed(counts: &RunCounts) -> u64 {
    counts.added + counts.updated + counts.appended
}

#[test]
fn a_new_book_creates_its_note_and_an_unchanged_library_writes_nothing() {
    let v = vault(&[], two_highlights());
    let first = v.run();
    assert_eq!(first.counts.added, 1);
    assert_eq!(first.counts.highlights, 2);
    let note = v.note(1);
    assert!(note.path.starts_with("Readwise/"), "{}", note.path);
    assert!(note.content.contains(SECTION_START));
    assert!(note.content.contains("First idea") && note.content.contains("Second idea"));
    assert_eq!(v.link(1).unwrap().1, LinkState::Linked);
    assert_eq!(v.readwise_lines(), 1);
    let bytes = v.file(&note);

    // The window still holds the newest highlight (the cursor is one second before it): the
    // book is read in full again and renders the same bytes.
    let second = v.run();
    assert!(!second.cancelled);
    assert_eq!(changed(&second.counts), 0);
    assert_eq!(second.counts.failed, 0);
    assert_eq!(v.file(&note), bytes);
    assert_eq!(
        v.readwise_lines(),
        1,
        "a run that changed nothing logs no line"
    );
    assert_eq!(v.markdown_files(), 1);
}

#[test]
fn a_touched_section_gets_only_the_new_highlight_appended() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    v.edit(
        &note,
        note.content
            .replace("Second idea", "Second idea, my thought"),
    );
    v.with_book(1, |book| {
        let list = book["highlights"].as_array_mut().unwrap();
        list[0]["text"] = json!("First idea, edited in Readwise");
        list[0]["updated_at"] = json!("2026-10-22T18:07:00.000Z");
        list.push(highlight(13, "Third idea", "2026-10-22T18:08:00.000Z"));
    });

    let run = v.run();
    assert_eq!(run.counts.appended, 1);
    let content = v.note(1).content;
    assert!(
        content.contains("Second idea, my thought"),
        "the user's edit stays"
    );
    assert!(
        !content.contains("edited in Readwise"),
        "a touched section is never rewritten"
    );
    let third = content.find("Third idea").expect("the new highlight");
    assert!(
        third < content.rfind(END_PREFIX).unwrap(),
        "inside the section"
    );
    assert!(matches!(
        read_section(&content),
        SectionRead::Found {
            untouched: false,
            ..
        }
    ));
    assert_eq!(content.matches("Third idea").count(), 1);
}

#[test]
fn an_open_note_waits_on_the_retry_list_and_is_written_after_it_closes() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let _window = v.open_window(&note.id);
    v.with_book(1, |book| {
        let list = book["highlights"].as_array_mut().unwrap();
        list[1]["text"] = json!("Second idea, edited");
        list[1]["updated_at"] = json!("2026-10-22T18:09:00.000Z");
    });

    let deferred = v.run();
    assert_eq!(deferred.counts.deferred, 1);
    assert_eq!(changed(&deferred.counts), 0);
    let retry = v.state().retry_list().unwrap();
    assert_eq!(retry.len(), 1);
    assert_eq!(
        (retry[0].readwise_book_id, retry[0].reason.as_str()),
        (1, "note-open")
    );
    assert!(!v.note(1).content.contains("edited"));

    // Still open: still waiting, and still listed once.
    assert_eq!(v.run().counts.deferred, 1);
    assert_eq!(v.state().retry_list().unwrap()[0].attempts, 2);

    // Closed, then past the editor's grace period (its last save may still be on the way).
    v.host.close(&note.id, "main");
    let path = v.library.open.path.clone();
    v.until("the grace period", || {
        !v.host.is_busy(&path, &note.id, BUSY_WINDOW)
    });
    let written = v.run();
    assert_eq!(written.counts.updated, 1);
    assert!(v.note(1).content.contains("Second idea, edited"));
    assert!(v.state().retry_list().unwrap().is_empty());
}

/// Electron's user-started writes skip the busy check (`note-writer.ts:244-245`); here they still
/// wait out a server update (#5053 departure 12), and only for `BUSY_WINDOW`: the closed
/// window's grace period does not hold them.
#[test]
fn a_server_update_defers_a_user_started_write_for_two_seconds() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    v.edit(
        &note,
        note.content.replace("First idea", "First idea, mine"),
    );
    let window = v.open_window(&note.id);
    let update = window.type_text("From the server ");
    let id = note.id.clone();
    let db = v.library.open.vault.db_handle();
    db.call_blocking(move |conn| {
        update_log::append_server_update(conn, &id, 1, &update, 1).map_err(|error| {
            StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .unwrap();
    v.host.close(&note.id, "main");
    let path = v.library.open.path.clone();
    assert!(v.host.took_remote_update(&path, &note.id, BUSY_WINDOW));

    let book = v.full_book(1);
    let BookPlan::Note(plan) = base().plan(&book, &SavedImages::new()).unwrap() else {
        panic!("a note plan");
    };
    let state = v.state();
    let base = base();
    let writer = Writer {
        library: &v.library,
        state: &state,
        base: &base,
    };
    let reset = UpsertOptions {
        reset: true,
        user_initiated: true,
        ..UpsertOptions::default()
    };
    let busy = Outcome::Skipped {
        reason: SkipReason::Busy,
        note_id: Some(note.id.clone()),
    };
    assert_eq!(writer.upsert(&book, &plan, reset), busy);
    assert_eq!(state.retry_list().unwrap()[0].reason, "note-open");

    v.until("the server update window", || {
        !v.host.took_remote_update(&path, &note.id, BUSY_WINDOW)
    });
    // Let the server update's write-back land, so the note is read once.
    std::thread::sleep(QUIET);
    assert!(
        v.host.is_busy(&path, &note.id, BUSY_WINDOW),
        "still in the grace period"
    );
    assert_eq!(
        writer.upsert(&book, &plan, reset),
        Outcome::Updated(note.id.clone())
    );
    let content = v.note(1).content;
    assert!(
        !content.contains("First idea, mine"),
        "a re-import rewrites the section"
    );
    assert!(state.retry_list().unwrap().is_empty());
}

#[test]
fn the_cursor_stays_put_on_an_empty_window_and_never_moves_back() {
    let v = vault(&[], two_highlights());
    // A first import of an empty library fills the highlight index; until it is filled every
    // run reads in full.
    let library = std::mem::take(&mut *v.books.lock().unwrap());
    assert_eq!(v.run().counts.books, 0);
    assert!(v.state().highlight_index_ready().unwrap());
    *v.books.lock().unwrap() = library;
    let later = "2026-11-01T00:00:00.000Z";
    let state = v.state();
    state.set_cursor(later).unwrap();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    state.set_last_full_read(&now).unwrap();

    let empty = v.run();
    assert_eq!(empty.counts.books, 0);
    assert_eq!(state.cursor().unwrap().as_deref(), Some(later));

    // A full read brings highlights older than the cursor.
    state.set_full_pass_pending(true).unwrap();
    let full = v.run();
    assert_eq!(full.counts.added, 1);
    assert_eq!(state.cursor().unwrap().as_deref(), Some(later));
}

struct CancelOnPlan(CancellationToken);

impl RunObserver for CancelOnPlan {
    fn planned(&self, _total: usize) {
        self.0.cancel();
    }
}

#[test]
fn a_cancelled_run_writes_nothing_and_keeps_the_cursor() {
    let v = vault(&[], two_highlights());
    let state = v.state();
    let cursor = "2026-10-01T00:00:00.000Z";
    state.set_cursor(cursor).unwrap();
    state.set_full_pass_pending(true).unwrap();

    let cancel = CancellationToken::new();
    let run = v.run_with(&CancelOnPlan(cancel.clone()), &cancel);
    assert!(run.cancelled);
    assert_eq!(changed(&run.counts), 0);
    assert!(v.link(1).is_none(), "no note");
    assert_eq!(v.markdown_files(), 0);
    assert_eq!(state.cursor().unwrap().as_deref(), Some(cursor));
    assert!(state.full_pass_pending().unwrap());
    assert!(state.last_run().unwrap().is_none());
    assert_eq!(v.readwise_lines(), 0);
    assert!(!v.engine.is_running());

    // The next run covers the same window.
    assert_eq!(v.run().counts.added, 1);
}

#[test]
fn a_book_deleted_in_readwise_keeps_its_note_and_stops_syncing() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let bytes = v.file(&note);
    v.with_book(1, |book| {
        book["is_deleted"] = json!(true);
        book["touched_at"] = json!("2026-10-23T00:00:00.000Z");
    });
    v.run();
    assert_eq!(v.link(1).unwrap().1, LinkState::SourceDeleted);
    assert_eq!(v.file(&note), bytes);

    v.with_book(1, |book| {
        book["is_deleted"] = json!(false);
        let list = book["highlights"].as_array_mut().unwrap();
        list.push(highlight(13, "Third idea", "2026-10-24T00:00:00.000Z"));
    });
    let after = v.run();
    assert_eq!(changed(&after.counts), 0);
    assert_eq!(v.file(&note), bytes);
}

#[test]
fn a_missing_note_is_marked_deleted_but_not_while_the_vault_indexes() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    v.library
        .notes
        .delete(&v.library.open, &note.id, true)
        .unwrap();
    v.with_book(1, |book| {
        let list = book["highlights"].as_array_mut().unwrap();
        list.push(highlight(13, "Third idea", "2026-10-24T00:00:00.000Z"));
    });

    v.indexing.store(true, Ordering::SeqCst);
    let indexing = v.run();
    assert_eq!(indexing.counts.failed, 1);
    assert_eq!(
        v.link(1).unwrap().1,
        LinkState::Linked,
        "not marked while indexing"
    );
    assert_eq!(v.state().retry_list().unwrap().len(), 1);

    v.indexing.store(false, Ordering::SeqCst);
    let run = v.run();
    assert_eq!(changed(&run.counts), 0);
    assert_eq!(v.link(1).unwrap().1, LinkState::NoteDeleted);
    assert!(v.state().retry_list().unwrap().is_empty());
    assert_eq!(v.markdown_files(), 0, "no new note");
}

#[test]
fn a_note_that_names_the_book_by_readwise_url_is_adopted() {
    let mine = "---\nreadwise_url: https://readwise.io/bookreview/1\n---\nMy own notes\n";
    let v = vault(&[("Reading/Mine.md", mine)], two_highlights());
    // The run gate (33d3) waits for the index; here the test does.
    v.until("the property index", || {
        v.library
            .open
            .search
            .property_values("readwise_url")
            .is_ok_and(|values| values.len() == 1)
    });
    // Linked, not duplicated. A note without a section takes only highlights made after it
    // (`planAppend`'s floor), as in Electron.
    let first = v.run();
    assert_eq!(changed(&first.counts), 0);
    assert_eq!(v.markdown_files(), 1, "no duplicate");
    let note = v.note(1);
    assert_eq!(note.path, "Reading/Mine.md");
    assert_eq!(note.content, "My own notes\n");

    let later = (chrono::Utc::now() + chrono::Duration::minutes(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    v.with_book(1, |book| {
        let list = book["highlights"].as_array_mut().unwrap();
        list.push(highlight(13, "Third idea", &later));
    });
    let second = v.run();
    assert_eq!((second.counts.added, second.counts.appended), (0, 1));
    assert_eq!(v.markdown_files(), 1);
    let content = v.note(1).content;
    assert!(content.starts_with("My own notes\n"));
    assert!(content.contains("Third idea") && !content.contains("First idea"));
    assert_eq!(
        content.matches(END_PREFIX).count(),
        1,
        "a marker to hold `last`"
    );
}

/// A re-import whose section markers the user broke, with a stray end marker in their text,
/// strips every stray marker so the new section is the only one (`STRAY_MARKERS`).
#[test]
fn a_reimport_over_stray_markers_leaves_one_readable_section() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let broken = format!(
        "Before <!-- readwise:end v1 last=x hash=0 --> my words\n\n{}",
        note.content.replacen(SECTION_START, "", 1)
    );
    v.edit(&note, broken);

    let book = v.full_book(1);
    let BookPlan::Note(plan) = base().plan(&book, &SavedImages::new()).unwrap() else {
        panic!("a note plan");
    };
    let state = v.state();
    let base = base();
    let writer = Writer {
        library: &v.library,
        state: &state,
        base: &base,
    };
    let reset = UpsertOptions {
        reset: true,
        user_initiated: true,
        ..UpsertOptions::default()
    };
    assert!(matches!(
        writer.upsert(&book, &plan, reset),
        Outcome::Updated(_)
    ));
    let content = v.note(1).content;
    assert!(content.contains("Before  my words"));
    assert_eq!(content.matches(SECTION_START).count(), 1);
    assert_eq!(content.matches(END_PREFIX).count(), 1);
    assert!(matches!(
        read_section(&content),
        SectionRead::Found {
            untouched: true,
            ..
        }
    ));
}
