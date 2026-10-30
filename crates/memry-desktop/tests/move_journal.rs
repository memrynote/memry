//! `vault::move_journal` on real folders. A folder move killed at any step, of the move, of its
//! rollback or of the sweep itself, is whole at one end after the next sweep: every file at its
//! path under the target, or back under the source or in sight beside it, nothing hidden and
//! no record left. The sweep runs at open before any open hook, so before the watcher, and
//! touches nothing but a journaled move's folders and folders named exactly
//! `.memry-move-<12 hex>`.

mod move_tree;

use std::any::Any;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenStage, Session, SessionEvent};
use memry_desktop::vault::move_dir::{Step, move_dir_checked};
use memry_desktop::vault::move_journal::{sweep, sweep_checked};
use move_tree::{Tree, as_windows_holds, back_or_kept, is_staging, moved, tree, vault};

/// The payload of a kill.
struct Killed;

/// Stops a move or a sweep where it stands, as a crash does: nothing after it runs, no
/// rollback. `resume_unwind` skips the panic hook, so a kill prints nothing.
fn kill() -> ! {
    resume_unwind(Box::new(Killed))
}

fn was_killed<T>(result: Result<T, Box<dyn Any + Send>>) -> bool {
    match result {
        Ok(_) => false,
        Err(payload) if payload.is::<Killed>() => true,
        Err(payload) => resume_unwind(payload),
    }
}

/// The move journal's records in the vault.
fn records(vault: &Path) -> Vec<PathBuf> {
    match fs::read_dir(vault.join(".memry/moves")) {
        Ok(entries) => entries.map(|entry| entry.unwrap().path()).collect(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("{error}"),
    }
}

/// Every file of `before` at its path under `moved/`, or every one back under `notes/` or in
/// sight beside it ([`back_or_kept`]). Nothing hidden, no record.
fn whole_at_one_end(before: &Tree, vault: &Path, at: &str) {
    let after = tree(vault);
    if after != moved(before, "moved") {
        catch_unwind(|| back_or_kept(before, &after)).unwrap_or_else(|_| panic!("{at}"));
    }
    assert_eq!(records(vault), Vec::<PathBuf>::new(), "{at}");
}

/// Moves `notes` to `moved` as Windows moves it with `notes/held` held, failing the steps
/// numbered in `fail` with a disk error and killing the move at step `kill_at` (from 1, the
/// rollback's steps included). Returns how many steps ran and whether it was killed.
fn run(vault: &Path, fail: &[usize], kill_at: Option<usize>) -> (usize, bool) {
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let mut at = 0;
    let result = catch_unwind(AssertUnwindSafe(|| {
        move_dir_checked(
            vault,
            &vault.join("notes"),
            &vault.join("moved"),
            &mut |step| {
                at += 1;
                if Some(at) == kill_at {
                    kill();
                }
                if fail.contains(&at) {
                    return Err(io::Error::other("the disk went away"));
                }
                windows(step)
            },
        )
    }));
    (at, was_killed(result))
}

/// Sweeps, killed at sweep step `kill_at`. Returns how many steps ran.
fn sweep_killed(vault: &Path, kill_at: Option<usize>) -> usize {
    let mut at = 0;
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        sweep_checked(vault, &[], &mut |_| {
            at += 1;
            if Some(at) == kill_at {
                kill();
            }
            Ok(())
        })
    })));
    assert_eq!(killed, kill_at.is_some(), "sweep step {kill_at:?} of {at}");
    at
}

/// The steps of a move that runs through, the drop of its record the last.
fn clean_run() -> (Tree, usize) {
    let dir = vault();
    let before = tree(dir.path());
    let (steps, _) = run(dir.path(), &[], None);
    assert_eq!(tree(dir.path()), moved(&before, "moved"));
    assert_eq!(
        records(dir.path()),
        Vec::<PathBuf>::new(),
        "a done move kept its record"
    );
    (before, steps)
}

#[test]
fn a_move_killed_at_any_step_is_whole_at_one_end_after_the_sweep() {
    let (before, steps) = clean_run();
    for kill_at in 1..=steps {
        let dir = vault();
        assert!(run(dir.path(), &[], Some(kill_at)).1, "step {kill_at}");
        sweep(dir.path(), &[]);
        whole_at_one_end(&before, dir.path(), &format!("killed at step {kill_at}"));
    }
}

