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
use memry_desktop::session::{OpenSource, OpenStage, Session};
use memry_desktop::vault::init::{CountLimits, count_markdown_files};
use memry_desktop::vault::layout::DEFAULT_EXCLUDE_PATTERNS;
use memry_desktop::vault::move_dir::{Step, move_dir_checked, simulated_hold};
use memry_desktop::vault::move_journal::{Sweep, sweep, sweep_checked};
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

/// The staging folders the open's note count finds, with the default exclude list (which
/// skips every name starting with `.memry`).
fn staged(vault: &Path) -> Vec<PathBuf> {
    let exclude: Vec<String> = DEFAULT_EXCLUDE_PATTERNS.map(str::to_owned).to_vec();
    count_markdown_files(vault, &exclude, CountLimits::DEFAULT).staging
}

/// The open's sweep: the journal, and the staging folders the note count found.
fn sweep_all(vault: &Path) -> Sweep {
    sweep(vault, &staged(vault))
}

/// Sweeps, killed at sweep step `kill_at`. Returns how many steps ran.
fn sweep_killed(vault: &Path, kill_at: Option<usize>) -> usize {
    let mut at = 0;
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        sweep_checked(vault, &staged(vault), &mut |_| {
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
        sweep_all(dir.path());
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
            sweep_all(probe.path());
            whole_at_one_end(&before, probe.path(), &format!("failed at {fail:?}"));
            for kill_at in fail_at + 1..=ran_here.max(ran) {
                let dir = vault();
                if !run(dir.path(), &fail, Some(kill_at)).1 {
                    continue; // this rollback took fewer steps
                }
                kills += 1;
                sweep_all(dir.path());
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
            sweep_all(dir.path());
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
    sweep_checked(root, &staged(root), &mut |step| match step {
        Step::PutBack { .. } => Err(refused()),
        _ => Ok(()),
    });
    assert_eq!(records(root).len(), 1, "files are still staged");
    sweep_all(root);
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
    let swept = sweep_all(root);
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
    let swept = sweep_all(root);
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
    let mut shown = swept.shown.clone();
    shown.sort();
    assert_eq!(
        shown,
        [
            root.join("Moved folder (incomplete move)"),
            root.join("archive/Moved folder (incomplete move 2)"),
        ]
    );
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// Only a folder named exactly `.memry-move-<12 hex>` outside dot and excluded folders is a
/// staging folder: a name off by a character, a file, a link and anything in a dot folder
/// (`.git` is excluded, `.foo` is not) or an excluded folder stay as they are.
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
        ".foo/.memry-move-0123456789ab",
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
    let swept = sweep_all(root);
    assert_eq!(tree(root), before);
    assert!(swept.shown.is_empty(), "{:?}", swept.shown);
    assert_eq!(
        fs::read_to_string(outside.path().join("o.md")).unwrap(),
        "outside"
    );
}

fn write_record(root: &Path, id: &str, json: &str) {
    fs::create_dir_all(root.join(".memry/moves")).unwrap();
    fs::write(root.join(format!(".memry/moves/{id}.json")), json).unwrap();
}

/// A record that leads out of the vault (by its source, its staging folder or the folder it
/// showed), or names a user's folder as its staging folder, moves nothing and is dropped: its
/// staging folder is only shown.
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
    // A record naming another move's staging folder.
    staging_with(&root.join("sub2"), "1a2b3c4d5e6f", "z.md");
    write_record(
        root,
        "0f0f0f0f0f0f",
        r#"{"version":1,"from":"other","staging":"sub2/.memry-move-1a2b3c4d5e6f"}"#,
    );
    fs::create_dir_all(root.join("sub/.memry-move-0a1b2c3d4e5f")).unwrap();
    fs::write(root.join("sub/.memry-move-0a1b2c3d4e5f/y.md"), "y").unwrap();
    write_record(
        root,
        "0a1b2c3d4e5f",
        &serde_json::json!({
            "version": 1,
            "from": "other",
            "staging": "sub/.memry-move-0a1b2c3d4e5f",
            "shown": escape,
        })
        .to_string(),
    );
    sweep_all(root);
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
    assert_eq!(
        after.get("sub/Moved folder (incomplete move)/y.md"),
        Some(&Some(b"y".to_vec())),
        "{after:?}"
    );
    assert!(!after.contains_key("other/y.md"), "{after:?}");
    assert_eq!(
        after.get("sub2/Moved folder (incomplete move)/z.md"),
        Some(&Some(b"z.md".to_vec())),
        "{after:?}"
    );
    assert!(!after.contains_key("other/z.md"), "{after:?}");
    assert!(
        !after
            .keys()
            .any(|rel| rel.split('/').any(|name| name.starts_with('.'))),
        "{after:?}"
    );
}

/// A record a newer build wrote is that build's to act on: its staging folder is only renamed
/// into sight, so the notes are not hidden, and the record stays.
#[test]
fn a_record_of_a_newer_version_only_gets_its_folder_shown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join(".memry-move-0123456789ab")).unwrap();
    fs::write(root.join(".memry-move-0123456789ab/x.md"), "x").unwrap();
    let newer = r#"{"version":2,"from":"notes","staging":".memry-move-0123456789ab"}"#;
    write_record(root, "0123456789ab", newer);
    let swept = sweep_all(root);
    let after = tree(root);
    assert_eq!(
        after.get("Moved folder (incomplete move)/x.md"),
        Some(&Some(b"x".to_vec())),
        "{after:?}"
    );
    assert!(!after.contains_key("notes"), "{after:?}");
    assert_eq!(swept.shown, [root.join("Moved folder (incomplete move)")]);
    let kept = fs::read_to_string(root.join(".memry/moves/0123456789ab.json"));
    assert_eq!(
        kept.ok().as_deref(),
        Some(newer),
        "the newer build's record changed"
    );
}

