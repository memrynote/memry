//! Journal days a move outside the app carried, held while the setting cannot follow them
//! (Step 13m-7b-2b stage c, #3530; `journal::folder_follow::Follow::HeldWaits`): a journal
//! setting change another build recorded, a folder the days cannot live in, or days that went
//! to more than one folder. The hold is kept, so no open crosses a held day into a note
//! (`journal_folder_kept_held`), but a day named under the old folder would make it again, after
//! which the setting never follows, and a setting saved over the days would leave them outside
//! the journal. So no day is made, no journal setting change moves days, and the held folder
//! neither moves nor goes (`journal_folder_held`), until the days can follow or go back.
//! Followed cases: `journal_folder_outside`.
//!
//! | Test                                                              | Rule                               |
//! | ----------------------------------------------------------------- | ---------------------------------- |
//! | a journal change another build recorded holds the moved days      | P3: the record owns the days       |
//! | a folder the days cannot live in holds them until renamed         | P4, P5: a refused target           |
//! | days moved to more than one folder are held                       | one folder only                    |
//! | a held folder renamed while closed is followed from where it was  | first owed path; target gone       |
//! | a day added to the held folder while closed opens as a day        | the open follows before its walk   |
//! | a follow cut short after its save settles at the next open        | crash between save and settle      |
//! | a command reads the held days once however many wait              | cost per held day stays flat       |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::notes::journal_change;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::config::settings::SettingsError;
use vault_env::{Env, QUIET, indexed};

use crate::journal_change::folder;
use crate::journal_folder::{DAY, daily, outbox, reopen, row, settles, try_day};
use crate::journal_folder_outside::{journal, moved_outside, opened_after};
use crate::vault_settings::{opened_keeping, stored, update};

/// A journal setting change record of another build's, which this one cannot read.
pub(crate) fn recorded_elsewhere(e: &Env, record: bool) {
    let sql = if record {
        "INSERT INTO meta (key, value) VALUES (?1, '{\"version\":2}')"
    } else {
        "DELETE FROM meta WHERE key = ?1"
    };
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(sql, [journal_change::KEY]).unwrap();
            Ok(())
        })
        .unwrap();
}

/// While the days in `held` wait: no day is made, no journal setting change starts, and the
/// held folder neither moves nor goes; the opens after keep every held day a day.
fn held_through_reopens(e: &mut Env, notes: &NotesService, held: &str) {
    let refused = try_day(notes, e, "2025-01-07");
    assert!(
        matches!(refused, Err(NotesError::JournalFolderHeld)),
        "{refused:?}"
    );
    let refused = update(e, folder("Other"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::JournalFolderHeld)),
        "{refused:?}"
    );
    let open = e.session.current().unwrap();
    let moved = notes.rename_folder(&open, held, "Moved", |_| panic!("announced"));
    assert!(
        matches!(moved, Err(NotesError::JournalFolderHeld)),
        "{moved:?}"
    );
    let deleted = notes.delete_folder(&open, held);
    assert!(
        matches!(deleted, Err(NotesError::JournalFolderHeld)),
        "{deleted:?}"
    );
    drop(open);
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert!(!e.vault.join("journal").exists());
    reopen(e);
    reopen(e);
    assert!(
        e.rows()
            .contains(&row(DAY, &format!("{held}/2025-01-02.md")))
    );
    assert!(!outbox(e, DAY).contains(&"delete".to_owned()));
}

/// P3: a journal setting change another build recorded owns the days until that build settles
/// it, so the setting follows nothing meanwhile. Once the record is gone, the open follows.
#[test]
fn a_journal_change_another_build_recorded_holds_the_moved_days() {
    let (mut e, notes, _, note) = journal();
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    held_through_reopens(&mut e, &notes, "Diary");
    recorded_elsewhere(&e, false);
    reopen(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// P4, P5: moved to `canvases` (the folder the tree keeps for canvases, which the days cannot
/// live in), the days are held there. Renamed to a folder they can live in, the setting follows.
/// Each platform can make this folder; `Diary ` (a trailing space) is refused too, but Windows
/// drops the space in the rename.
#[test]
fn a_folder_the_days_cannot_live_in_holds_them_until_renamed() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "canvases");
    held_through_reopens(&mut e, &notes, "canvases");
    moved_outside(&mut e, "canvases", "Diary");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// Two days moved to two folders while the app was closed, the journal folder gone: the open
/// holds both, and the setting can follow neither.
#[test]
fn days_moved_to_more_than_one_folder_are_held() {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store);
    e.close();
    for (dir, name) in [("A", "2025-01-02.md"), ("B", "2025-01-03.md")] {
        fs::create_dir(e.vault.join(dir)).unwrap();
        fs::rename(
            e.vault.join("journal").join(name),
            e.vault.join(dir).join(name),
        )
        .unwrap();
    }
    fs::remove_dir(e.vault.join("journal")).unwrap();
    opened_after(&mut e);
    held_through_reopens(&mut e, &notes, "A");
    assert!(e.rows().contains(&row("j2025-01-03", "B/2025-01-03.md")));
    assert!(!outbox(&e, "j2025-01-03").contains(&"delete".to_owned()));
}

