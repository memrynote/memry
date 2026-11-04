//! A folder another device made, changed or deleted, mirrored into a real vault (#3906, Step
//! 13h): `folder-config-handler.ts` and `deleted-folder-prune.ts`.
//!
//! | Test                                                              | Rule                          |
//! | ----------------------------------------------------------------- | ----------------------------- |
//! | a deleted folder goes once its last note is gone, then its parent | `pruneDeletedFolders`         |
//! | a folder made in a file manager is never removed                  | no tombstone, no prune        |
//! | a deleted folder holding another file is kept                     | `removeFolderIfEmpty`         |
//! | a deleted folder that keeps changing is kept once the wait ends   | the pull page's quiet window  |
//! | a remote icon reaches the folder's file and keeps its views       | `writeMergedFolderConfig`     |
//! | a remote folder missing here is made                              | `writeFolderConfig`'s mkdir   |
//! | a folder file that cannot be read stays as it is                  | #720                          |
//! | a remote delete clears the icon of a folder that stays            | #2512                         |
//! | a remote delete removes a folder that holds nothing               | `scheduleDeletedFolderPrune`  |
//! | a folder a link leads to is never pruned                          | links stay                    |

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use memry_core::domain::folders;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::empty_folder::Quiet;
use memry_desktop::vault::folder_file;
use serde_json::json;

use crate::notes_folder_move::{note, opened_with};

const NOW: Quiet = Quiet {
    window: Duration::ZERO,
    timeout: Duration::from_secs(1),
};

fn no_bin(_: &Path) -> Result<(), String> {
    Err("no bin".to_owned())
}

fn opened() -> (vault_env::Env, Arc<NotesService>) {
    let (e, notes, _) = opened_with(no_bin);
    (e, notes)
}

/// The folder's records gone as a delete on another device leaves them: no live record, a
/// tombstone each.
fn delete_records(e: &vault_env::Env, path: &'static str) {
    e.core()
        .db_handle()
        .call_blocking(move |conn| folders::delete_tree(conn, path, "other-device", 1).map(drop))
        .unwrap();
}

#[test]
fn a_deleted_folder_goes_once_its_last_note_is_gone_then_its_parent() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "a").unwrap();
    notes.create_folder(&open, "a/b").unwrap();
    notes.create(&open, note("Last", "a/b")).unwrap();
    fs::write(e.vault.join("a/.DS_Store"), b"view").unwrap();
    delete_records(&e, "a");

    assert_eq!(
        notes
            .prune_deleted_folders_quiet(&open, "a/b", false, NOW)
            .unwrap(),
        Vec::<String>::new()
    );
    assert!(e.vault.join("a/b/Last.md").exists());

    fs::remove_file(e.vault.join("a/b/Last.md")).unwrap();
    let removed = notes
        .prune_deleted_folders_quiet(&open, "a/b", false, NOW)
        .unwrap();
    assert_eq!(removed, ["a/b", "a"]);
    assert!(!e.vault.join("a").exists());
}

#[test]
fn a_folder_made_in_a_file_manager_is_never_removed() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir(e.vault.join("Made")).unwrap();
    let removed = notes
        .prune_deleted_folders_quiet(&open, "Made", false, NOW)
        .unwrap();
    assert_eq!(removed, Vec::<String>::new());
    assert!(e.vault.join("Made").is_dir());
}

#[test]
fn a_deleted_folder_holding_another_file_is_kept() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Pics").unwrap();
    fs::create_dir(e.vault.join("Pics/Sub")).unwrap();
    fs::write(e.vault.join("Pics/Sub/cat.png"), b"png").unwrap();
    delete_records(&e, "Pics");
    let removed = notes
        .prune_deleted_folders_quiet(&open, "Pics", false, NOW)
        .unwrap();
    assert_eq!(removed, Vec::<String>::new());
    assert!(e.vault.join("Pics/Sub/cat.png").exists());
}

#[test]
fn a_deleted_folder_that_keeps_changing_is_kept_once_the_wait_ends() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Busy").unwrap();
    delete_records(&e, "Busy");
    let busy = Quiet {
        window: Duration::from_secs(30),
        timeout: Duration::from_millis(200),
    };
    let removed = notes
        .prune_deleted_folders_quiet(&open, "Busy", false, busy)
        .unwrap();
    assert_eq!(removed, Vec::<String>::new());
    assert!(e.vault.join("Busy").is_dir());
}