/// A sweep while a move runs in this process (a vault closed and opened again mid-move)
/// leaves that move alone, also when it cannot list the journal, and the move ends whole.
#[test]
fn a_sweep_leaves_a_move_in_flight_alone() {
    let dir = vault();
    let root = dir.path();
    let before = tree(root);
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let mut swept = Vec::new();
    move_dir_checked(
        root,
        &root.join("notes"),
        &root.join("moved"),
        &mut |step| {
            if swept.is_empty() && matches!(step, Step::Entry { from, .. } if from.ends_with("sub"))
            {
                swept.push(sweep_all(root));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let journal = root.join(".memry/moves");
                    fs::set_permissions(&journal, fs::Permissions::from_mode(0o000)).unwrap();
                    swept.push(sweep_all(root));
                    fs::set_permissions(&journal, fs::Permissions::from_mode(0o755)).unwrap();
                }
            }
            windows(step)
        },
    )
    .unwrap();
    assert!(!swept.is_empty(), "the move went entry by entry");
    for swept in swept {
        assert!(!swept.changed(), "{swept:?}");
    }
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

/// An open whose sweep could not put every note back under its name says so in the status the
/// renderer reads after it subscribes (an event before the window exists is lost).
#[test]
fn an_open_that_keeps_both_copies_says_so_in_its_status() {
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
    let opened = session.open(root, OpenSource::Select).unwrap();
    let notice = session
        .status()
        .moves_recovered
        .expect("the status carries the notice");
    assert_eq!(
        (
            notice.undone,
            notice.conflict_copies,
            notice.kept_folders,
            notice.shown_folders
        ),
        (1, 1, 0, 0)
    );
    // The open counted the notes it put back: the five and the conflict copy (the staged ones
    // were not counted before the sweep).
    assert_eq!(opened.stored.as_ref().map(|s| s.note_count), Some(6));
    assert_eq!(
        fs::read(root.join(format!("notes/{stem} (conflict copy).md"))).unwrap(),
        text
    );
    drop(opened);
    session.close();
}

/// An Electron move's leftovers are shown, never called undone, and a vault with nothing to
/// sweep has no notice.
#[test]
fn an_open_that_only_showed_leftovers_says_nothing_was_undone() {
    let dir = vault();
    let root = dir.path();
    fs::create_dir(root.join(".memry-move-0123456789ab")).unwrap();
    fs::write(root.join(".memry-move-0123456789ab/x.md"), "x").unwrap();
    let app = tempfile::tempdir().unwrap();
    let session = session(app.path());
    let opened = session.open(root, OpenSource::Select).unwrap();
    let notice = session
        .status()
        .moves_recovered
        .expect("the status carries the notice");
    assert_eq!(
        (
            notice.undone,
            notice.conflict_copies,
            notice.kept_folders,
            notice.shown_folders
        ),
        (0, 0, 0, 1)
    );
    drop(opened);
    session.close();
    let opened = session.open(root, OpenSource::Select).unwrap();
    assert_eq!(session.status().moves_recovered, None, "nothing to sweep");
    drop(opened);
    session.close();
}

