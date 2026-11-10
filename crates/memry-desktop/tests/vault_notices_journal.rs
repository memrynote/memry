//! The open vault's notices of the journal and the app moves that wait (Step 14l-3b, #3531):
//! raised where the waiting state is decided, through a real vault session, tier and identity,
//! and gone when it settles.

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::journal::folder_follow::pause_follow_after_batch;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::config::settings::{SettingsError, update_vault_settings_checked};
use memry_desktop::vault::journal_rename::ChangeStep;
use memry_desktop::vault::notices::{ChangeHold, VaultNotice, VaultNotices, WaitingMove};
use vault_env::{Env, indexed};

use crate::journal_change::folder;
use crate::journal_change_crash::change_killed;
use crate::journal_folder::{daily, dated_note, quiet, reopen, try_day};
use crate::journal_folder_held::recorded_elsewhere;
use crate::journal_folder_outside::moved_outside;
use crate::vault_settings::{opened_noticing, stored};

fn absolute(e: &Env, path: &str) -> String {
    e.vault.join(path).to_string_lossy().into_owned()
}

/// The board's notice of `notice`'s kind, if it is up.
fn shown(notices: &VaultNotices, like: fn(&VaultNotice) -> bool) -> Option<VaultNotice> {
    notices.list().into_iter().find(like)
}

