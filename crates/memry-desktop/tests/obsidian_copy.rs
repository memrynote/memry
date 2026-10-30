//! The Obsidian open-as-copy on real folders (`obsidian-vault-copy.test.ts`): which folders are
//! asked about, the four decisions, where the copy goes, what it holds and leaves out, and that
//! a failed copy leaves nothing and never takes the place of anything.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use memry_desktop::vault::obsidian_copy::{
    Choice, CopyTarget, MAX_OPEN_DIRS, ObsidianOpenDecision, copy_vault, resolve_obsidian_open,
    take_open_dirs_peak,
};
use memry_test_kit::on_small_stack;

/// 2024-03-01T09:00:00Z, the date the files were last modified.
const OLD: Duration = Duration::from_secs(1_709_283_600);

const VAULT_FILES: [(&str, &str); 10] = [
    ("Tasks.md", "- [ ] #task Renew passport 📅 2026-11-01\n"),
    ("Daily Notes/2026-10-20.md", "# 2026-10-20\n"),
    ("attachments/photo.png", "png bytes"),
    (".hidden.md", "a dot note of the user's\n"),
    ("Projects/.git/HEAD", "ref: refs/heads/side\n"),
    ("Projects/.obsidian/app.json", "{\"nested\":true}"),
    (".obsidian/app.json", "{}"),
    (
        ".obsidian/plugins/obsidian-tasks-plugin/data.json",
        "{\"globalFilter\":\"#task\"}",
    ),
    (".trash/old.md", "deleted in Obsidian"),
    (".git/HEAD", "ref: refs/heads/main\n"),
];

/// What a copy holds: everything but the top-level `.obsidian`, `.trash` and `.git`.
const COPIED: [&str; 6] = [
    "Tasks.md",
    "Daily Notes/2026-10-20.md",
    "attachments/photo.png",
    ".hidden.md",
    "Projects/.git/HEAD",
    "Projects/.obsidian/app.json",
];

fn write_tree(dir: &Path, files: &[(&str, &str)]) {
    for (relative, text) in files {
        let file = dir.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, text).unwrap();
        set_old(&file);
    }
}

fn set_old(file: &Path) {
    let old = UNIX_EPOCH + OLD;
    fs::File::options()
        .write(true)
        .open(file)
        .unwrap()
        .set_times(fs::FileTimes::new().set_accessed(old).set_modified(old))
        .unwrap();
}

fn obsidian_vault(root: &Path) -> PathBuf {
    let vault = root.join("My Vault");
    write_tree(&vault, &VAULT_FILES);
    vault
}

/// Every file and link under `dir`, dot folders included: a file's bytes and modified time, a
/// link's target. Links are not followed.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(folder) = stack.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path
                .strip_prefix(dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let kind = entry.file_type().unwrap();
            if kind.is_symlink() {
                out.insert(
                    rel,
                    format!("link:{}", fs::read_link(&path).unwrap().display()),
                );
            } else if kind.is_dir() {
                stack.push(path);
            } else {
                let modified = fs::metadata(&path)
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(UNIX_EPOCH)
                    .unwrap();
                let text = String::from_utf8(fs::read(&path).unwrap()).unwrap();
                out.insert(rel, format!("{text}@{}", modified.as_secs()));
            }
        }
    }
    out
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Answers `choice` and keeps what the prompt was shown.
fn answering(
    choice: Choice,
    asked: &RefCell<Vec<CopyTarget>>,
) -> impl FnOnce(&Path, &CopyTarget) -> Choice + '_ {
    move |_, target| {
        asked.borrow_mut().push(target.clone());
        choice
    }
}

fn never_asked(_: &Path, _: &CopyTarget) -> Choice {
    panic!("this folder opens without asking")
}

#[test]
fn create_copy_copies_the_vault_beside_itself_and_leaves_the_original_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let before = snapshot(&vault);
    let asked = RefCell::default();

    let decision = resolve_obsidian_open(&vault, answering(Choice::Copy, &asked)).unwrap();

    let copy = root.path().join("My Vault-memrynote");
    assert_eq!(decision, ObsidianOpenDecision::CreateCopy(copy.clone()));
    assert_eq!(asked.into_inner(), [CopyTarget::Create(copy.clone())]);
    assert_eq!(snapshot(&vault), before, "the original is only read");
    // Notes and attachments come along with their dates and dot files, and so do a project's own
    // `.git` and `.obsidian`. Obsidian's config, trash and git history stay with the original.
    let expected: BTreeMap<_, _> = COPIED
        .iter()
        .map(|rel| ((*rel).to_owned(), before[*rel].clone()))
        .collect();
    assert_eq!(snapshot(&copy), expected);
    assert_eq!(names(root.path()), ["My Vault", "My Vault-memrynote"]);
}