const WITH_VIEWS: &str = "---\nicon: 'lucide:folder'\ntemplate: daily\nviews:\n  - id: v1\n    name: Table\ncustom: kept\n---\n\nNotes about the folder.\n";

#[test]
fn a_remote_icon_reaches_the_folder_file_and_keeps_its_views() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir(e.vault.join("Work")).unwrap();
    fs::write(e.vault.join("Work/.folder.md"), WITH_VIEWS).unwrap();

    notes
        .apply_remote_folder(&open, "Work", Some("lucide:star"))
        .unwrap();

    let file = folder_file::read(&e.vault, "Work").unwrap().unwrap();
    let config = file.config();
    assert_eq!(config.icon.as_deref(), Some("lucide:star"));
    assert_eq!(config.template.as_deref(), Some("daily"));
    assert_eq!(config.views, Some(json!([{ "id": "v1", "name": "Table" }])));
    let written = fs::read_to_string(e.vault.join("Work/.folder.md")).unwrap();
    assert!(written.contains("custom: kept"), "{written}");
    assert!(written.ends_with("Notes about the folder.\n"), "{written}");
}

#[test]
fn a_remote_folder_missing_here_is_made() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes
        .apply_remote_folder(&open, "Remote/Empty", None)
        .unwrap();
    assert!(e.vault.join("Remote/Empty").is_dir());
    assert!(!e.vault.join("Remote/Empty/.folder.md").exists());

    notes
        .apply_remote_folder(&open, "Iconic", Some("lucide:book"))
        .unwrap();
    let file = folder_file::read(&e.vault, "Iconic").unwrap().unwrap();
    assert_eq!(file.icon(), Some("lucide:book"));
}

#[test]
fn a_folder_file_that_cannot_be_read_stays_as_it_is() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir(e.vault.join("Odd")).unwrap();
    let broken = "---\n- a list\n- not a map\n---\n";
    fs::write(e.vault.join("Odd/.folder.md"), broken).unwrap();
    let refused = notes.apply_remote_folder(&open, "Odd", Some("lucide:star"));
    assert!(
        matches!(refused, Err(NotesError::FolderFile(_))),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(e.vault.join("Odd/.folder.md")).unwrap(),
        broken
    );
}

#[test]
fn a_remote_delete_clears_the_icon_of_a_folder_that_stays() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Keep").unwrap();
    notes.create(&open, note("Edited here", "Keep")).unwrap();
    fs::write(e.vault.join("Keep/.folder.md"), WITH_VIEWS).unwrap();
    delete_records(&e, "Keep");

    let removed = notes.apply_remote_folder_delete(&open, "Keep").unwrap();

    assert_eq!(removed, Vec::<String>::new());
    let config = folder_file::read(&e.vault, "Keep")
        .unwrap()
        .unwrap()
        .config();
    assert_eq!(config.icon, None);
    assert_eq!(config.views, Some(json!([{ "id": "v1", "name": "Table" }])));
    assert!(e.vault.join("Keep/Edited here.md").exists());
}

#[test]
fn a_remote_delete_removes_a_folder_that_holds_nothing() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Gone").unwrap();
    fs::write(
        e.vault.join("Gone/.folder.md"),
        "---\nicon: 'lucide:x'\n---\n\n",
    )
    .unwrap();
    delete_records(&e, "Gone");

    let removed = notes.apply_remote_folder_delete(&open, "Gone").unwrap();

    assert_eq!(removed, ["Gone"]);
    assert!(!e.vault.join("Gone").exists());
}

#[cfg(unix)]
#[test]
fn a_folder_a_link_leads_to_is_never_pruned() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Real").unwrap();
    std::os::unix::fs::symlink(e.vault.join("Real"), e.vault.join("Link")).unwrap();
    let refused = notes.prune_deleted_folders_quiet(&open, "Link", true, NOW);
    assert!(
        matches!(refused, Err(NotesError::InvalidFolder)),
        "{refused:?}"
    );
    let refused = notes.apply_remote_folder(&open, "Link/Sub", None);
    assert!(
        matches!(refused, Err(NotesError::InvalidFolder)),
        "{refused:?}"
    );
    assert!(e.vault.join("Real").is_dir());
    assert!(!e.vault.join("Real/Sub").exists());
}
