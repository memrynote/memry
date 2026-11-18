//! The run after its books (stage 33d2): the journal day sections, the Reader pass, the status
//! other devices read and the run's live status, plus the writer's content guards.
//!
//! | Test                                                               | Electron                              |
//! | ------------------------------------------------------------------ | ------------------------------------- |
//! | new arrivals reach their journal day; the first import backfills none | `sync-service.journal.test.ts`, D17 |
//! | an open journal day stays pending until it closes                  | `journal-sync.ts` `flushJournal`, D6  |
//! | a saved Reader document becomes one note, a covered one none       | `sync-service.reader.test.ts`, D11    |
//! | a failed Reader list keeps its cursor and the v2 work              | `sync-service.ts` step 4              |
//! | the status follows changes and the token error                     | `sync-service.status.test.ts`, D18    |
//! | a panicking observer leaves the engine free                        | `sync-service.ts` `finally`           |
//! | an edit during an image download is not written over               | `note-writer.ts` `commit`, D6         |
//! | a start marker without its end marker stays touched                | `note-writer.ts` append, D5           |
//! | an append trims JavaScript white space only                        | `note-writer.ts` `trimEnd`            |
//! | a note that names a document is adopted                            | `reader-notes.ts`, D11                |
//! | a document a large note names fails and holds the Reader cursor    | `sync-service.ts` step 4              |

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::AtomicUsize;

use memry_desktop::journal::update::DayUpdate;
use memry_desktop::journal::{JournalEntryView, entry};
use memry_desktop::readwise::run_types::RunError;
use memry_desktop::readwise::section::SectionRead;

use super::*;

const DAY: &str = "2026-10-23";

impl Vault {
    /// Writes one synced setting, as another device's change would arrive.
    fn set(&self, path: &str, value: &str) {
        let settings = self
            .library
            .open
            .vault
            .settings(self.store.clone())
            .unwrap();
        settings.set(path.to_owned(), value.to_owned()).unwrap();
    }

    fn day(&self, date: &str) -> Option<JournalEntryView> {
        let journal = self.library.open.vault.journal(self.store.clone()).unwrap();
        entry(&self.library.open, &journal, date).unwrap()
    }

    fn add_highlight(&self, id: i64, text: &str, at: &str) {
        self.with_book(1, |book| {
            book["highlights"]
                .as_array_mut()
                .unwrap()
                .push(highlight(id, text, at));
        });
    }

    /// The run gate (33d3) waits for the property index; here the test does. `url` is the
    /// note's id once the index lists it.
    fn until_named(&self, url: &str) -> String {
        let named = || {
            let values = self.library.open.search.property_values("readwise_url");
            (values.ok()?.into_iter()).find_map(|(id, value)| (value == url).then_some(id))
        };
        self.until("the property index", || named().is_some());
        named().unwrap()
    }

    fn status_group(&self) -> Value {
        let group = self.library.store().settings_group().unwrap();
        group.get("status").cloned().unwrap_or(Value::Null)
    }
}

fn journal_vault() -> Vault {
    let v = vault(&[], two_highlights());
    v.set("readwise.journalHighlights", "true");
    let first = v.run();
    assert_eq!(first.counts.added, 1);
    v
}

#[test]
fn new_arrivals_reach_their_journal_day_and_the_first_import_backfills_none() {
    let v = journal_vault();
    assert!(
        v.day("2026-10-22").is_none(),
        "the first import fills the index only"
    );
    assert!(v.state().highlight_index_ready().unwrap());

    v.add_highlight(13, "Third idea", "2026-10-23T09:00:00.000Z");
    let second = v.run();
    assert_eq!(second.counts.updated, 1);
    let day = v.day(DAY).expect("the day's entry");
    assert!(
        day.content.contains("<!-- readwise-day:start -->"),
        "{}",
        day.content
    );
    assert!(
        day.content.contains("- [[Book 1]]: 1 highlight\n"),
        "{}",
        day.content
    );
    assert!(v.state().journal_pending().unwrap().is_empty());

    let third = v.run();
    assert_eq!(changed(&third.counts), 0);
    assert_eq!(v.day(DAY).unwrap().content, day.content);
}

#[test]
fn an_open_journal_day_stays_pending_until_it_closes() {
    let v = journal_vault();
    let update = DayUpdate {
        date: DAY.to_owned(),
        content: Some("Morning notes".to_owned()),
        ..DayUpdate::default()
    };
    let made = v.library.notes.update_day(&v.library.open, update).unwrap();
    let window = v.open_window(&made.entry.id);

    v.add_highlight(13, "Third idea", "2026-10-23T09:00:00.000Z");
    v.run();
    assert_eq!(v.day(DAY).unwrap().content, "Morning notes");
    assert!(v.state().journal_pending().unwrap().contains_key(DAY));

    v.host.close(&made.entry.id, "main");
    drop(window);
    v.until("the day to close", || {
        !(v.host).is_busy(&v.library.open.path, &made.entry.id, BUSY_WINDOW)
    });
    v.run();
    let content = v.day(DAY).unwrap().content;
    assert!(
        content.starts_with("Morning notes\n\n<!-- readwise-day:start -->"),
        "{content}"
    );
    assert!(content.contains("- [[Book 1]]: 1 highlight"), "{content}");
    assert!(v.state().journal_pending().unwrap().is_empty());
}