/// A move that fails at a step rolls back; killed at any step of that rollback, plain or one
/// whose first put-back fails too (so what is left goes into the visible folder), it is
/// whole after the sweep.
#[test]
fn a_rollback_killed_at_any_step_is_whole_after_the_sweep() {
    let (before, steps) = clean_run();
    let mut kills = 0;
    // From the staging folder's making to the rename to the target: the drop of the record
    // (the last step) fails nothing.
    for fail_at in 2..steps {
        let probe = vault();
        let (ran, _) = run(probe.path(), &[fail_at], None);
        assert_eq!(tree(probe.path()), before, "failed at {fail_at}");
        assert_eq!(
            records(probe.path()),
            Vec::<PathBuf>::new(),
            "an undone move kept its record (failed at {fail_at})"
        );
        for fail in [vec![fail_at], vec![fail_at, fail_at + 1]] {
            let probe = vault();
            let (ran_here, _) = run(probe.path(), &fail, None);
            sweep(probe.path(), &[]);
            whole_at_one_end(&before, probe.path(), &format!("failed at {fail:?}"));
            for kill_at in fail_at + 1..=ran_here.max(ran) {
                let dir = vault();
                if !run(dir.path(), &fail, Some(kill_at)).1 {
                    continue; // this rollback took fewer steps
                }
                kills += 1;
                sweep(dir.path(), &[]);
                whole_at_one_end(
                    &before,
                    dir.path(),
                    &format!("failed at {fail:?}, killed at {kill_at}"),
                );
            }
        }
    }
    // Every forward step fails once, and each rollback has steps to kill.
    assert!(kills > 4 * steps, "only {kills} kills for {steps} steps");
}

#[test]
fn a_sweep_killed_at_any_step_is_finished_by_the_next() {
    let (before, steps) = clean_run();
    let mut kills = 0;
    for kill_at in 1..=steps {
        let probe = vault();
        run(probe.path(), &[], Some(kill_at));
        let sweep_steps = sweep_killed(probe.path(), None);
        kills += sweep_steps;
        for sweep_kill in 1..=sweep_steps {
            let dir = vault();
            run(dir.path(), &[], Some(kill_at));
            sweep_killed(dir.path(), Some(sweep_kill));
            sweep(dir.path(), &[]);
            whole_at_one_end(
                &before,
                dir.path(),
                &format!("move killed at {kill_at}, sweep killed at {sweep_kill}"),
            );
        }
    }
    // A move killed midway leaves several entries staged, each a put-back to kill.
    assert!(
        kills > 2 * steps,
        "only {kills} sweep kills for {steps} steps"
    );
}

/// A move whose rollback cannot even move what is left into a visible folder keeps its record,
/// and so does a sweep refused the same way; the next sweep puts everything back.
#[test]
fn files_left_staged_keep_their_record_until_a_sweep_puts_them_back() {
    let dir = vault();
    let root = dir.path();
    let before = tree(root);
    let refused = || io::Error::other("refused");
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    move_dir_checked(
        root,
        &root.join("notes"),
        &root.join("moved"),
        &mut |step| match step {
            Step::Entry { from, .. } if is_staging(from) => Err(refused()),
            Step::PutBack { .. } => Err(refused()),
            _ => windows(step),
        },
    )
    .unwrap_err();
    assert_eq!(records(root).len(), 1, "files are staged");
    sweep_checked(root, &[], &mut |step| match step {
        Step::PutBack { .. } => Err(refused()),
        _ => Ok(()),
    });
    assert_eq!(records(root).len(), 1, "files are still staged");
    sweep(root, &[]);
    whole_at_one_end(&before, root, "swept");
    assert_eq!(tree(root), before);
}

/// A file saved at a moved note's path after the crash keeps its name; the note comes back
/// beside it, and the sweep says so.
#[test]
fn a_name_taken_after_the_crash_keeps_both_files() {
    let (_, steps) = clean_run();
    let dir = vault();
    let root = dir.path();
    // Killed at the staging folder's rename to the target: every file is staged, `notes` gone.
    assert!(run(root, &[], Some(steps - 1)).1);
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(root.join("notes/a.md"), "saved after the crash").unwrap();
    let swept = sweep(root, &[]);
    assert_eq!(
        fs::read_to_string(root.join("notes/a.md")).unwrap(),
        "saved after the crash"
    );
    assert_eq!(
        fs::read_to_string(root.join("notes/a (conflict copy).md")).unwrap(),
        "a"
    );
    assert_eq!(swept.undone, 1);
    assert_eq!(
        swept.conflict_copies,
        [root.join("notes/a (conflict copy).md")]
    );
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// A staging folder with no record (Electron's) or an unreadable one cannot be put back, so it
/// is renamed to a visible folder, never deleted.
#[test]
fn a_staging_folder_with_no_record_is_shown_and_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for (rel, text) in [
        (".memry-move-0123456789ab/x.md", "x"),
        ("archive/.memry-move-abcdef012345/sub/y.md", "y"),
        ("archive/Moved folder (incomplete move)/z.md", "z"),
    ] {
        fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        fs::write(root.join(rel), text).unwrap();
    }
    write_record(root, "0123456789ab", "not a record");
    let swept = sweep(root, &[]);
    let want: Tree = [
        ("Moved folder (incomplete move)", None),
        ("Moved folder (incomplete move)/x.md", Some("x")),
        ("archive", None),
        ("archive/Moved folder (incomplete move)", None),
        ("archive/Moved folder (incomplete move)/z.md", Some("z")),
        ("archive/Moved folder (incomplete move 2)", None),
        ("archive/Moved folder (incomplete move 2)/sub", None),
        (
            "archive/Moved folder (incomplete move 2)/sub/y.md",
            Some("y"),
        ),
    ]
    .into_iter()
    .map(|(rel, text)| (rel.to_owned(), text.map(|t| t.as_bytes().to_vec())))
    .collect();
    assert_eq!(tree(root), want);
    let mut kept = swept.kept.clone();
    kept.sort();
    assert_eq!(
        kept,
        [
            root.join("Moved folder (incomplete move)"),
            root.join("archive/Moved folder (incomplete move 2)"),
        ]
    );
}

