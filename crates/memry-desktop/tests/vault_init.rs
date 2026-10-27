//! `initVault` and `countMarkdownFiles` of Electron, over real folders.

use std::fs;

use memry_desktop::vault::config::{VaultConfig, read_vault_config};
use memry_desktop::vault::init::{
    CountLimits, VAULT_FOLDERS, count_markdown_files, init_vault, is_vault_initialized,
};

/// `JSON.stringify(DEFAULT_CONFIG, null, 2)` of Electron's `init.ts`.
const ELECTRON_DEFAULT: &str = r#"{
  "excludePatterns": [
    ".git",
    "node_modules",
    ".trash",
    ".obsidian",
    ".memry"
  ],
  "defaultNoteFolder": "",
  "journalFolder": "journal",
  "journalDateFormat": "YYYY-MM-DD",
  "attachmentsFolder": "attachments",
  "journalShowInSidebar": false
}"#;

#[test]
fn a_new_vault_gets_the_electron_default_config_and_folders() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!is_vault_initialized(dir.path()));
    init_vault(dir.path()).unwrap();
    assert!(is_vault_initialized(dir.path()));
    assert_eq!(
        fs::read_to_string(dir.path().join(".memry/config.json")).unwrap(),
        ELECTRON_DEFAULT
    );
    for folder in VAULT_FOLDERS {
        assert!(dir.path().join(folder).is_dir(), "{folder}");
    }
    assert_eq!(read_vault_config(dir.path()), VaultConfig::default());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.path().join(".memry/config.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn init_never_replaces_a_config_that_is_there() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    for existing in ["{ broken", r#"{"journalFolder":"mine"}"#, ""] {
        fs::write(dir.path().join(".memry/config.json"), existing).unwrap();
        init_vault(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(".memry/config.json")).unwrap(),
            existing
        );
    }
}

#[test]
fn counting_matches_electron_prefix_exclusion_and_does_not_follow_links() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for file in [
        "a.md",
        "sub/b.md",
        "sub/deep/c.md",
        ".hidden.md",
        "notes.txt",
        ".git/x.md",
        ".github/y.md",
        "node_modules/z/w.md",
        ".memry/core/q.md",
    ] {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }
    fs::create_dir_all(root.join("dir.md")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.join("sub"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("a.md"), root.join("alias.md")).unwrap();
    }
    let exclude = VaultConfig::default().exclude_patterns;
    let counted = count_markdown_files(root, &exclude, CountLimits::DEFAULT);
    // a, sub/b, sub/deep/c, .hidden: `.github` starts with `.git` and is skipped like Electron.
    assert_eq!(counted.count, 4);
    assert!(!counted.truncated);
}

#[test]
fn counting_stops_at_its_step_caps_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    for n in 0..50 {
        fs::write(dir.path().join(format!("{n}.md")), "x").unwrap();
    }
    let capped = count_markdown_files(
        dir.path(),
        &[],
        CountLimits {
            max_depth: 4,
            max_entries: 10,
        },
    );
    assert!(capped.truncated);
    assert!(capped.count <= 10);

    let mut nested = dir.path().to_path_buf();
    for _ in 0..8 {
        nested.push("d");
    }
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("deep.md"), "x").unwrap();
    let shallow = count_markdown_files(
        dir.path(),
        &[],
        CountLimits {
            max_depth: 3,
            max_entries: 1_000,
        },
    );
    assert!(shallow.truncated);
    assert_eq!(
        shallow.count, 50,
        "the note below the depth cap is not counted"
    );
}

#[cfg(unix)]
#[test]
fn a_vault_folder_that_cannot_be_looked_at_counts_as_initialised() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("v");
    fs::create_dir_all(&vault).unwrap();
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o000)).unwrap();
    // Root passes every permission check, so there is nothing to observe.
    let looked =
        fs::metadata(vault.join(".memry")).is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound);
    let initialised = is_vault_initialized(&vault);
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o755)).unwrap();
    if looked {
        assert!(
            initialised,
            "no init into a folder that cannot be looked at"
        );
    }
}