/// A journal folder moved outside the app while another build's journal setting change owns
/// the days: the follow after the move's batch shows the folder the days wait in. Once they can
/// follow, the next command that asks (a day create here) follows, and the notice goes.
#[test]
fn journal_days_held_by_a_moved_folder_show_until_the_setting_follows() {
    let (mut e, store, notices) =
        opened_noticing(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    let held = |n: &VaultNotice| matches!(n, VaultNotice::JournalDaysHeld { .. });
    assert_eq!(
        shown(&notices, held),
        Some(VaultNotice::JournalDaysHeld {
            folders: vec![absolute(&e, "Diary")],
        })
    );

    recorded_elsewhere(&e, false);
    try_day(&notes, &e, "2025-01-07").unwrap();
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert_eq!(shown(&notices, held), None, "{:?}", notices.list());
}

/// A held day moved back to the journal folder outside the app: the batch's follow finds
/// nothing held, and the notice goes.
#[test]
fn journal_days_held_moved_back_take_the_notice_down() {
    let (mut e, _, notices) =
        opened_noticing(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    recorded_elsewhere(&e, true);
    moved_outside(&mut e, "journal", "Diary");
    let held = |n: &VaultNotice| matches!(n, VaultNotice::JournalDaysHeld { .. });
    assert!(shown(&notices, held).is_some(), "{:?}", notices.list());

    moved_outside(&mut e, "Diary", "journal");
    quiet(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    assert_eq!(shown(&notices, held), None, "{:?}", notices.list());
}

/// A day create while the consumer's batch still holds the days of a folder moved outside is
/// refused, and shows no notice: the follow after the batch decides, here following.
#[test]
fn journal_days_held_mid_batch_show_no_notice() {
    let (mut e, store, notices) =
        opened_noticing(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let root = e.session.current().unwrap().path.clone();
    let paused = pause_follow_after_batch(&root);
    moved_outside(&mut e, "journal", "Diary");
    let refused = try_day(&notes, &e, "2025-01-07");
    assert!(
        matches!(refused, Err(NotesError::JournalFolderHeld)),
        "{refused:?}"
    );
    let held = |n: &VaultNotice| matches!(n, VaultNotice::JournalDaysHeld { .. });
    assert_eq!(shown(&notices, held), None, "{:?}", notices.list());

    drop(paused);
    quiet(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    assert_eq!(shown(&notices, held), None, "{:?}", notices.list());
}

/// A journal setting change whose moved days cannot all go back when it is refused: the
/// change waits, and its notice is up at once, not only at the next command or open.
#[test]
fn a_refused_change_whose_days_stay_moved_shows_at_once() {
    let (e, _, notices) = opened_noticing(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
            ("Diary/2025-01-03.md", "A note\n"),
        ],
    );
    let (vault, core) = (e.vault.clone(), e.core());
    let mut blocked = false;
    let refused = update_vault_settings_checked(
        &e.vault,
        Some((&core, &e.tier)),
        folder("Diary"),
        |_| panic!("announced"),
        &mut |step| {
            if step == ChangeStep::Moved && !blocked {
                blocked = true;
                fs::create_dir_all(vault.join("journal/2025-01-02.md")).unwrap();
            }
        },
    );
    assert!(
        matches!(refused, Err(SettingsError::DaysNotRenamed { left: 1 })),
        "{refused:?}"
    );
    assert!(e.vault.join("Diary/2025-01-02.md").is_file());
    let waits = |n: &VaultNotice| matches!(n, VaultNotice::JournalChangeWaits { .. });
    assert_eq!(
        shown(&notices, waits),
        Some(VaultNotice::JournalChangeWaits {
            from: "journal".to_owned(),
            to: "Diary".to_owned(),
            holds: ChangeHold::Unknown,
        })
    );
}

/// A journal setting change a crash cut short, whose days cannot go back: the open shows the
/// change and what holds it, the settings file while it cannot be read, then a folder at a
/// day's old place. Once the place is free, the next command that finishes the change (a folder
/// rename apart from both journal folders) takes the notice down.
#[test]
fn an_unfinished_journal_change_shows_what_holds_its_days() {
    let (mut e, store, notices) = opened_noticing(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store);
    dated_note(&notes, &mut e);
    let (_, killed) = change_killed(&e, folder("Box/Diary"), Some(3));
    assert!(killed);
    let waits = |n: &VaultNotice| matches!(n, VaultNotice::JournalChangeWaits { .. });
    let held_by = |holds| VaultNotice::JournalChangeWaits {
        from: "journal".to_owned(),
        to: "Box/Diary".to_owned(),
        holds,
    };

    let config = fs::read(config_path(&e.vault)).unwrap();
    fs::write(config_path(&e.vault), "{").unwrap();
    reopen(&mut e);
    let path = config_path(&e.vault).to_string_lossy().into_owned();
    assert_eq!(
        shown(&notices, waits),
        Some(held_by(ChangeHold::Settings { path }))
    );

    fs::write(config_path(&e.vault), config).unwrap();
    for dir in ["journal/2025-01-02.md", "Apart"] {
        fs::create_dir_all(e.vault.join(dir)).unwrap();
    }
    reopen(&mut e);
    let path = absolute(&e, "journal/2025-01-02.md");
    assert_eq!(
        shown(&notices, waits),
        Some(held_by(ChangeHold::Taken { path }))
    );

    fs::remove_dir(e.vault.join("journal/2025-01-02.md")).unwrap();
    quiet(&mut e);
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "Apart", "Moved", |_| {})
        .unwrap();
    drop(open);
    assert!(e.vault.join("journal/2025-01-02.md").is_file());
    assert_eq!(shown(&notices, waits), None, "{:?}", notices.list());
}

/// A note's app move recorded by a build this one cannot finish: the open lists the note, at
/// its row's path, as one that does not move until the record settles. Once the record is gone,
/// the next open lists nothing.
#[test]
fn a_note_whose_interrupted_move_waits_is_listed() {
    let (mut e, _, notices) = opened_noticing(daily("journal"), &[("Notes/Plan.md", "A plan\n")]);
    let (id, _) = e
        .rows()
        .into_iter()
        .find(|(_, at)| at == "Notes/Plan.md")
        .unwrap();
    let key = format!("notes.app_move.v1:{id}");
    let meta = |e: &Env, sql: &'static str| {
        let key = key.clone();
        e.core()
            .db_handle()
            .call_blocking(move |conn| Ok(conn.execute(sql, [key]).unwrap()))
            .unwrap();
    };
    meta(
        &e,
        r#"INSERT INTO meta (key, value) VALUES (?1, '{"version":2}')"#,
    );
    reopen(&mut e);
    let waiting = |n: &VaultNotice| matches!(n, VaultNotice::MovesWait { .. });
    assert_eq!(
        shown(&notices, waiting),
        Some(VaultNotice::MovesWait {
            notes: vec![WaitingMove {
                note_id: id.clone(),
                path: absolute(&e, "Notes/Plan.md"),
            }],
            more: false,
        })
    );

    meta(&e, "DELETE FROM meta WHERE key = ?1");
    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    assert_eq!(shown(&notices, waiting), None, "{:?}", notices.list());
}