#[test]
fn open_original_and_cancel_copy_nothing() {
    for (choice, opens_original) in [(Choice::Original, true), (Choice::Cancel, false)] {
        let root = tempfile::tempdir().unwrap();
        let vault = obsidian_vault(root.path());
        let before = snapshot(&vault);
        let asked = RefCell::default();

        let decision = resolve_obsidian_open(&vault, answering(choice, &asked)).unwrap();

        let expected = if opens_original {
            ObsidianOpenDecision::OpenOriginal(vault.clone())
        } else {
            ObsidianOpenDecision::Cancel
        };
        assert_eq!(decision, expected);
        assert_eq!(asked.borrow().len(), 1);
        assert_eq!(snapshot(&vault), before);
        assert_eq!(names(root.path()), ["My Vault"]);
    }
}

#[test]
fn a_folder_that_is_not_an_obsidian_vault_never_opened_opens_without_asking() {
    let cases: [(&str, &[(&str, &str)]); 3] = [
        ("a folder Obsidian never opened", &[("Note.md", "hello\n")]),
        // Users who keep this app and Obsidian on one folder chose that long ago; asking on
        // every open would only nag them.
        (
            "an Obsidian vault this app opened",
            &[(".obsidian/app.json", "{}"), (".memry/config.json", "{}")],
        ),
        ("a file named .obsidian", &[(".obsidian", "not a folder")]),
    ];
    for (case, files) in cases {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Folder");
        write_tree(&folder, files);

        let decision = resolve_obsidian_open(&folder, never_asked).unwrap();

        assert_eq!(
            decision,
            ObsidianOpenDecision::OpenOriginal(folder),
            "{case}"
        );
        assert_eq!(names(root.path()), ["Folder"], "{case}");
    }
    let missing = tempfile::tempdir().unwrap().path().join("gone");
    assert_eq!(
        resolve_obsidian_open(&missing, never_asked).unwrap(),
        ObsidianOpenDecision::OpenOriginal(missing.clone()),
        "a missing folder is the open's to refuse"
    );
}

#[test]
fn open_copy_opens_the_copy_made_last_time_as_it_is() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let copy = root.path().join("My Vault-memrynote");
    write_tree(
        &copy,
        &[
            ("Tasks.md", "- [ ] Renew passport {task:abc}\n"),
            (".memry/config.json", "{}"),
        ],
    );
    let copy_before = snapshot(&copy);
    let asked = RefCell::default();

    let decision = resolve_obsidian_open(&vault, answering(Choice::Copy, &asked)).unwrap();

    assert_eq!(decision, ObsidianOpenDecision::OpenCopy(copy.clone()));
    assert_eq!(asked.into_inner(), [CopyTarget::Reuse(copy.clone())]);
    assert_eq!(snapshot(&copy), copy_before);
    assert_eq!(names(root.path()), ["My Vault", "My Vault-memrynote"]);
}

#[test]
fn a_name_held_by_anything_but_a_vault_moves_the_copy_to_the_next_number() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let stranger = root.path().join("My Vault-memrynote");
    write_tree(&stranger, &[("unrelated.txt", "not a vault")]);
    fs::write(
        root.path().join("My Vault-memrynote-2"),
        "a file, not a folder",
    )
    .unwrap();
    let stranger_before = snapshot(&stranger);
    let asked = RefCell::default();

    let decision = resolve_obsidian_open(&vault, answering(Choice::Copy, &asked)).unwrap();

    let copy = root.path().join("My Vault-memrynote-3");
    assert_eq!(decision, ObsidianOpenDecision::CreateCopy(copy.clone()));
    assert_eq!(asked.into_inner(), [CopyTarget::Create(copy.clone())]);
    assert_eq!(snapshot(&stranger), stranger_before);
    assert_eq!(
        fs::read_to_string(root.path().join("My Vault-memrynote-2")).unwrap(),
        "a file, not a folder"
    );
    assert!(copy.join("Tasks.md").is_file());
}

#[test]
fn the_copy_never_takes_the_place_of_a_folder_or_file_that_appeared_meanwhile() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let target = root.path().join("My Vault-memrynote");

    // The folder appears while the dialog is up: a plain rename would replace an empty one.
    let error = resolve_obsidian_open(&vault, |_, target| {
        fs::create_dir(target.path()).unwrap();
        Choice::Copy
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(
        names(&target),
        Vec::<String>::new(),
        "the folder is left as it was"
    );
    assert_eq!(names(root.path()), ["My Vault", "My Vault-memrynote"]);

    fs::remove_dir(&target).unwrap();
    fs::write(&target, "someone's file").unwrap();
    let error = copy_vault(&vault, &target).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(&target).unwrap(), "someone's file");
    assert_eq!(names(root.path()), ["My Vault", "My Vault-memrynote"]);
}

