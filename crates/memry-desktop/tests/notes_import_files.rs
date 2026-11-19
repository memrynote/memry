//! Files copied into the vault from outside it (`notes:import-files`, `importFiles` of
//! `vault/notes-crud.ts`; Step 32h1, #3549), and the paths such a copy may read: a file the
//! shell staged from a drop, or one the import dialog returned (#3709, comment 6475747288).
//!
//! | Test                                                               | Rule                                  |
//! | ------------------------------------------------------------------ | ------------------------------------- |
//! | a staged file lands with its bytes, a taken name as `<name> (n)`   | `importFiles`' copy and its free name |
//! | no folder: the vault's default note folder                         | `getDefaultNoteDir`                   |
//! | with `plainChecklists` a markdown file's checklists stay checklists | `copyImportedFile`                    |
//! | a path outside staging and the dialog's answer refuses the call    | #3709: refused before any read        |
//! | a path neither staged nor picked is refused unread, existing or not | #3709: decided on its spelling        |
//! | a picked path named twice refuses the call and stays picked        | #3709: one read per pick              |
//! | a picked link named `.md` is marked as markdown                    | `getExtension(sourcePath)`            |
//! | a dialog's path is read once, and only the last dialog's           | #3709: this request's dialog          |
//! | a file that is gone fails alone, in the result and the activity log | `recordDropCopyFailure`              |
//! | a folder outside the vault, or a locked one, refuses the call      | `assertFolderWritable`                |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::error::CoreError;
use memry_desktop::import::source_paths::{ImportGrants, SourceRefused};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::import_files::{ImportFilesResult, import_folder};
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::activity::{ActivityFilter, ActivityKind, ActivitySource};
use memry_desktop::vault::file_types::FileType;
use vault_env::{Env, env, indexed};

/// A vault under the running tier, and outside it a drop staging root and a plain folder.
struct World {
    e: Env,
    notes: Arc<NotesService>,
    outside: tempfile::TempDir,
}

