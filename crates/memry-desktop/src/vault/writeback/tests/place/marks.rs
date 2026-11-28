//! The pulled mark in `data.db` (`note_pulled_marks`, #5309): a pulled place outlives a quit
//! before its pass, a pass settles only the pull it read, and a mark whose tries are spent keeps
//! the title its file carries until the next pull.

use super::*;

/// A pulled rename outlives a quit before its pass (#5309): the next run's reconcile lists the
/// note and its pass moves the file. Red with the mark in memory.
#[test]
fn a_pulled_rename_reaches_the_file_after_a_restart() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    let mut f = f.restart();
    assert_eq!(marked(&f), std::slice::from_ref(&id));
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(!f.root.join("n.md").exists());
    assert_eq!(f.read("Renamed.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Renamed.md");
    assert_eq!(renamed_facts(&mut f), 1);
    assert!(marked(&f).is_empty(), "the pass settled the mark");
}

/// The failed tries of a pulled move outlive a quit: the restarted run tries only what is left
/// of `PLACE_TRIES`, then parks the mark.
#[cfg(unix)]
#[test]
fn the_failed_tries_survive_a_restart() {
    use std::os::unix::fs::PermissionsExt;

    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    std::fs::create_dir(f.root.join("Work")).unwrap();
    let locked = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(f.root.join("Work"), locked).unwrap();
    pulled_folder(&f, &id, "Work");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    let f = f.restart();
    assert_eq!(
        marked(&f),
        std::slice::from_ref(&id),
        "one try failed, the mark waits"
    );
    for _ in 1..PLACE_TRIES {
        assert_eq!(f.run(&id), Outcome::Unchanged);
    }
    assert!(
        marked(&f).is_empty(),
        "the tries are spent across both runs"
    );
    let open = std::fs::Permissions::from_mode(0o755);
    std::fs::set_permissions(f.root.join("Work"), open).unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(row_path(&f, &id), "n.md", "a parked mark moves nothing");
}

/// A second pull before the pass keeps the first pull's title: the file still carries it, so
/// the pulled rename is not lost to a later tag pull (`mark_pulled`).
#[test]
fn two_pulls_before_a_pass_keep_the_first_title() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Plan");
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert!(!f.root.join("n.md").exists());
    assert_eq!(
        f.read("Plan.md"),
        "---\ntags:\n  - remote\n---\nfirst words\n"
    );
}

/// After the tries are spent, the next pull places the name as well as the folder: the parked
/// mark keeps the title the file carries (VERIFY-5316B Low 3).
#[cfg(unix)]
#[test]
fn the_next_pull_after_the_tries_renames_the_file_too() {
    use std::os::unix::fs::PermissionsExt;

    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    std::fs::create_dir(f.root.join("Work")).unwrap();
    let locked = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(f.root.join("Work"), locked).unwrap();
    pulled(&f, &id, |w| {
        w.rename(id.clone(), "Plan".into()).unwrap();
        w.move_to_folder(id.clone(), Some("Work".into())).unwrap();
    });
    for _ in 0..PLACE_TRIES {
        assert_eq!(f.run(&id), Outcome::Unchanged);
    }
    let open = std::fs::Permissions::from_mode(0o755);
    std::fs::set_permissions(f.root.join("Work"), open).unwrap();
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(row_path(&f, &id), "Work/Plan.md");
    assert!(f.read("Work/Plan.md").contains("  - remote\n"));
}

/// A pass that stops after it read the mark (an outside write under its own) leaves the mark:
/// the next pass gives the file the pulled tags (VERIFY-5316B Low 4).
#[test]
fn a_pass_stopped_under_its_write_keeps_the_mark() {
    let mut f = fixture();
    let text = "first words\n";
    let id = note(&mut f, text);
    pulled_tags(&f, &id, &["remote"]);
    let path = f.root.join("n.md");
    let outcome = f.pass.run_checked(&id, &mut || {
        std::fs::write(&path, "written outside\n").unwrap();
    });
    assert_eq!(outcome, Outcome::Kept(Keep::FileChanged));
    f.write("n.md", text);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(f.read("n.md"), "---\ntags:\n  - remote\n---\nfirst words\n");
}

/// A pull that lands while a pass runs keeps its mark: the pass settles only the pull it read,
/// and the next pass gives the file the later one.
#[test]
fn a_pull_during_a_pass_keeps_its_mark() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_tags(&f, &id, &["early"]);
    let outcome = f
        .pass
        .run_checked(&id, &mut || pulled_tags(&f, &id, &["late"]));
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(marked(&f), std::slice::from_ref(&id));
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert!(f.read("n.md").contains("  - late\n"));
    assert!(marked(&f).is_empty());
}

/// The sync observer marks a pulled note with the title it had before, through the real
/// observer: a pulled tag change keeps a numbered name (VERIFY-5316B Low 1).
#[test]
fn the_observer_marks_the_title_before_the_pull() {
    use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, ApplyObserver};

    use crate::sync::disk::DiskObserver;
    use crate::vault::consumer::VaultTier;

    let mut f = fixture();
    let id = f.writer.create("Untitled".into(), None).unwrap();
    f.seed(&id, "Untitled 1.md", "first words\n");
    f.writer
        .set_tags(id.clone(), vec!["remote".into()])
        .unwrap();
    let tier = VaultTier::new(f.store.clone());
    let observer = DiskObserver::new(tier, f.root.clone(), f.vault.clone());
    observer.records_applied(&[AppliedRecord {
        item_type: "note".into(),
        item_id: id.clone(),
        outcome: AppliedOutcome::Updated,
        conflicts: Vec::new(),
        title_before: Some("Untitled".into()),
    }]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(row_path(&f, &id), "Untitled 1.md");
    assert!(f.read("Untitled 1.md").contains("  - remote\n"));
}