/// Only a folder named exactly `.memry-move-<12 hex>` outside dot and excluded folders is a
/// staging folder: a name off by a character, a file, a link and anything in `.git` or an
/// excluded folder stay as they are.
#[test]
fn the_sweep_touches_no_folder_but_an_exact_staging_name() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("o.md"), "outside").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for folder in [
        ".memry-move-0123456789a",
        ".memry-move-0123456789abc",
        ".memry-move-0123456789AB",
        ".memry-move-0123456789ag",
        "memry-move-0123456789ab",
        ".memry-move-0123456789ab (1)",
        ".git/.memry-move-0123456789ab",
        "node_modules/.memry-move-0123456789ab",
    ] {
        fs::create_dir_all(root.join(folder)).unwrap();
        fs::write(root.join(folder).join("n.md"), folder).unwrap();
    }
    fs::create_dir(root.join("files")).unwrap();
    fs::write(root.join("files/.memry-move-0123456789ab"), "a file").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.join(".memry-move-abcdef012345")).unwrap();
    let before = tree(root);
    let swept = sweep(root, &["node_modules".to_owned()]);
    assert_eq!(tree(root), before);
    assert!(swept.kept.is_empty(), "{:?}", swept.kept);
    assert_eq!(
        fs::read_to_string(outside.path().join("o.md")).unwrap(),
        "outside"
    );
}

fn write_record(root: &Path, id: &str, json: &str) {
    fs::create_dir_all(root.join(".memry/moves")).unwrap();
    fs::write(root.join(format!(".memry/moves/{id}.json")), json).unwrap();
}

/// A record that leads out of the vault, or names a user's folder as its staging folder,
/// moves nothing and is dropped: its staging folder is only shown.
#[test]
fn a_record_never_leads_the_sweep_out_of_the_vault_or_into_a_users_folder() {
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(outside.path().join("victim")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let escape = format!(
        "{}/victim",
        "../".repeat(root.components().count()) + &outside.path().to_string_lossy()
    );
    fs::create_dir_all(root.join(".memry-move-0123456789ab")).unwrap();
    fs::write(root.join(".memry-move-0123456789ab/x.md"), "x").unwrap();
    write_record(
        root,
        "0123456789ab",
        &serde_json::json!({"version": 1, "from": escape, "staging": ".memry-move-0123456789ab"})
            .to_string(),
    );
    for (rel, text) in [("mine/m.md", "m"), ("other/o.md", "o")] {
        fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        fs::write(root.join(rel), text).unwrap();
    }
    write_record(
        root,
        "abcdef012345",
        r#"{"version":1,"from":"other","staging":"mine"}"#,
    );
    let theirs = outside.path().join(".memry-move-fedcba987654");
    fs::create_dir(&theirs).unwrap();
    fs::write(theirs.join("t.md"), "t").unwrap();
    write_record(
        root,
        "fedcba987654",
        &serde_json::json!({
            "version": 1,
            "from": "other",
            "staging": format!("{}/.memry-move-fedcba987654", escape.trim_end_matches("/victim")),
        })
        .to_string(),
    );
    sweep(root, &[]);
    assert_eq!(
        fs::read_dir(outside.path().join("victim")).unwrap().count(),
        0
    );
    assert_eq!(fs::read_to_string(theirs.join("t.md")).unwrap(), "t");
    assert_eq!(
        records(root),
        Vec::<PathBuf>::new(),
        "a record that leads elsewhere stayed"
    );
    let after = tree(root);
    assert_eq!(
        after.get("mine/m.md"),
        Some(&Some(b"m".to_vec())),
        "{after:?}"
    );
    assert_eq!(
        after.get("other/o.md"),
        Some(&Some(b"o".to_vec())),
        "{after:?}"
    );
    assert_eq!(
        after.get("Moved folder (incomplete move)/x.md"),
        Some(&Some(b"x".to_vec())),
        "{after:?}"
    );
    assert!(!after.keys().any(|rel| rel.starts_with('.')), "{after:?}");
}

/// A record a newer build wrote is that build's to sweep: it and its staging folder stay.
#[test]
fn a_record_of_a_newer_version_and_its_folder_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join(".memry-move-0123456789ab")).unwrap();
    fs::write(root.join(".memry-move-0123456789ab/x.md"), "x").unwrap();
    write_record(
        root,
        "0123456789ab",
        r#"{"version":2,"from":"notes","staging":".memry-move-0123456789ab"}"#,
    );
    let before = tree(root);
    sweep(root, &[]);
    assert_eq!(tree(root), before);
    assert_eq!(records(root).len(), 1);
}