/// The note count finds an exact staging folder even though the exclude list skips every name
/// starting with `.memry`, and never one inside a dot or excluded folder.
#[test]
fn the_note_count_finds_staging_folders_its_excludes_would_skip() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for folder in [
        ".memry-move-0123456789ab",
        "a/b/.memry-move-abcdef012345",
        ".foo/.memry-move-fedcba987654",
        "node_modules/.memry-move-fedcba987650",
        ".memry-move-0123456789ab/.memry-move-0123456789ac",
    ] {
        fs::create_dir_all(root.join(folder)).unwrap();
    }
    let mut found = staged(root);
    found.sort();
    assert_eq!(
        found,
        [
            root.join(".memry-move-0123456789ab"),
            root.join("a/b/.memry-move-abcdef012345"),
        ]
    );
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    let made = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(made.success());
}

fn staging_with(root: &Path, id: &str, file: &str) {
    let staging = root.join(format!(".memry-move-{id}"));
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join(file), file).unwrap();
}

/// A record is read bounded, as a regular file under the vault: a FIFO, a link (to a record
/// outside or inside the vault, or to `/dev/zero`) or a folder named as a record is never read
/// through, and its staging folder is only shown. The FIFO and the links go; their targets
/// stay.
#[cfg(unix)]
#[test]
fn a_record_that_is_no_regular_file_is_never_read_through() {
    let outside = tempfile::tempdir().unwrap();
    let dir = vault();
    let root = dir.path();
    fs::create_dir_all(root.join(".memry/moves")).unwrap();
    staging_with(root, "0123456789ab", "fifo.md");
    mkfifo(&root.join(".memry/moves/0123456789ab.json"));
    staging_with(root, "abcdef012345", "link.md");
    let elsewhere = outside.path().join("record.json");
    fs::write(
        &elsewhere,
        r#"{"version":1,"from":"notes","staging":".memry-move-abcdef012345"}"#,
    )
    .unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join(".memry/moves/abcdef012345.json")).unwrap();
    staging_with(root, "0a0a0a0a0a0a", "zero.md");
    std::os::unix::fs::symlink("/dev/zero", root.join(".memry/moves/0a0a0a0a0a0a.json")).unwrap();
    staging_with(root, "0b0b0b0b0b0b", "inner.md");
    let inside = root.join("notes/record.json");
    let record = r#"{"version":1,"from":"notes","staging":".memry-move-0b0b0b0b0b0b"}"#;
    fs::write(&inside, record).unwrap();
    std::os::unix::fs::symlink(&inside, root.join(".memry/moves/0b0b0b0b0b0b.json")).unwrap();
    staging_with(root, "fedcba987654", "folder.md");
    fs::create_dir(root.join(".memry/moves/fedcba987654.json")).unwrap();
    let swept = sweep_all(root);
    assert_eq!(swept.undone, 0);
    assert_eq!(swept.shown.len(), 5, "{:?}", swept.shown);
    assert!(
        !root.join("notes/inner.md").exists(),
        "read the linked record"
    );
    assert_eq!(fs::read_to_string(&inside).unwrap(), record);
    let after = tree(root);
    assert!(
        !after.contains_key("notes/link.md"),
        "followed the link: {after:?}"
    );
    assert!(!after.keys().any(|rel| rel.starts_with('.')), "{after:?}");
    assert!(fs::read(&elsewhere).is_ok_and(|bytes| !bytes.is_empty()));
    let mut left: Vec<_> = records(root)
        .into_iter()
        .map(|p| p.file_name().unwrap().to_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["fedcba987654.json"], "the FIFO or a link stayed");
}

