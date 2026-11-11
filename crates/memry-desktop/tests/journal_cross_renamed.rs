//! Held journal days renamed outside the app away from their day (Step 14l-3c, #3531), through
//! a real vault session, tier and identity: listed on the vault's notices while their file names
//! no day, and turned into notes by the user (`NotesService::cross_renamed_days`), as Electron's
//! watcher crosses such a file at the rename (`renameKeepsJournalDate`): the day deleted, the
//! delete synced, the file a new note. The file itself is never touched.
//!
//! | Test                                                              | Rule                                |
//! | ----------------------------------------------------------------- | ----------------------------------- |
//! | a held day renamed away is listed until renamed back              | `held` lists, the open lists again  |
//! | a renamed day deleted outside leaves the notice                   | `on_removed` takes it off           |
//! | a renamed day turned into a note syncs its delete                 | the file is made a new note         |
//! | a renamed day with text its file lacks stays a day                | `file_crossed` keeps it             |
//! | a renamed day is not crossed while a journal change waits         | the change owns the days            |
//! | a locked renamed day is not crossed                               | `refuse_note`                       |
//! | an excluded renamed day is not crossed                            | `refuse_note`                       |
//! | a renamed day is not crossed while a save of it waits             | the save is not undone by a revive  |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::journal::update::DayUpdate;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::notices::{RenamedDay, VaultNotice, VaultNotices};
use vault_env::{Env, QUIET};

use crate::journal_folder::{DAY, crossed, daily, outbox, reopen, row};
use crate::journal_folder_held::recorded_elsewhere;
use crate::journal_folder_outside::moved_outside;
use crate::lock_service::lock;
use crate::vault_exclude_read_only::exclude;
use crate::vault_settings::opened_noticing;

const TRIP: &str = "Diary/Trip.md";
const OTHER_DAY: &str = "j2025-01-03";
const DATE: &str = "2025-01-02";
/// Longest a step of a test waits on another thread.
const WAIT: Duration = Duration::from_secs(25);

/// Two days in `journal/`, carried to `Diary/` outside the app while another build's journal
/// change holds them, then the first renamed to `Diary/Trip.md`, a name that is no day.
fn renamed_away() -> (Env, Arc<NotesService>, Arc<VaultNotices>) {
    let (mut e, store, notices) = opened_noticing(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store);
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    renamed_outside(&mut e, "Diary/2025-01-02.md", TRIP);
    (e, notes, notices)
}

/// `from` renamed to `to` outside the app: the day stays held, its row follows the file, and
/// no note is made or removed.
fn renamed_outside(e: &mut Env, from: &str, to: &str) {
    fs::rename(e.vault.join(from), e.vault.join(to)).unwrap();
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
    assert!(e.rows().contains(&row(DAY, to)), "{:?}", e.rows());
}

fn renamed_notice(notices: &VaultNotices) -> Option<VaultNotice> {
    notices
        .list()
        .into_iter()
        .find(|n| matches!(n, VaultNotice::JournalDaysRenamed { .. }))
}

fn listed(e: &Env) -> VaultNotice {
    VaultNotice::JournalDaysRenamed {
        days: vec![RenamedDay {
            note_id: DAY.to_owned(),
            path: e
                .vault
                .join("Diary")
                .join("Trip.md")
                .to_string_lossy()
                .into_owned(),
        }],
        more: false,
    }
}

fn cross(e: &Env, notes: &NotesService) -> Vec<String> {
    let open = e.session.current().unwrap();
    notes.cross_renamed_days(&open, &[DAY.to_owned()]).unwrap()
}

/// The day the user asked about stays a day, as it was: no delete is queued, its row and file
/// are where they were, and it is still listed.
fn stays_a_day(e: &mut Env, notices: &VaultNotices, before: &[u8]) {
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
    assert!(!outbox(e, DAY).contains(&"delete".to_owned()));
    assert!(e.rows().contains(&row(DAY, TRIP)), "{:?}", e.rows());
    assert_eq!(fs::read(e.vault.join(TRIP)).unwrap(), before);
    assert_eq!(renamed_notice(notices), Some(listed(e)));
}

/// Renamed away, the day is listed at its file; renamed back to its day, the notice goes; the
/// open lists it again from the held places, with nothing made or removed.
#[test]
fn a_held_day_renamed_away_is_listed_until_renamed_back() {
    let (mut e, _, notices) = renamed_away();
    assert_eq!(renamed_notice(&notices), Some(listed(&e)));

    renamed_outside(&mut e, TRIP, "Diary/2025-01-02.md");
    assert_eq!(renamed_notice(&notices), None, "{:?}", notices.list());

    renamed_outside(&mut e, "Diary/2025-01-02.md", TRIP);
    assert_eq!(renamed_notice(&notices), Some(listed(&e)));
    reopen(&mut e);
    assert_eq!(renamed_notice(&notices), Some(listed(&e)));
    assert!(e.rows().contains(&row(DAY, TRIP)));
}

/// A renamed day whose file is then deleted outside the app is no longer listed.
#[test]
fn a_renamed_day_deleted_outside_leaves_the_notice() {
    let (mut e, _, notices) = renamed_away();
    fs::remove_file(e.vault.join(TRIP)).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { path, .. } if path == TRIP));
    assert_eq!(renamed_notice(&notices), None, "{:?}", notices.list());
}