impl World {
    fn new(files: &[(&str, &str)]) -> Self {
        let mut kept = None;
        let mut e = env(|store| {
            kept = Some(store.clone());
            Some(NotesIdentity::new(store))
        });
        for (rel, text) in files {
            e.write(rel, text);
        }
        e.open();
        e.facts_until(indexed);
        let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join("drop-staging")).unwrap();
        Self { e, notes, outside }
    }

    fn staging(&self) -> PathBuf {
        self.outside.path().join("drop-staging")
    }

    /// A file as the shell stages a drop: `<staging>/<id>/<name>`.
    fn stage(&self, id: &str, name: &str, bytes: &[u8]) -> String {
        let dir = self.staging().join(id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// A file outside both staging and the vault.
    fn elsewhere(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.outside.path().join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn import(
        &self,
        grants: &ImportGrants,
        paths: &[String],
        folder: Option<&str>,
        plain: bool,
    ) -> ImportFilesResult {
        let open = self.e.session.current().unwrap();
        let folder = import_folder(&open, folder).expect("the folder");
        let sources = grants.admit(&self.staging(), paths).expect("admitted");
        self.notes.import_files(&open, &folder, sources, plain)
    }

    fn vault_file(&self, rel: &str) -> Vec<u8> {
        fs::read(self.e.vault.join(rel)).unwrap_or_else(|error| panic!("{rel}: {error}"))
    }
}

fn dest(world: &World, rel: &str) -> String {
    rel.split('/')
        .fold(world.e.vault.clone(), |path, part| path.join(part))
        .to_string_lossy()
        .into_owned()
}

#[test]
fn a_staged_file_lands_with_its_bytes_and_a_taken_name_gets_the_next_free_one() {
    let world = World::new(&[("Work/Plan.md", "# Plan\n")]);
    let grants = ImportGrants::default();
    let pdf: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let paths = [
        world.stage("a", "Plan.md", b"# Dropped plan\n"),
        world.stage("b", "Plan.md", b"# Another\n"),
        world.stage("c", "scan.pdf", &pdf),
        world.stage("d", ".hidden", b"dot"),
    ];

    let result = world.import(&grants, &paths, Some("Work"), false);

    assert!(result.success);
    assert_eq!((result.imported, result.failed), (4, 0));
    assert!(result.errors.is_empty());
    let landed: Vec<_> = result
        .imported_files
        .iter()
        .map(|file| {
            (
                file.dest_path.clone(),
                file.filename.clone(),
                file.file_type,
            )
        })
        .collect();
    assert_eq!(
        landed,
        vec![
            (
                dest(&world, "Work/Plan (1).md"),
                "Plan.md".into(),
                FileType::Markdown
            ),
            (
                dest(&world, "Work/Plan (2).md"),
                "Plan.md".into(),
                FileType::Markdown
            ),
            (
                dest(&world, "Work/scan.pdf"),
                "scan.pdf".into(),
                FileType::Pdf
            ),
            // `getFileType(...) ?? 'markdown'`.
            (
                dest(&world, "Work/.hidden"),
                ".hidden".into(),
                FileType::Markdown
            ),
        ]
    );
    assert_eq!(world.vault_file("Work/Plan.md"), b"# Plan\n");
    assert_eq!(world.vault_file("Work/Plan (1).md"), b"# Dropped plan\n");
    assert_eq!(world.vault_file("Work/Plan (2).md"), b"# Another\n");
    assert_eq!(world.vault_file("Work/scan.pdf"), pdf);
}

#[test]
fn no_folder_puts_the_files_in_the_default_note_folder() {
    let world = World::new(&[(
        ".memry/config.json",
        r#"{"defaultNoteFolder":"Inbox notes"}"#,
    )]);
    let grants = ImportGrants::default();
    let paths = [world.stage("a", "Note.md", b"hello")];

    let result = world.import(&grants, &paths, None, false);
    let again = world.import(
        &grants,
        &[world.stage("b", "Note.md", b"two")],
        Some(""),
        false,
    );

    assert_eq!(
        result.imported_files[0].dest_path,
        dest(&world, "Inbox notes/Note.md")
    );
    assert_eq!(
        again.imported_files[0].dest_path,
        dest(&world, "Inbox notes/Note (1).md")
    );
    assert_eq!(world.vault_file("Inbox notes/Note.md"), b"hello");
}

#[test]
fn plain_checklists_mark_a_markdown_files_checkboxes_and_nothing_else() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let text = b"# T\n- [ ] new\n- [x] done\n";
    let paths = [
        world.stage("a", "list.md", text),
        world.stage("b", "list.txt", text),
    ];

    world.import(&grants, &paths, Some("Plain"), true);
    world.import(
        &grants,
        &[world.stage("c", "list.md", text)],
        Some("Kept"),
        false,
    );

    // Electron's `markAddedChecklistLinesPlain` gives exactly this for the same text.
    assert_eq!(
        world.vault_file("Plain/list.md"),
        b"# T\n- [ ] new {check}\n- [x] done {check}\n"
    );
    assert_eq!(world.vault_file("Plain/list.txt"), text);
    assert_eq!(world.vault_file("Kept/list.md"), text);
}

#[test]
fn a_path_outside_staging_and_the_dialogs_answer_refuses_the_whole_call() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let staged = world.stage("a", "fine.md", b"fine");
    let secret = world.elsewhere("id_rsa", b"secret");
    let escaping = world
        .staging()
        .join("a")
        .join("..")
        .join("..")
        .join("id_rsa")
        .to_string_lossy()
        .into_owned();
    let refused = vec![vec![staged.clone(), secret.clone()], vec![escaping]];
    #[cfg(unix)]
    let refused = {
        let mut refused = refused;
        let link = world.staging().join("b");
        fs::create_dir_all(&link).unwrap();
        std::os::unix::fs::symlink(&secret, link.join("id_rsa.md")).unwrap();
        std::os::unix::fs::symlink(world.outside.path(), world.staging().join("c")).unwrap();
        let through = world.staging().join("c").join("id_rsa");
        refused.extend([
            vec![link.join("id_rsa.md").to_string_lossy().into_owned()],
            vec![through.to_string_lossy().into_owned()],
        ]);
        refused
    };

    for paths in refused {
        let refusal = grants.admit(&world.staging(), &paths).err();
        assert!(
            matches!(refusal, Some(SourceRefused::NotAllowed)),
            "{paths:?}"
        );
    }
    for name in ["fine.md", "id_rsa", "id_rsa.md"] {
        assert!(!world.e.vault.join(name).exists(), "the vault took {name}");
    }
    assert!(
        Path::new(&staged).exists(),
        "the staged file stays for the shell to release"
    );
}

/// Whether a path exists, or what it names (a share, an automount), is never looked up for a
/// path neither staged nor picked: each refuses the call alike, and nothing reaches the log.
#[test]
fn a_path_neither_staged_nor_picked_is_refused_unread_whether_it_exists_or_not() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let existing = world.elsewhere("id_rsa", b"secret");
    let missing = world
        .outside
        .path()
        .join("id_ed25519")
        .to_string_lossy()
        .into_owned();
    let open = world.e.session.current().unwrap();
    let folder = import_folder(&open, Some("In")).unwrap();

    for path in [
        existing,
        missing,
        r"\\host\share\x".to_owned(),
        "/net/host/x".to_owned(),
    ] {
        let outcome = grants
            .admit(&world.staging(), std::slice::from_ref(&path))
            .map(|sources| world.notes.import_files(&open, &folder, sources, false));
        assert!(
            matches!(outcome, Err(SourceRefused::NotAllowed)),
            "{path}: {outcome:?}"
        );
    }
    let logged: Vec<_> = world
        .e
        .tier
        .activity()
        .list(100, ActivityFilter::All)
        .entries
        .into_iter()
        .filter(|entry| entry.source == ActivitySource::Drop)
        .collect();
    assert!(logged.is_empty(), "{logged:?}");
}

