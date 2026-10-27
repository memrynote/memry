//! The vault walk on a real tree (`findVaultFiles`).

use std::fs;

use memry_desktop::vault::walk::{Cap, Limits, walk_vault, walk_vault_with};

fn touch(root: &std::path::Path, rel: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "x").unwrap();
}

#[test]
fn it_lists_supported_files_and_skips_hidden_excluded_and_root_attachments() {
    let dir = tempfile::tempdir().unwrap();
    for rel in [
        "a.md",
        "notes/b.md",
        "notes/img.png",
        "notes/attachments/nested.md",
        "attachments/root.png",
        ".memry/config.json",
        ".hidden/x.md",
        ".dotfile.md",
        "node_modules/p/x.md",
        "docs/readme.txt",
        "docs/paper.PDF",
    ] {
        touch(dir.path(), rel);
    }
    let exclude = ["node_modules".to_owned()];
    let walk = walk_vault(dir.path(), &exclude);
    assert_eq!(
        walk.files,
        [
            "a.md",
            "docs/paper.PDF",
            "notes/attachments/nested.md",
            "notes/b.md",
            "notes/img.png"
        ]
    );
    assert_eq!(walk.unsupported, ["docs/readme.txt"]);
    assert_eq!(walk.unsupported_count, 1);
    assert!(walk.unreadable.is_empty());
}

#[cfg(unix)]
#[test]
fn links_are_not_followed_or_listed_and_an_unreadable_folder_is_reported() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    touch(outside.path(), "secret.md");
    touch(dir.path(), "a.md");
    symlink(outside.path(), dir.path().join("linked")).unwrap();
    symlink(dir.path().join("a.md"), dir.path().join("alias.md")).unwrap();
    symlink(dir.path(), dir.path().join("loop")).unwrap();
    touch(dir.path(), "locked/x.md");
    fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o000)).unwrap();

    let walk = walk_vault(dir.path(), &[]);
    fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(walk.files, ["a.md"]);
    // Root reads a mode 000 folder, so the report is only expected when the open fails.
    fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::read_dir(dir.path().join("locked")).is_ok();
    fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if !readable {
        assert_eq!(walk.unreadable, ["locked"]);
    }
}

/// A deep tree on a thread with a tiny stack: a recursive walk would overflow it.
#[cfg(unix)]
#[test]
fn depth_does_not_use_the_thread_stack_and_each_entry_is_visited_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut rel = String::new();
    for _ in 0..120 {
        rel.push_str("d/");
        touch(dir.path(), &format!("{rel}f.md"));
    }
    let root = dir.path().to_path_buf();
    let walk = std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(move || walk_vault(&root, &[]))
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(walk.files.len(), 120);
    // 120 folders and 120 files, each looked at once.
    assert_eq!(walk.visited, 240);
}

#[test]
fn the_unsupported_list_is_bounded_but_counted() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..30 {
        touch(dir.path(), &format!("f{i}.txt"));
    }
    let walk = walk_vault(dir.path(), &[]);
    assert_eq!(walk.unsupported_count, 30);
    assert!(walk.unsupported.len() <= memry_desktop::vault::walk::UNSUPPORTED_COLLECT_LIMIT);
}

#[test]
fn the_entry_cap_stops_the_walk_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..50 {
        touch(dir.path(), &format!("f{i:02}.md"));
    }
    let limits = Limits {
        max_entries: 10,
        ..Limits::DEFAULT
    };
    let walk = walk_vault_with(dir.path(), &[], limits);
    assert_eq!(walk.truncated, Some(Cap::Entries));
    assert_eq!(walk.visited, 10, "steps are counted, not time");
    assert!(walk.files.len() <= 10);
    // Under the cap nothing is flagged.
    assert_eq!(walk_vault(dir.path(), &[]).truncated, None);
}

#[test]
fn the_file_cap_stops_the_walk_and_counts_supported_and_unsupported_together() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..10 {
        touch(dir.path(), &format!("a{i}.md"));
        touch(dir.path(), &format!("b{i}.txt"));
    }
    let limits = Limits {
        max_files: 7,
        ..Limits::DEFAULT
    };
    let walk = walk_vault_with(dir.path(), &[], limits);
    assert_eq!(walk.truncated, Some(Cap::Files));
    assert_eq!(walk.files.len() + walk.unsupported_count, 7);
}

#[test]
fn folders_below_the_depth_cap_are_left_unread_and_counted() {
    let dir = tempfile::tempdir().unwrap();
    touch(dir.path(), "top.md");
    touch(dir.path(), "a/b/c/deep.md");
    touch(dir.path(), "a/near.md");
    let limits = Limits {
        max_depth: 2,
        ..Limits::DEFAULT
    };
    let walk = walk_vault_with(dir.path(), &[], limits);
    // The root is depth 0, `a` 1, `a/b` 2, `a/b/c` 3.
    assert_eq!(walk.files, ["a/near.md", "top.md"]);
    assert_eq!(walk.too_deep, 1);
    assert_eq!(walk.truncated, None);
}

// APFS refuses non-UTF-8 names, so the case runs on Linux (CI).
#[cfg(target_os = "linux")]
#[test]
fn a_name_that_is_not_utf8_is_skipped_and_counted_not_listed_lossily() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    touch(dir.path(), "good.md");
    // Two distinct bad names that a lossy decode would give the same spelling.
    for bytes in [&b"bad\xff.md"[..], &b"bad\xfe.md"[..]] {
        fs::write(dir.path().join(OsStr::from_bytes(bytes)), "x").unwrap();
    }
    let walk = walk_vault(dir.path(), &[]);
    assert_eq!(walk.files, ["good.md"]);
    assert_eq!(walk.non_utf8, 2);
}