/// Held in `Diary` (another build's record), then `Diary` renamed while the app is closed and
/// the record gone. The open finds no `Diary` and follows nothing before its walk; the walk
/// reads the second move from where the day was before the first, so it is the journal moving
/// on, held, and followed after the walk. Saved as `Diary` before the walk, the setting would
/// name a folder that is gone, and the walk would cross the day.
#[test]
fn a_held_folder_renamed_while_closed_is_followed_from_where_it_was() {
    let (mut e, notes, _, note) = journal();
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    recorded_elsewhere(&e, false);
    e.close();
    fs::rename(e.vault.join("Diary"), e.vault.join("Diary2")).unwrap();
    opened_after(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary2");
    settles(&mut e, &notes, &note, "Diary2");
}

/// Held in `Diary`, then a day's file added there while the app is closed and the record gone:
/// the open follows before its walk, so the walk finds the file inside the journal, a day.
/// Followed after the walk, the file would already be a note whose title is a date.
#[test]
fn a_day_added_to_the_held_folder_while_closed_opens_as_a_day() {
    let (mut e, notes, _, note) = journal();
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    recorded_elsewhere(&e, false);
    e.close();
    fs::write(e.vault.join("Diary/2025-01-09.md"), "Written elsewhere\n").unwrap();
    e.drain();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert!(
        e.rows()
            .contains(&row("j2025-01-09", "Diary/2025-01-09.md"))
    );
    settles(&mut e, &notes, &note, "Diary");
}

/// Stopped after the followed folder was saved and before the moves owed settled, as a crash
/// there stops it: the next open settles each day's move by the saved setting.
#[test]
fn a_follow_cut_short_after_its_save_settles_at_the_next_open() {
    let (mut e, notes, _, note) = journal();
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    recorded_elsewhere(&e, false);
    e.close();
    fs::write(config_path(&e.vault), daily("Diary").to_string()).unwrap();
    opened_after(&mut e);
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}

/// Days held in `canvases`, read for a command: the steps the database takes for the refused
/// day create grow with the days held, not with their square or cube. Before, each day read
/// every owed move and every hold, and the read of the holds matched each hold against every
/// owed move, so each command, open and batch grew with the cube of the held days: 900 held
/// days took a refused day create 131 s. Counted in SQLite's own steps, never in time.
#[test]
fn a_command_reads_the_held_days_once_however_many_wait() {
    const DAYS: u64 = 300;
    let paths: Vec<String> = (0..DAYS)
        .map(|i| format!("journal/2024-{:02}-{:02}.md", i / 28 + 1, i % 28 + 1))
        .collect();
    let files: Vec<(&str, &str)> = paths.iter().map(|path| (&**path, "A day\n")).collect();
    let (mut e, store) = opened_keeping(daily("journal"), &files);
    let notes = NotesService::new(e.tier.clone(), store);
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("canvases")).unwrap();
    opened_after(&mut e);
    assert!(
        e.rows()
            .contains(&row("j2024-11-20", "canvases/2024-11-20.md"))
    );

    let steps = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&steps);
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let count = move || {
                counted.fetch_add(1, Ordering::Relaxed);
                false
            };
            conn.progress_handler(1, Some(count)).unwrap();
            Ok(())
        })
        .unwrap();
    let refused = try_day(&notes, &e, "2025-06-07");
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.progress_handler(0, None::<fn() -> bool>).unwrap();
            Ok(())
        })
        .unwrap();
    assert!(
        matches!(refused, Err(NotesError::JournalFolderHeld)),
        "{refused:?}"
    );
    let steps = steps.load(Ordering::Relaxed);
    assert!(steps < 200 * DAYS, "{steps} steps for {DAYS} held days");
    assert!(!outbox(&e, "j2024-11-20").contains(&"delete".to_owned()));
}