/// One pick admits its file once, even named three times in one call; a refused call takes no
/// pick it had admitted.
#[test]
fn a_picked_path_named_twice_refuses_the_call_and_stays_picked() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let picked = world.elsewhere("picked.md", b"two");
    let secret = world.elsewhere("id_rsa", b"secret");
    grants.grant(&[PathBuf::from(&picked)]);

    for paths in [
        vec![picked.clone(), picked.clone(), picked.clone()],
        vec![picked.clone(), secret],
    ] {
        assert!(
            matches!(
                grants.admit(&world.staging(), &paths),
                Err(SourceRefused::NotAllowed)
            ),
            "{paths:?}"
        );
    }
    let result = world.import(&grants, std::slice::from_ref(&picked), Some("In"), false);

    assert_eq!(result.imported, 1);
    assert!(grants.admit(&world.staging(), &[picked]).is_err());
}

/// Electron's `copyImportedFile` read the type from the path the user named, not where its
/// link leads.
#[cfg(unix)]
#[test]
fn a_picked_link_named_md_is_marked_as_markdown() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let target = world.elsewhere("b", b"- [ ] new\n");
    let link = world.outside.path().join("a.md");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    grants.grant(std::slice::from_ref(&link));

    let link = link.to_string_lossy().into_owned();
    let result = world.import(&grants, &[link], Some("In"), true);

    assert_eq!(result.imported, 1);
    assert_eq!(world.vault_file("In/a.md"), b"- [ ] new {check}\n");
}

#[test]
fn a_dialogs_path_is_read_once_and_only_the_last_dialogs() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let first = world.elsewhere("first.md", b"one");
    let picked = world.elsewhere("picked.md", b"two");
    grants.grant(&[PathBuf::from(&first)]);
    grants.grant(&[PathBuf::from(&picked)]);

    assert!(grants.admit(&world.staging(), &[first]).is_err());
    let result = world.import(&grants, std::slice::from_ref(&picked), Some("In"), false);

    assert_eq!(result.imported, 1);
    assert_eq!(world.vault_file("In/picked.md"), b"two");
    assert!(matches!(
        grants.admit(&world.staging(), &[picked]),
        Err(SourceRefused::NotAllowed)
    ));
}

#[test]
fn a_file_that_is_gone_fails_alone_and_is_logged_as_a_failed_drop_copy() {
    let world = World::new(&[]);
    let grants = ImportGrants::default();
    let gone = world.stage("a", "gone.md", b"x");
    fs::remove_file(&gone).unwrap();
    let folder = world.staging().join("b");
    fs::create_dir_all(&folder).unwrap();
    let paths = [
        gone,
        folder.to_string_lossy().into_owned(),
        world.stage("c", "kept.md", b"kept"),
    ];

    let result = world.import(&grants, &paths, Some("In"), false);

    assert!(!result.success);
    assert_eq!((result.imported, result.failed), (1, 2));
    assert_eq!(result.errors.len(), 2);
    assert!(
        result.errors[0].starts_with("Failed to import gone.md: "),
        "{:?}",
        result.errors
    );
    assert!(
        result.errors[1].starts_with("Failed to import b: "),
        "{:?}",
        result.errors
    );
    assert_eq!(world.vault_file("In/kept.md"), b"kept");
    let failed: Vec<_> = world
        .e
        .tier
        .activity()
        .list(100, ActivityFilter::All)
        .entries
        .into_iter()
        .filter(|entry| entry.kind == ActivityKind::Failed && entry.source == ActivitySource::Drop)
        .map(|entry| {
            (
                entry.path.unwrap_or_default(),
                entry.reason.unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(
        failed,
        vec![
            ("b".to_owned(), "copy-failed".to_owned()),
            ("gone.md".to_owned(), "copy-failed".to_owned()),
        ]
    );
}

#[test]
fn a_folder_outside_the_vault_or_a_locked_one_refuses_the_call() {
    let world = World::new(&[("Archive/Old.md", "old")]);
    world
        .e
        .core()
        .locks()
        .set(TargetKind::Folder, "Archive", true, "device-a")
        .unwrap();
    let open = world.e.session.current().unwrap();

    for (folder, code) in [
        ("../Escaped", "invalid_folder"),
        ("Archive/Sub", "folder_locked"),
    ] {
        let error = import_folder(&open, Some(folder)).expect_err(folder);
        assert_eq!(error.kind_and_code().1, code, "{folder}");
    }
    assert!(!world.outside.path().join("Escaped").exists());
    assert!(!world.e.vault.join("Archive/Sub").exists());
}