/// A record over 4 KiB is not a record: it is not read whole, and its folder is only shown.
#[test]
fn an_oversized_record_is_not_read_whole() {
    let dir = vault();
    let root = dir.path();
    staging_with(root, "0123456789ab", "big.md");
    let mut padded = " ".repeat(1 << 20);
    padded.push_str(r#"{"version":1,"from":"notes","staging":".memry-move-0123456789ab"}"#);
    write_record(root, "0123456789ab", &padded);
    let swept = sweep_all(root);
    assert!(
        !root.join("notes/big.md").exists(),
        "read the oversized record"
    );
    assert_eq!(swept.shown.len(), 1, "{:?}", swept.shown);
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// A journal folder that is a link (to a folder out of the vault or in it), or that leads out
/// of the vault through a linked `.memry`, is neither read nor written: the sweep only shows
/// the staging folder, and a move refuses before anything moves.
#[cfg(unix)]
#[test]
fn a_linked_journal_folder_is_neither_read_nor_written() {
    let record = r#"{"version":1,"from":"notes","staging":".memry-move-0123456789ab"}"#;
    for layout in ["journal out", "journal in", "app folder out"] {
        let outside = tempfile::tempdir().unwrap();
        let dir = vault();
        let root = dir.path();
        let target = match layout {
            "journal out" => outside.path().to_owned(),
            "journal in" => root.join("journal"),
            _ => outside.path().join("moves"),
        };
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("0123456789ab.json"), record).unwrap();
        if layout == "app folder out" {
            std::os::unix::fs::symlink(outside.path(), root.join(".memry")).unwrap();
        } else {
            fs::create_dir(root.join(".memry")).unwrap();
            std::os::unix::fs::symlink(&target, root.join(".memry/moves")).unwrap();
        }
        staging_with(root, "0123456789ab", "x.md");
        let swept = sweep_all(root);
        assert!(
            !root.join("notes/x.md").exists(),
            "{layout}: read the journal"
        );
        assert_eq!(swept.shown.len(), 1, "{layout}: {:?}", swept.shown);

        let before = tree(root);
        let mut seen = Vec::new();
        let error = move_dir_checked(
            root,
            &root.join("notes"),
            &root.join("moved"),
            &mut as_windows_holds(&mut seen),
        )
        .unwrap_err();
        assert_eq!(
            error.kind(),
            io::ErrorKind::InvalidData,
            "{layout}: {error}"
        );
        assert_eq!(tree(root), before, "{layout}");
        let written = fs::read_dir(&target).unwrap().count();
        assert_eq!(written, 1, "{layout}: wrote to the journal");
    }
}

/// A record whose source sits in its own staging folder or in the app's folder (any letter
/// case) puts nothing back there: its folder is only shown, and the record goes.
#[test]
fn a_record_never_puts_back_into_its_staging_folder_or_the_app_folder() {
    let dir = vault();
    let root = dir.path();
    fs::create_dir_all(root.join(".memry/core")).unwrap();
    for (id, from) in [
        ("0123456789ab", ".memry/core"),
        ("abcdef012345", ".Memry/core"),
        ("fedcba987654", ".memry-move-fedcba987654/sub"),
    ] {
        staging_with(root, id, &format!("{id}.md"));
        write_record(
            root,
            id,
            &serde_json::json!({"version": 1, "from": from, "staging": format!(".memry-move-{id}")})
                .to_string(),
        );
    }
    let swept = sweep_all(root);
    assert_eq!(swept.undone, 0);
    assert_eq!(swept.shown.len(), 3, "{:?}", swept.shown);
    assert!(
        fs::read_dir(root.join(".memry/core"))
            .unwrap()
            .next()
            .is_none()
    );
    let after = tree(root);
    assert!(!after.keys().any(|rel| rel.starts_with('.')), "{after:?}");
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// A record the sweep cannot check now (a folder on its path refuses to be read) is kept for a
/// later open, not dropped as one that leads elsewhere; its folder is shown meanwhile.
#[cfg(unix)]
#[test]
fn a_record_that_cannot_be_checked_now_is_kept() {
    use std::os::unix::fs::PermissionsExt;
    let dir = vault();
    let root = dir.path();
    fs::create_dir_all(root.join("locked/notes")).unwrap();
    staging_with(root, "0123456789ab", "x.md");
    write_record(
        root,
        "0123456789ab",
        r#"{"version":1,"from":"locked/notes","staging":".memry-move-0123456789ab"}"#,
    );
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::read_dir(root.join("locked")).is_ok(); // root reads it anyway
    let swept = sweep_all(root);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        return;
    }
    assert_eq!(swept.shown.len(), 1, "{:?}", swept.shown);
    assert_eq!(
        records(root).len(),
        1,
        "a record that could not be checked was dropped"
    );
}

/// A sweep killed right after it renamed a folder into sight still reports that folder at the
/// next sweep: the record names the folder before anything moves into it.
#[test]
fn a_sweep_killed_while_showing_still_reports_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    staging_with(root, "0123456789ab", "x.md");
    let mut at = 0;
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        sweep_checked(root, &staged(root), &mut |step| {
            at += 1;
            if matches!(step, Step::Forget(_)) {
                kill();
            }
            Ok(())
        })
    })));
    assert!(killed, "the show dropped no record ({at} steps)");
    assert!(root.join("Moved folder (incomplete move)/x.md").exists());
    let swept = sweep_all(root);
    assert_eq!(swept.shown, [root.join("Moved folder (incomplete move)")]);
    assert_eq!(records(root), Vec::<PathBuf>::new());

    // A journaled move whose sweep kept a file in sight, killed before the record's drop.
    let dir = vault();
    let root = dir.path();
    let (_, steps) = clean_run();
    assert!(run(root, &[], Some(steps - 1)).1);
    let mut first = true;
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        sweep_checked(root, &staged(root), &mut |step| match step {
            Step::PutBack { .. } if first => {
                first = false;
                Err(io::Error::other("refused"))
            }
            Step::Forget(_) => kill(),
            _ => Ok(()),
        })
    })));
    assert!(killed);
    let swept = sweep_all(root);
    assert_eq!(swept.kept, [root.join("notes (incomplete move)")]);
    assert_eq!(records(root), Vec::<PathBuf>::new());

    // A move whose own rollback put its files in sight, killed before the record's drop.
    let dir = vault();
    let root = dir.path();
    let notes = root.join("notes");
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        move_dir_checked(root, &notes, &root.join("moved"), &mut |step| match step {
            Step::Entry { from, .. } if from.ends_with("sub") => {
                Err(io::Error::other("the disk went away"))
            }
            Step::PutBack { to, .. } if to.starts_with(&notes) => Err(io::Error::other("refused")),
            Step::Forget(_) => kill(),
            _ => windows(step),
        })
    })));
    assert!(killed);
    let swept = sweep_all(root);
    assert_eq!(swept.kept, [root.join("notes (incomplete move)")]);
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// A show that leaves a file in the staging folder keeps its record: the next sweep shows the
/// rest, reports both folders, and drops it.
#[test]
fn a_show_that_leaves_a_file_staged_keeps_its_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    staging_with(root, "0123456789ab", "x.md");
    fs::write(root.join(".memry-move-0123456789ab/y.md"), "y").unwrap();
    let swept = sweep_checked(root, &staged(root), &mut |step| match step {
        // Windows holds the folder, and then a file in it.
        Step::PutBack { from, .. } if from.ends_with(".memry-move-0123456789ab") => {
            Err(simulated_hold())
        }
        Step::PutBack { from, .. } if from.ends_with("x.md") => Err(io::Error::other("held")),
        _ => Ok(()),
    });
    let first = root.join("Moved folder (incomplete move)");
    assert!(first.join("y.md").exists());
    assert!(root.join(".memry-move-0123456789ab/x.md").exists());
    assert!(swept.shown.contains(&first), "{:?}", swept.shown);
    assert_eq!(
        records(root).len(),
        1,
        "the record went though x.md is staged"
    );

    let swept = sweep_all(root);
    let second = root.join("Moved folder (incomplete move 2)");
    let mut shown = swept.shown.clone();
    let mut both = vec![first, second.clone()];
    shown.sort();
    both.sort();
    assert_eq!(shown, both);
    assert!(second.join("x.md").exists());
    assert_eq!(records(root), Vec::<PathBuf>::new());
}

/// A vault named in the verbatim form (`\\?\C:\...`) is swept: a record's `/`-separated paths
/// are joined one name at a time.
#[cfg(windows)]
#[test]
fn a_vault_named_in_the_verbatim_form_is_swept() {
    let dir = vault();
    let before = tree(dir.path());
    fs::create_dir(dir.path().join("archive")).unwrap();
    let root = PathBuf::from(format!(r"\\?\{}", dir.path().display()));
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let killed = was_killed(catch_unwind(AssertUnwindSafe(|| {
        move_dir_checked(
            &root,
            &root.join("notes"),
            &root.join("archive").join("moved"),
            &mut |step| {
                if matches!(step, Step::Entry { from, .. } if from.ends_with("sub")) {
                    kill();
                }
                windows(step)
            },
        )
    })));
    assert!(killed);
    sweep_all(&root);
    let mut after = tree(dir.path());
    after.remove("archive");
    assert_eq!(after, before);
    assert_eq!(records(dir.path()), Vec::<PathBuf>::new());
}
