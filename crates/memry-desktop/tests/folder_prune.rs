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
//! | a folder made again during the wait is kept with its file         | `pruneDeletedFolders` order   |
//! | a file written after the scan keeps its folder, not the ones gone | `rmdir`, not a tree delete    |
//! | a pulled delete with no local record or clock still removes it    | `applyDelete`, #2512          |
//! | the folder holding the journal stays, the one beside it goes      | the journal is not sync's     |
//! | another spelling of a live folder is never touched                | case-blind disks              |
//! | a folder sync may not reach is never touched                      | `create_folder`'s refusals    |
//! | a folder file with text or unknown keys keeps its folder          | decision, Electron removes it |

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use memry_core::domain::folders;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::{VaultConfigPatch, write_vault_config};
use memry_desktop::vault::empty_folder::Quiet;
use memry_desktop::vault::folder_file;
use serde_json::json;

use crate::notes_folder_move::{note, opened_with};
use crate::on_warning::{FOLDER_SYNC, logged};

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
            .prune_deleted_folders_checked(&open, "a/b", false, NOW, &mut |_| {})
            .unwrap(),
        Vec::<String>::new()
    );
    assert!(e.vault.join("a/b/Last.md").exists());

    fs::remove_file(e.vault.join("a/b/Last.md")).unwrap();
    let removed = notes
        .prune_deleted_folders_checked(&open, "a/b", false, NOW, &mut |_| {})
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
        .prune_deleted_folders_checked(&open, "Made", false, NOW, &mut |_| {})
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
    let (removed, log) = logged(FOLDER_SYNC, || {
        notes.prune_deleted_folders_checked(&open, "Pics", false, NOW, &mut |_| {})
    });
    assert_eq!(removed.unwrap(), Vec::<String>::new());
    assert!(e.vault.join("Pics/Sub/cat.png").exists());
    assert_eq!(
        log,
        [
            "INFO kept a folder deleted on another device, it still holds files file=Pics/Sub/cat.png"
        ]
    );
}

/// The 200 ms timeout stands in for the 60 s of `Quiet::default`; the 30 s window keeps the
/// just-made folder changing until it runs out.
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
    let (removed, log) = logged(FOLDER_SYNC, || {
        notes.prune_deleted_folders_checked(&open, "Busy", false, busy, &mut |_| {})
    });
    assert_eq!(removed.unwrap(), Vec::<String>::new());
    assert!(e.vault.join("Busy").is_dir());
    assert_eq!(
        log,
        ["WARN kept a folder deleted on another device, its files kept changing"]
    );
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
    let refused = notes.prune_deleted_folders_checked(&open, "Link", true, NOW, &mut |_| {});
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

/// Electron waits, then asks whether the folder is still deleted: one made again during the wait
/// (a pulled upsert, the user's create) keeps its folder and `.folder.md`.
#[test]
fn a_folder_made_again_during_the_wait_is_kept_with_its_file() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Back").unwrap();
    let file = "---\ntemplate: daily\n---\n\n";
    fs::write(e.vault.join("Back/.folder.md"), file).unwrap();
    delete_records(&e, "Back");
    let again = |_: &str| notes.create_folder(&open, "Back").unwrap();
    for known in [false, true] {
        let removed = notes
            .prune_deleted_folders_checked(&open, "Back", known, NOW, &mut { again })
            .unwrap();
        assert_eq!(removed, Vec::<String>::new());
        assert_eq!(
            fs::read_to_string(e.vault.join("Back/.folder.md")).unwrap(),
            file
        );
        delete_records(&e, "Back");
    }
}

/// `rmdir`, never a tree delete: a note written after the scan keeps its folder, and the
/// folders that went below it, before it, are still reported.
#[test]
fn a_file_written_after_the_scan_keeps_its_folder_not_the_ones_gone() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "a").unwrap();
    notes.create_folder(&open, "a/b").unwrap();
    delete_records(&e, "a");
    let mut late = |at: &str| {
        if at == "a" {
            fs::write(e.vault.join("a/x.md"), "written meanwhile\n").unwrap();
        }
    };
    // From `a`: its empty `a/b` goes before the late note keeps `a`.
    let removed = notes
        .prune_deleted_folders_checked(&open, "a", false, NOW, &mut late)
        .unwrap();
    assert_eq!(removed, ["a/b"]);
    assert_eq!(
        fs::read_to_string(e.vault.join("a/x.md")).unwrap(),
        "written meanwhile\n"
    );
}