/// A sweep while a move runs in this process (a vault closed and opened again mid-move)
/// leaves that move alone, and the move ends whole.
#[test]
fn a_sweep_leaves_a_move_in_flight_alone() {
    let dir = vault();
    let root = dir.path();
    let before = tree(root);
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let mut swept = None;
    move_dir_checked(
        root,
        &root.join("notes"),
        &root.join("moved"),
        &mut |step| {
            if swept.is_none() && matches!(step, Step::Entry { from, .. } if from.ends_with("sub"))
            {
                swept = Some(sweep(root, &[]));
            }
            windows(step)
        },
    )
    .unwrap();
    let swept = swept.expect("the move went entry by entry");
    assert_eq!(swept.undone, 0);
    assert!(swept.kept.is_empty(), "{:?}", swept.kept);
    assert_eq!(tree(root), moved(&before, "moved"));
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

fn session(app: &Path) -> Session {
    fs::create_dir_all(app).unwrap();
    Session::new(VaultRegistry::new(Arc::new(AppConfig::load(
        app.join("memry-config.json"),
    ))))
}

/// Killed once two files are in the hidden staging folder.
fn crash_mid_move(root: &Path) {
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        move_dir_checked(
            root,
            &root.join("notes"),
            &root.join("moved"),
            &mut |step| {
                if matches!(step, Step::Entry { from, .. } if from.ends_with("sub")) {
                    kill();
                }
                windows(step)
            },
        )
    })));
    assert!(killed);
}

/// The watcher starts at `OpenStage::Watcher`; the open puts an interrupted move back before
/// the first open hook, so no hook sees a moved note's file missing.
#[test]
fn the_open_puts_an_interrupted_move_back_before_any_open_hook_runs() {
    let dir = vault();
    let root = dir.path();
    let before = tree(root);
    crash_mid_move(root);
    assert_ne!(tree(root), before, "the crash hid no file");
    let app = tempfile::tempdir().unwrap();
    let session = session(app.path());
    let seen: Arc<Mutex<Option<Tree>>> = Arc::default();
    let at_open = seen.clone();
    session.on_open(
        "observe",
        OpenStage::Settings,
        Arc::new(move |view| {
            *at_open.lock().unwrap() = Some(tree(&view.path));
            Ok(())
        }),
    );
    let opened = session.open(root, OpenSource::Select).unwrap();
    // The open makes the default folders; the notes are what the move touched.
    let mut at_first_hook = seen.lock().unwrap().clone().expect("the hook ran");
    at_first_hook.retain(|rel, _| !rel.starts_with("attachments") && !rel.starts_with("journal"));
    assert_eq!(at_first_hook, before);
    drop(opened);
    session.close();
}

/// An open whose sweep could not put every note back under its name tells the user.
#[test]
fn an_open_that_keeps_both_copies_says_so() {
    let dir = vault();
    let root = dir.path();
    crash_mid_move(root);
    // A note the crash left staged (which ones depends on the folder's listing order).
    let staging = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".memry-move-")
        })
        .expect("the crash left a staging folder");
    let staged = fs::read_dir(&staging)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .find(|name| name.ends_with(".md"))
        .expect("a note was staged");
    let stem = staged.trim_end_matches(".md");
    let text = fs::read(staging.join(&staged)).unwrap();
    fs::write(root.join("notes").join(&staged), "saved after the crash").unwrap();
    let app = tempfile::tempdir().unwrap();
    let session = session(app.path());
    let events = session.subscribe();
    let opened = session.open(root, OpenSource::Select).unwrap();
    let said: Vec<String> = events
        .try_iter()
        .filter_map(|event| match event {
            SessionEvent::Error { message } => Some(message),
            _ => None,
        })
        .collect();
    assert!(said.iter().any(|m| m.contains("conflict copy")), "{said:?}");
    assert_eq!(
        fs::read(root.join(format!("notes/{stem} (conflict copy).md"))).unwrap(),
        text
    );
    drop(opened);
    session.close();
}