#[test]
fn a_deep_and_wide_tree_is_copied_whole_with_few_folders_open_on_a_small_stack() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let mut files: Vec<(String, String)> = (0..50)
        .map(|n| (format!("wide/{n}.md"), format!("note {n}\n")))
        .collect();
    let mut deep = String::from("wide/deep");
    for level in 0..2 * MAX_OPEN_DIRS {
        files.push((format!("{deep}/{level}.md"), format!("level {level}\n")));
        deep.push_str("/d");
    }
    // Listed after the deep folder, so they are read while the listings above it are closed.
    files.extend((50..60).map(|n| (format!("wide/z{n}.md"), format!("note {n}\n"))));
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    write_tree(&vault, &refs);
    let source = snapshot(&vault);

    let copy = root.path().join("My Vault-memrynote");
    let (from, to) = (vault.clone(), copy.clone());
    let peak = on_small_stack(move || {
        take_open_dirs_peak();
        copy_vault(&from, &to).unwrap();
        take_open_dirs_peak()
    });

    assert!(
        peak <= MAX_OPEN_DIRS,
        "{peak} folder listings were open at once"
    );
    let copied = snapshot(&copy);
    for (rel, _) in &files {
        assert_eq!(copied.get(rel), source.get(rel), "{rel}");
    }
    assert_eq!(copied.len(), COPIED.len() + files.len());
}

/// A file the copy cannot read fails it part way. Root reads any file and Windows ignores the
/// mode bits, so neither can make the copy fail this way.
#[cfg(unix)]
#[test]
fn a_failed_copy_leaves_nothing_beside_the_vault() {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let unreadable = vault.join("Daily Notes/2026-10-20.md");
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();

    let error = resolve_obsidian_open(&vault, |_, _| Choice::Copy).unwrap_err();

    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(names(root.path()), ["My Vault"]);
}

#[cfg(unix)]
#[test]
fn a_pipe_fails_the_copy_and_leaves_nothing() {
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let pipe = std::ffi::CString::new(vault.join("Daily Notes/pipe").to_str().unwrap()).unwrap();
    // SAFETY: the path is NUL-terminated and outlives the call.
    assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o644) }, 0);

    let error = resolve_obsidian_open(&vault, |_, _| Choice::Copy).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    assert_eq!(names(root.path()), ["My Vault"]);
}

#[cfg(unix)]
#[test]
fn links_are_copied_as_links_and_nothing_outside_the_vault_is_read_or_copied() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let outside = root.path().join("Outside");
    write_tree(&outside, &[("secret.md", "not part of the vault\n")]);
    symlink("Daily Notes", vault.join("daily")).unwrap();
    symlink("Tasks.md", vault.join("Tasks link.md")).unwrap();
    symlink(&outside, vault.join("outside")).unwrap();
    symlink("nowhere", vault.join("dangling")).unwrap();
    let outside_before = snapshot(&outside);

    let copy = root.path().join("My Vault-memrynote");
    copy_vault(&vault, &copy).unwrap();

    let copied = snapshot(&copy);
    assert_eq!(copied["daily"], "link:Daily Notes");
    assert_eq!(copied["Tasks link.md"], "link:Tasks.md");
    assert_eq!(copied["outside"], format!("link:{}", outside.display()));
    assert_eq!(copied["dangling"], "link:nowhere");
    assert!(
        !copied.keys().any(|rel| rel.contains("secret")),
        "a linked folder is never walked: {copied:?}"
    );
    assert_eq!(snapshot(&outside), outside_before);
    // The relative link resolves inside the copy, not back to the original.
    assert_eq!(
        fs::canonicalize(copy.join("daily")).unwrap(),
        fs::canonicalize(copy.join("Daily Notes")).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn a_picked_link_copies_the_vault_it_names_not_the_link() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    let link = root.path().join("Linked");
    symlink(&vault, &link).unwrap();

    let decision = resolve_obsidian_open(&link, |_, _| Choice::Copy).unwrap();

    let copy = root.path().join("Linked-memrynote");
    assert_eq!(decision, ObsidianOpenDecision::CreateCopy(copy.clone()));
    assert!(!fs::symlink_metadata(&copy).unwrap().is_symlink());
    fs::write(copy.join("Tasks.md"), "edited in the copy\n").unwrap();
    assert_eq!(
        fs::read_to_string(vault.join("Tasks.md")).unwrap(),
        VAULT_FILES[0].1,
        "writing to the copy leaves the original alone"
    );
}

#[cfg(unix)]
#[test]
fn a_read_only_file_keeps_its_mode_and_its_modified_time() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let vault = obsidian_vault(root.path());
    fs::set_permissions(vault.join("Tasks.md"), fs::Permissions::from_mode(0o444)).unwrap();
    let before = fs::metadata(vault.join("Tasks.md"))
        .unwrap()
        .modified()
        .unwrap();

    let copy = root.path().join("My Vault-memrynote");
    copy_vault(&vault, &copy).unwrap();

    let copied = fs::metadata(copy.join("Tasks.md")).unwrap();
    assert_eq!(copied.permissions().mode() & 0o777, 0o444);
    assert_eq!(before, UNIX_EPOCH + OLD);
    assert_eq!(copied.modified().unwrap(), before);
}