/// A case-blind disk takes `work` for `Work`: a `work` record is never mirrored into `Work`.
#[test]
fn another_spelling_of_a_live_folder_is_never_touched() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Work").unwrap();
    fs::write(e.vault.join("Work/.folder.md"), WITH_VIEWS).unwrap();

    let removed = notes
        .prune_deleted_folders_checked(&open, "work", true, NOW, &mut |_| {})
        .unwrap();
    assert_eq!(removed, Vec::<String>::new());
    assert_eq!(
        notes.apply_remote_folder_delete(&open, "work").unwrap(),
        Vec::<String>::new()
    );
    notes
        .apply_remote_folder(&open, "work", Some("lucide:star"))
        .unwrap();

    assert_eq!(
        fs::read_to_string(e.vault.join("Work/.folder.md")).unwrap(),
        WITH_VIEWS
    );
    let names: Vec<_> = fs::read_dir(&e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(!names.iter().any(|name| name == "work"), "{names:?}");
}

/// What `create_folder` refuses, sync does not make or remove either: the vault root, a dot
/// folder, attachments, the journal folder and a folder inside it, the journal shown in the
/// sidebar or not.
#[test]
fn a_folder_sync_may_not_reach_is_never_touched() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir_all(e.vault.join("journal/2026")).unwrap();
    let shown = VaultConfigPatch {
        journal_show_in_sidebar: Some(true),
        ..Default::default()
    };
    write_vault_config(&e.vault, &shown).unwrap();
    for path in [
        "",
        ".hidden",
        "attachments/x",
        "canvases/x",
        "node_modules/x",
        "journal",
        "journal/2026",
    ] {
        notes
            .apply_remote_folder(&open, path, Some("lucide:x"))
            .unwrap();
        let removed = notes
            .prune_deleted_folders_checked(&open, path, true, NOW, &mut |_| {})
            .unwrap();
        assert_eq!(removed, Vec::<String>::new(), "{path}");
    }
    assert!(!e.vault.join(".folder.md").exists());
    assert!(!e.vault.join(".hidden").exists());
    assert!(!e.vault.join("attachments/x").exists());
    assert!(!e.vault.join("canvases/x").exists());
    assert!(!e.vault.join("node_modules/x").exists());
    assert!(e.vault.join("journal/2026").is_dir());
    assert!(!e.vault.join("journal/.folder.md").exists());
}

/// Decision (Electron removes any `.folder.md`): text after the frontmatter or a key no build
/// models is someone's, so the file stays and its folder with it.
#[test]
fn a_folder_file_with_text_or_unknown_keys_keeps_its_folder() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let kept = [
        ("Prose", "---\nicon: x\n---\n\nWhy this folder exists.\n"),
        ("Custom", "---\nnewerBuild: true\n---\n\n"),
        ("Broken", "---\n- a list\n---\n"),
    ];
    for (folder, text) in kept {
        notes.create_folder(&open, folder).unwrap();
        fs::write(e.vault.join(folder).join(".folder.md"), text).unwrap();
    }
    delete_records(&e, "Prose");
    delete_records(&e, "Custom");
    delete_records(&e, "Broken");
    for (folder, text) in kept {
        let removed = notes
            .prune_deleted_folders_checked(&open, folder, false, NOW, &mut |_| {})
            .unwrap();
        assert_eq!(removed, Vec::<String>::new(), "{folder}");
        assert_eq!(
            fs::read_to_string(e.vault.join(folder).join(".folder.md")).unwrap(),
            text
        );
    }
}

/// A pulled delete whose folder has no record here, or whose tombstone carries no clock (a
/// legacy one), removes it all the same, as `applyDelete` does: a folder left with neither looks
/// made in a file manager, and the backfill would sync it back (#2512).
#[test]
fn a_pulled_delete_with_no_local_record_or_clock_still_removes_it() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir(e.vault.join("Old")).unwrap();
    fs::write(
        e.vault.join("Old/.folder.md"),
        "---\nicon: 'lucide:x'\n---\n\n",
    )
    .unwrap();
    let removed = notes
        .prune_deleted_folders_checked(&open, "Old", true, NOW, &mut |_| {})
        .unwrap();
    assert_eq!(removed, ["Old"]);
    assert!(!e.vault.join("Old").exists());
}

/// The journal is not sync's to prune: a deleted folder beside it goes, the deleted folder
/// holding it stays, though the journal folder holds nothing yet.
#[test]
fn the_folder_holding_the_journal_stays_the_one_beside_it_goes() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let journal = VaultConfigPatch {
        journal_folder: Some("life/journal".to_owned()),
        ..Default::default()
    };
    write_vault_config(&e.vault, &journal).unwrap();
    notes.create_folder(&open, "life").unwrap();
    notes.create_folder(&open, "life/old").unwrap();
    fs::create_dir(e.vault.join("life/journal")).unwrap();
    delete_records(&e, "life");
    let removed = notes
        .prune_deleted_folders_checked(&open, "life/old", false, NOW, &mut |_| {})
        .unwrap();
    assert_eq!(removed, ["life/old"]);
    assert!(e.vault.join("life/journal").is_dir());
}