fn reader_vault(files: &[(&str, &str)]) -> Vault {
    let v = vault(files, two_highlights());
    v.with_book(1, |book| book["external_id"] = json!("covered"));
    v.set("readwise.readerDocuments", "true");
    *v.docs.lock().unwrap() = vec![
        json!({"id": "doc1", "title": " Saved article ", "category": "article",
               "updated_at": "2026-10-22T10:00:00.000Z"}),
        json!({"id": "covered", "title": "Has a book", "category": "article",
               "updated_at": "2026-10-22T11:00:00.000Z"}),
    ];
    v
}

#[test]
fn a_saved_reader_document_becomes_one_note_and_a_covered_one_none() {
    let v = reader_vault(&[]);
    let first = v.run();
    assert_eq!((first.counts.added, first.documents), (1, 1));
    let link = v.library.store().link_by_reader_document("doc1").unwrap();
    let note = read::get(&v.library.open, &link.unwrap().note_id, None)
        .unwrap()
        .expect("the Reader note");
    assert_eq!(note.title, "Saved article");
    assert!(note.path.starts_with("Readwise/Reader/"), "{}", note.path);
    let file = String::from_utf8(v.file(&note)).unwrap();
    assert!(
        file.contains("https://read.readwise.io/read/doc1"),
        "{file}"
    );
    assert!(file.contains(SECTION_START), "{file}");
    assert_eq!(v.markdown_files(), 2);
    assert_eq!(
        v.state().reader_cursor().unwrap().as_deref(),
        Some("2026-10-22T10:59:59.000Z")
    );

    let second = v.run();
    assert_eq!(second.documents, 0);
    assert_eq!(v.markdown_files(), 2);
}

#[test]
fn a_failed_reader_list_keeps_its_cursor_and_the_v2_work() {
    let v = reader_vault(&[]);
    *v.fail.lock().unwrap() = Some(("/api/v3/", 404));
    let run = v.run();
    assert_eq!(
        (run.counts.added, run.counts.failed, run.documents),
        (1, 1, 0)
    );
    assert!(v.state().cursor().unwrap().is_some());
    assert_eq!(v.state().reader_cursor().unwrap(), None);
    assert_eq!(v.markdown_files(), 1);
}

#[test]
fn the_status_follows_changes_and_the_token_error() {
    let v = vault(&[], two_highlights());
    let notices = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&notices);
    v.engine.status().on_change(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    v.run();
    let status = v.status_group();
    let at = status["lastChangeAt"]
        .as_str()
        .expect("lastChangeAt")
        .to_owned();
    assert!(status.get("error").is_none(), "{status}");
    assert!(
        notices.load(Ordering::SeqCst) >= 3,
        "waiting, reading, writing"
    );
    assert_eq!(v.engine.status().progress(), None);

    std::thread::sleep(Duration::from_millis(5));
    v.run();
    assert_eq!(
        v.status_group()["lastChangeAt"],
        json!(at),
        "an unchanged run sends nothing"
    );

    *v.fail.lock().unwrap() = Some(("/api/v2/", 401));
    let error = v
        .engine
        .run(&v.library, "token", &Unobserved, &CancellationToken::new());
    assert!(matches!(error, Err(RunError::Readwise(_))), "{error:?}");
    assert_eq!(v.status_group()["error"], json!("invalid-token"));
    assert_eq!(v.engine.status().failure().unwrap().kind, "invalid-token");

    *v.fail.lock().unwrap() = None;
    v.run();
    assert_eq!(
        v.status_group()["error"],
        Value::Null,
        "a cleared error is an explicit null"
    );
    assert_eq!(v.engine.status().failure(), None);
}

struct Panics;
impl RunObserver for Panics {
    fn planned(&self, _total: usize) {
        panic!("the observer failed");
    }
}

#[test]
fn a_panicking_observer_leaves_the_engine_free() {
    let v = vault(&[], two_highlights());
    let panicked = catch_unwind(AssertUnwindSafe(|| {
        v.run_with(&Panics, &CancellationToken::new())
    }));
    assert!(panicked.is_err());
    assert!(!v.engine.is_running());
    assert_eq!(v.engine.status().progress(), None);
    assert_eq!(v.run().counts.added, 1);
}

#[test]
fn an_edit_during_an_image_download_is_not_written_over() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let path = v.e.vault.join(&note.path);
    let image = format!("![]({}/img/a.png)", v.server_url);
    v.add_highlight(13, &image, "2026-10-23T09:00:00.000Z");
    *v.image.lock().unwrap() = Some(Box::new(move || {
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("{text}\nUser edit\n")).unwrap();
    }));

    let run = v.run();
    assert_eq!((run.counts.updated, run.counts.deferred), (0, 1));
    let file = String::from_utf8(v.file(&note)).unwrap();
    assert!(file.contains("User edit"), "{file}");
    assert!(!file.contains("img/a.png"), "{file}");
    let retry = v.state().retry_list().unwrap();
    assert_eq!(
        retry.iter().map(|e| e.readwise_book_id).collect::<Vec<_>>(),
        [1]
    );
}

