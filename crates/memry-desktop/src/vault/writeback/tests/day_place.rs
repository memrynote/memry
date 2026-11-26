//! A live day's file moved to its date's path (`day_place`, REVIEW-5819 lows 1 and 2): a new
//! spelling that differs only in case moves on a volume that folds case, and a move the pass
//! refuses is logged once per session, not on every pass.

use std::sync::{Arc, Mutex};

use super::journal::Capture;
use super::*;
use crate::vault::config::{VaultConfigPatch, write_vault_config};

const DATE: &str = "2026-11-04";
const DAY_TEXT: &str = "---\ndate: '2026-11-04'\n---\nthe day\n";

fn set_format(f: &Fixture, format: &str) {
    let patch = VaultConfigPatch {
        journal_date_format: Some(format.to_owned()),
        ..VaultConfigPatch::default()
    };
    write_vault_config(&f.root, &patch).unwrap();
}

/// The day's file at `journal/04-nov-2026.md` under `DD-MMM-YYYY`, whose path is
/// `journal/04-Nov-2026.md`. Red before: on a volume that folds case the new spelling names the
/// day's own file, which the pass took for a taken path and never moved. A volume that keeps
/// case proves only the plain move.
#[test]
fn a_case_only_respelling_moves_the_days_file() {
    let mut f = fixture();
    set_format(&f, "DD-MMM-YYYY");
    let (old, new) = ("journal/04-nov-2026.md", "journal/04-Nov-2026.md");
    let id = f.adopt_day(old, DATE, DAY_TEXT);
    if !f.root.join(new).exists() {
        println!("case-sensitive volume: the respelling is a plain move here");
    }
    f.facts();

    let outcome = f.run(&id);

    assert!(
        matches!(outcome, Outcome::Unchanged | Outcome::Wrote { .. }),
        "{outcome:?}"
    );
    let row = f.vault.note_files().by_id(&id).unwrap().expect("a row");
    assert_eq!(row.path, new);
    let names: Vec<String> = std::fs::read_dir(f.root.join("journal"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["04-Nov-2026.md"]);
    assert!(f.read(new).contains("the day"));
    assert!(f.facts().iter().any(|fact| matches!(
        fact,
        Applied::Renamed { new_path, .. } if new_path == new
    )));
}

/// A file of the user's at the day's path: the day's file stays, the user's file is untouched,
/// and the refusal is logged on the first pass only. Red before: a warn on every pass.
#[test]
fn a_refused_move_is_logged_once_per_session() {
    let mut f = fixture();
    set_format(&f, "DD-MM-YYYY");
    let (old, new) = ("journal/2026-11-04.md", "journal/04-11-2026.md");
    let id = f.adopt_day(old, DATE, DAY_TEXT);
    f.write(new, "mine\n");

    let written = Arc::new(Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(Mutex::new(Capture(written.clone())))
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        // A call site another thread was registering while this subscriber went in may have
        // cached "never"; ask every call site again.
        tracing::callsite::rebuild_interest_cache();
        for _ in 0..3 {
            f.pass.mark_pulled(&id, None);
            f.run(&id);
        }
    });

    let log = String::from_utf8(written.lock().unwrap().clone()).unwrap();
    let warned = log
        .matches("a day's file stays off its date's path")
        .count();
    assert_eq!(warned, 1, "{log}");
    assert!(log.contains("the day's path is taken"), "{log}");
    assert_eq!(f.read(new), "mine\n");
    assert!(f.read(old).contains("the day"));
    let row = f.vault.note_files().by_id(&id).unwrap().expect("a row");
    assert_eq!(row.path, old);
}