/// Turned into a note, the day is deleted with its delete queued for every device, and the
/// watcher makes its file, untouched, a note with a new id; the other held day stays a day,
/// and the next open changes nothing.
#[test]
fn a_renamed_day_turned_into_a_note_syncs_its_delete() {
    let (mut e, notes, notices) = renamed_away();
    recorded_elsewhere(&e, false);
    let before = fs::read(e.vault.join(TRIP)).unwrap();

    assert_eq!(cross(&e, &notes), vec!["2025-01-02".to_owned()]);
    let facts =
        e.facts_until(|f| matches!(f, Applied::Added { path, created: true, .. } if path == TRIP));
    let note = facts
        .iter()
        .find_map(|f| match f {
            Applied::Added { note_id, path, .. } if path == TRIP => Some(note_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_ne!(note, DAY);
    assert!(outbox(&e, DAY).contains(&"delete".to_owned()));
    // The new note's create is an `upsert` of its id.
    assert!(
        outbox(&e, &note).contains(&"upsert".to_owned()),
        "{:?}",
        outbox(&e, &note)
    );
    assert_eq!(fs::read(e.vault.join(TRIP)).unwrap(), before);
    assert!(e.rows().contains(&row(&note, TRIP)), "{:?}", e.rows());
    assert!(!e.rows().iter().any(|(id, _)| id == DAY), "{:?}", e.rows());
    assert!(e.rows().contains(&row(OTHER_DAY, "Diary/2025-01-03.md")));
    assert_eq!(renamed_notice(&notices), None, "{:?}", notices.list());

    reopen(&mut e);
    assert!(e.rows().contains(&row(&note, TRIP)), "{:?}", e.rows());
    assert!(e.rows().contains(&row(OTHER_DAY, "Diary/2025-01-03.md")));
    assert_eq!(fs::read(e.vault.join(TRIP)).unwrap(), before);
    assert_eq!(renamed_notice(&notices), None, "{:?}", notices.list());
}

/// A day whose record has text its file does not (an edit the file is behind, set here on its
/// row) stays a day: a delete would take that text from every device.
#[test]
fn a_renamed_day_with_text_its_file_lacks_stays_a_day() {
    let (mut e, notes, notices) = renamed_away();
    recorded_elsewhere(&e, false);
    let before = fs::read(e.vault.join(TRIP)).unwrap();
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let sql = "UPDATE note_files SET content_hash = 'ahead' WHERE note_id = ?1";
            conn.execute(sql, [DAY]).unwrap();
            Ok(())
        })
        .unwrap();

    assert!(cross(&e, &notes).is_empty());
    stays_a_day(&mut e, &notices, &before);
}

/// While a journal setting change another build recorded waits, it owns the days: none is
/// turned into a note.
#[test]
fn a_renamed_day_is_not_crossed_while_a_journal_change_waits() {
    let (mut e, notes, notices) = renamed_away();
    let before = fs::read(e.vault.join(TRIP)).unwrap();

    assert!(cross(&e, &notes).is_empty());
    stays_a_day(&mut e, &notices, &before);
}

/// A locked day is not turned into a note.
#[test]
fn a_locked_renamed_day_is_not_crossed() {
    let (mut e, notes, notices) = renamed_away();
    recorded_elsewhere(&e, false);
    lock(&e, TargetKind::Note, DAY);
    std::thread::sleep(QUIET);
    e.drain();
    let before = fs::read(e.vault.join(TRIP)).unwrap();

    assert!(cross(&e, &notes).is_empty());
    stays_a_day(&mut e, &notices, &before);
}

/// A day in an excluded folder is not turned into a note.
#[test]
fn an_excluded_renamed_day_is_not_crossed() {
    let (mut e, notes, notices) = renamed_away();
    recorded_elsewhere(&e, false);
    exclude(&mut e, &["Diary"]);
    let before = fs::read(e.vault.join(TRIP)).unwrap();

    assert!(cross(&e, &notes).is_empty());
    stays_a_day(&mut e, &notices, &before);
}

/// A save of the day the editor sent before the click that waits behind the cross for the
/// day's turn keeps it a day: deleted first, the save would make the day again and undo its
/// sync delete. The save lands on the day, and the day is still listed for the next click.
#[test]
fn a_renamed_day_is_not_crossed_while_a_save_of_it_waits() {
    let (e, notes, notices) = renamed_away();
    recorded_elsewhere(&e, false);
    let mut save = None;
    let open = e.session.current().unwrap();
    let crossed = notes
        .cross_renamed_days_checked(&open, &[DAY.to_owned()], &mut || {
            let (saver, at) = (notes.clone(), open.clone());
            save = Some(std::thread::spawn(move || {
                saver.update_day(&at, typed("A day typed"))
            }));
            let waited = Instant::now();
            while notes.day_writes(DATE) < 2 {
                assert!(waited.elapsed() < WAIT, "the save never queued");
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .unwrap();
    assert!(crossed.is_empty());
    let saved = save.unwrap().join().unwrap().unwrap();
    drop(open);
    assert!(!saved.created, "{saved:?}");
    assert!(!outbox(&e, DAY).contains(&"delete".to_owned()));
    assert!(e.read(TRIP).contains("A day typed"));
    assert!(!e.vault.join("Diary/2025-01-02.md").exists());
    assert!(e.rows().contains(&row(DAY, TRIP)), "{:?}", e.rows());
    assert_eq!(renamed_notice(&notices), Some(listed(&e)));

    assert_eq!(cross(&e, &notes), vec![DATE.to_owned()]);
    assert!(outbox(&e, DAY).contains(&"delete".to_owned()));
}

fn typed(content: &str) -> DayUpdate {
    DayUpdate {
        date: DATE.into(),
        content: Some(content.into()),
        tags: None,
        inline_tags: None,
        properties: None,
    }
}