#[test]
fn a_start_marker_without_its_end_marker_stays_touched() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let kept: Vec<&str> = (note.content.lines())
        .filter(|line| !line.starts_with(END_PREFIX))
        .collect();
    v.edit(&note, format!("{}\n\nMy own words", kept.join("\n")));

    // Without its end marker the floor is the note's creation: later highlights only.
    v.add_highlight(13, "Third idea", "2030-01-01T09:00:00.000Z");
    assert_eq!(v.run().counts.appended, 1);
    let content = v.note(1).content;
    assert!(
        matches!(
            read_section(&content),
            SectionRead::Found {
                untouched: false,
                ..
            }
        ),
        "{content}"
    );

    v.add_highlight(14, "Fourth idea", "2030-01-02T10:00:00.000Z");
    let run = v.run();
    assert_eq!((run.counts.appended, run.counts.updated), (1, 0));
    let content = v.note(1).content;
    for kept in ["My own words", "Third idea", "Fourth idea"] {
        assert!(content.contains(kept), "{kept}: {content}");
    }
}

/// `trimEnd` is ECMAScript white space: U+0085 is kept and U+FEFF goes, where Rust's
/// `trim_end` does the opposite.
#[test]
fn an_append_trims_javascript_white_space_only() {
    let v = vault(&[], two_highlights());
    v.run();
    let note = v.note(1);
    let kept: Vec<&str> = (note.content.lines())
        .filter(|line| !line.starts_with(END_PREFIX))
        .collect();
    v.edit(
        &note,
        format!("{}\n\nMy own words\u{85}\u{feff}", kept.join("\n")),
    );

    v.add_highlight(13, "Third idea", "2030-01-01T09:00:00.000Z");
    assert_eq!(v.run().counts.appended, 1);
    let content = v.note(1).content;
    assert!(content.contains("My own words\u{85}\n\n"), "{content:?}");
}

const DOC1: &str = "https://read.readwise.io/read/doc1";
const NAMES_DOC1: &str = "---\nreadwise_url: https://read.readwise.io/read/doc1\n---\n\n";

/// The note arrives after the first run, so no link row names it: the writer finds it by its
/// `readwise_url` and links it instead of writing a second note.
#[test]
fn a_note_that_names_a_document_is_adopted() {
    let v = reader_vault(&[]);
    let docs = std::mem::take(&mut *v.docs.lock().unwrap());
    v.run();
    let mine = format!("{NAMES_DOC1}Kept as I wrote it\n");
    let path = v.e.vault.join("Mine/Saved.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &mine).unwrap();
    v.until_named(DOC1);
    *v.docs.lock().unwrap() = docs;
    let run = v.run();
    assert_eq!((run.documents, run.counts.failed), (0, 0));
    assert_eq!(v.markdown_files(), 2);
    let link = v.library.store().link_by_reader_document("doc1").unwrap();
    let note = read::get(&v.library.open, &link.unwrap().note_id, None)
        .unwrap()
        .expect("the adopted note");
    assert_eq!(note.path, "Mine/Saved.md");
    assert_eq!(fs::read_to_string(&path).unwrap(), mine);
}

/// A note that names the document arrives after the first run (no link row) and grows large:
/// the writer cannot read it, so the document fails and the Reader cursor holds.
#[test]
fn a_document_a_large_note_names_fails_and_holds_the_reader_cursor() {
    let v = reader_vault(&[]);
    let docs = std::mem::take(&mut *v.docs.lock().unwrap());
    v.run();
    let held = v.state().reader_cursor().unwrap();
    assert!(held.is_some());

    let path = v.e.vault.join("Mine/Big.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("{NAMES_DOC1}Small at first\n")).unwrap();
    let id = v.until_named(DOC1);
    let big = format!("{NAMES_DOC1}{}\n", "x".repeat(130 * 1024));
    fs::write(&path, &big).unwrap();
    v.until("the note to turn large", || {
        read::get(&v.library.open, &id, None)
            .unwrap()
            .is_some_and(|note| note.content_omitted)
    });

    // Saved after the first run's cursor, so a pass that moved past the failure would move it.
    let mut docs = docs;
    for doc in &mut docs {
        doc["updated_at"] = json!("2030-01-01T10:00:00.000Z");
    }
    *v.docs.lock().unwrap() = docs;
    for _ in 0..2 {
        let run = v.run();
        assert_eq!((run.documents, run.counts.failed), (0, 1));
        assert_eq!(v.state().reader_cursor().unwrap(), held);
    }
    assert_eq!(v.markdown_files(), 2);
    assert_eq!(fs::read_to_string(&path).unwrap(), big);
}
