//! The folders of the notes tree (Step 13h, #3530), after `getFolders`, `createFolder` and the
//! folder config handlers of Electron, on a real vault under the running tier.
//!
//! | Test                                                           | Rule                                     |
//! | -------------------------------------------------------------- | ---------------------------------------- |
//! | a created folder is on disk, on top of its siblings, recorded  | `createFolder`, `placeNewItemAtTop`, `syncFolderConfigCreate` |
//! | a folder created again keeps its icon                          | divergence: Electron cleared it          |
//! | the tree lists folders but the hidden ones                     | `listDirectories`, `createTreeFolderFilter` |
//! | a folder's icon is its record's, else its file's               | `getFolders`                             |
//! | a config write keeps the views and mirrors the icon            | `notes:set-folder-config`                |
//! | a folder's template is inherited until `inherit: false`        | `getFolderTemplate`                      |
//! | a folder outside the vault is refused                          | traversal and links                      |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::folders::{self, FolderConfigInput, FolderView};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use vault_env::{Env, env, indexed};

fn opened() -> (Env, Arc<NotesService>, OpenVault) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
    let open = e.session.current().unwrap();
    (e, notes, open)
}

fn record_icon(open: &OpenVault, path: &str) -> Option<Option<String>> {
    let folders = open.vault.notes().folders().unwrap();
    folders.into_iter().find(|f| f.path == path).map(|f| f.icon)
}

fn input(icon: Option<Option<&str>>, template: Option<&str>, inherit: bool) -> FolderConfigInput {
    FolderConfigInput {
        icon: icon.map(|icon| icon.map(str::to_owned)),
        template: template.map(str::to_owned),
        inherit: Some(inherit),
    }
}

#[test]
fn a_created_folder_is_on_disk_on_top_of_its_siblings_and_recorded() {
    let (e, notes, open) = opened();
    // The root is ordered by hand; `Work/Plans` is not, and keeps its implicit order.
    open.vault
        .note_positions()
        .reorder("", vec!["Old".into()])
        .unwrap();
    notes.create_folder(&open, "Work").unwrap();
    notes.create_folder(&open, "Work/Plans/2026").unwrap();
    assert!(e.vault.join("Work/Plans/2026").is_dir());
    assert_eq!(record_icon(&open, "Work"), Some(None));
    assert_eq!(record_icon(&open, "Work/Plans/2026"), Some(None));
    assert_eq!(
        record_icon(&open, "Work/Plans"),
        None,
        "only the folder asked for"
    );
    let slots = open.vault.note_positions().all().unwrap();
    let slot = |path: &str| slots.iter().find(|s| s.path == path).map(|s| s.position);
    assert_eq!(slot("Work"), Some(-1), "above `Old`");
    assert_eq!(slot("Work/Plans/2026"), None);
}

#[test]
fn a_folder_created_again_keeps_its_icon() {
    let (_e, notes, open) = opened();
    notes.create_folder(&open, "Work").unwrap();
    notes
        .set_folder_config(&open, "Work", &input(Some(Some("lucide:book")), None, true))
        .unwrap();
    notes.create_folder(&open, "Work").unwrap();
    assert_eq!(record_icon(&open, "Work"), Some(Some("lucide:book".into())));
}

#[test]
fn the_tree_lists_folders_but_the_hidden_ones() {
    let (e, notes, open) = opened();
    for folder in [
        "b",
        "a/z",
        "a/y",
        ".hidden",
        "attachments/x",
        "canvases",
        "journal/2026",
    ] {
        fs::create_dir_all(e.vault.join(folder)).unwrap();
    }
    fs::write(e.vault.join("a/file.md"), "not a folder").unwrap();
    notes.create_folder(&open, "c").unwrap();
    let paths: Vec<String> = folders::list(&open)
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(paths, ["a", "a/y", "a/z", "b", "c"]);
}

#[test]
fn a_folders_icon_is_its_records_else_its_files() {
    let (e, notes, open) = opened();
    fs::create_dir_all(e.vault.join("Made outside")).unwrap();
    fs::write(
        e.vault.join("Made outside/.folder.md"),
        "---\nicon: 'emoji:⭐'\n---\n\n",
    )
    .unwrap();
    notes.create_folder(&open, "Recorded").unwrap();
    // The record answers even where the file says otherwise, as Electron's table does.
    fs::write(e.vault.join("Recorded/.folder.md"), "---\nicon: x\n---\n\n").unwrap();
    assert_eq!(
        folders::list(&open).unwrap(),
        [
            FolderView {
                path: "Made outside".into(),
                icon: Some("emoji:⭐".into())
            },
            FolderView {
                path: "Recorded".into(),
                icon: None
            },
        ]
    );
}

#[test]
fn a_config_write_keeps_the_views_and_mirrors_the_icon() {
    let (e, notes, open) = opened();
    fs::create_dir_all(e.vault.join("Work")).unwrap();
    let views = "views:\n  - id: v1\n    name: Table\n    type: table\n";
    fs::write(
        e.vault.join("Work/.folder.md"),
        format!("---\nicon: x\n{views}---\n\n"),
    )
    .unwrap();

    notes
        .set_folder_config(&open, "Work", &input(None, Some("daily"), true))
        .unwrap();
    assert_eq!(
        e.read("Work/.folder.md"),
        format!("---\nicon: x\ntemplate: daily\n{views}---\n\n")
    );
    assert_eq!(
        record_icon(&open, "Work"),
        Some(Some("x".into())),
        "an absent icon is kept"
    );

    notes
        .set_folder_config(&open, "Work", &input(Some(None), None, false))
        .unwrap();
    assert_eq!(
        e.read("Work/.folder.md"),
        format!("---\ninherit: false\n{views}---\n\n")
    );
    assert_eq!(record_icon(&open, "Work"), Some(None), "`null` clears it");
    let config = folders::config(&open, "Work").unwrap().unwrap();
    assert!(!config.inherit);
    assert_eq!(config.views.unwrap()[0]["name"], "Table");

    fs::write(e.vault.join("Work/.folder.md"), "---\nviews: [\n---\n").unwrap();
    assert!(
        folders::config(&open, "Work").unwrap().is_none(),
        "unreadable reads as none"
    );
    let refused = notes.set_folder_config(&open, "Work", &input(Some(Some("y")), None, true));
    assert!(
        matches!(refused, Err(NotesError::FolderFile(_))),
        "{refused:?}"
    );
    assert_eq!(e.read("Work/.folder.md"), "---\nviews: [\n---\n");
}

#[test]
fn a_folders_template_is_inherited_until_inherit_false() {
    let (_e, notes, open) = opened();
    notes
        .set_folder_config(&open, "", &input(None, Some("root-t"), true))
        .unwrap();
    notes
        .set_folder_config(&open, "a", &input(None, Some("a-t"), true))
        .unwrap();
    notes
        .set_folder_config(&open, "a/b/stop", &input(None, None, false))
        .unwrap();
    let template = |folder: &str| folders::template(&open, folder).unwrap();
    assert_eq!(template("a/b/c").as_deref(), Some("a-t"));
    assert_eq!(template("other").as_deref(), Some("root-t"));
    assert_eq!(template("a/b/stop/deeper"), None);
}

#[test]
fn a_folder_outside_the_vault_is_refused() {
    let (e, notes, open) = opened();
    for path in ["../out", "a/../../out", ""] {
        assert!(notes.create_folder(&open, path).is_err(), "{path}");
    }
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), e.vault.join("link")).unwrap();
        let refused = notes.create_folder(&open, "link/inside");
        assert!(matches!(refused, Err(NotesError::Outside)), "{refused:?}");
        assert!(!outside.path().join("inside").exists());
        let refused = notes.set_folder_config(&open, "link", &input(Some(Some("x")), None, true));
        assert!(refused.is_err());
        assert!(!outside.path().join(".folder.md").exists());
    }
    let _ = e;
}
