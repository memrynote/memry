//! Canvas folders on a real temp vault: directories on disk and records through the core
//! (Electron's `canvas/folder-store.ts`, `folder-store.test.ts`).
//!
//! | Test                                                        | Electron                         |
//! | ----------------------------------------------------------- | -------------------------------- |
//! | a folder is a directory, found again in any case            | `folder-store.ts:323-375`        |
//! | a rename carries its canvases and their documents           | `folder-store.ts:395-545`        |
//! | a taken destination or a cycle is refused before the disk   | `folder-store.ts:412-428`        |
//! | a refused record write moves the directory back             | `folder-store.ts:520-533`        |
//! | a delete trashes the directory and never removes it otherwise | `folder-store.ts:650-741`      |
//! | the icon is a record change only                            | `folder-store.ts:617-635`        |

use memry_core::domain::canvas::folder_paths::CanvasFolderError;
use memry_desktop::canvas::folders::FolderError;

use crate::canvas_service::{NOW, refusing_trash, world, world_with};

#[test]
fn a_folder_is_a_directory_found_again_in_any_case() {
    let w = world();
    let work = w.canvases.create_folder(None, "Work", NOW).unwrap();
    assert_eq!(work.path, "Work");
    assert!(w.vault.join("canvases/Work").is_dir());
    assert_eq!(
        w.canvases.create_folder(None, "work", NOW).unwrap().id,
        work.id
    );

    let q3 = w.canvases.create_folder(Some("work"), "Q3", NOW).unwrap();
    assert_eq!(q3.path, "Work/Q3");
    assert!(w.vault.join("canvases/Work/Q3").is_dir());

    let reserved = w.canvases.create_folder(None, "con", NOW).unwrap();
    assert_eq!(reserved.path, "con canvas");
    let blank = w.canvases.create_folder(None, "  ", NOW);
    assert!(matches!(
        blank,
        Err(FolderError::Refused(CanvasFolderError::InvalidName))
    ));
    assert_eq!(w.canvases.list_folders().unwrap().len(), 3);
}

#[test]
fn a_rename_carries_its_canvases_and_their_documents() {
    let w = world();
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    let plan = w.create("Plan", Some("Work"), "a");
    let id = plan.canvas.summary.id.clone();

    let renamed = w
        .canvases
        .rename_folder("work", "Archive", NOW + 1)
        .unwrap();
    assert_eq!(renamed.unwrap().path, "Archive");
    assert!(!w.vault.join("canvases/Work").exists());
    let read = w.canvases.get(&id, NOW + 2).unwrap().unwrap();
    assert_eq!(read.summary.folder.as_deref(), Some("Archive"));
    assert!(read.scene.contains(r#""id":"a""#));

    w.save(&id, "ink-b");
    assert!(w.file("canvases/Archive/Plan.excalidraw").contains("ink-b"));
    assert!(
        w.canvases
            .rename_folder("Gone", "X", NOW)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_taken_destination_or_a_cycle_is_refused_before_the_disk() {
    let w = world();
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    w.canvases.create_folder(Some("Work"), "Q3", NOW).unwrap();
    std::fs::create_dir_all(w.vault.join("canvases/Archive")).unwrap();

    let taken = w.canvases.rename_folder("Work", "Archive", NOW + 1);
    let Err(error) = taken else {
        panic!("refused");
    };
    assert!(matches!(
        error,
        FolderError::Refused(CanvasFolderError::Exists)
    ));
    assert!(!error.to_string().contains("Archive"));
    assert_eq!(
        error.refusal(),
        Some(("CANVAS_FOLDER_EXISTS", "errors:canvasFolder.exists"))
    );
    assert!(w.vault.join("canvases/Work/Q3").is_dir());

    let cycle = w.canvases.move_folder("Work", Some("Work/Q3"), NOW + 1);
    assert!(matches!(
        cycle,
        Err(FolderError::Refused(CanvasFolderError::Descendant))
    ));
}

#[test]
fn a_refused_record_write_moves_the_directory_back() {
    let w = world();
    w.canvases
        .create_folder(Some("A/B/C/D/E/F"), "G", NOW)
        .unwrap();
    w.canvases.create_folder(Some("X"), "Y", NOW).unwrap();
    let plan = w.create("Plan", Some("X/Y"), "a");

    // `A/B/C/D/E/F/G/X` is 8 deep, so `X/Y` would land at 9.
    let deep = w.canvases.move_folder("X", Some("A/B/C/D/E/F/G"), NOW + 1);
    assert!(matches!(
        deep,
        Err(FolderError::Refused(CanvasFolderError::Depth))
    ));
    assert!(w.vault.join("canvases/X/Y/Plan.excalidraw").is_file());
    assert!(!w.vault.join("canvases/A/B/C/D/E/F/G/X").exists());
    assert!(w.scene_of(&plan.canvas.summary.id).contains(r#""id":"a""#));
}

#[test]
fn a_delete_trashes_the_directory_and_never_removes_it_otherwise() {
    let w = world();
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    let plan = w.create("Plan", Some("Work/Q3"), "a");
    let ids = w.canvases.delete_folder("work", NOW + 1).unwrap();
    assert_eq!(ids, vec![plan.canvas.summary.id.clone()]);
    assert!(!w.vault.join("canvases/Work").exists());
    assert!(w.vault.join(".trash/Work/Q3/Plan.excalidraw").is_file());
    assert!(
        w.canvases
            .get(&plan.canvas.summary.id, NOW)
            .unwrap()
            .is_none()
    );
    assert!(w.canvases.list_folders().unwrap().is_empty());

    let w = world_with(refusing_trash);
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    let plan = w.create("Plan", Some("Work"), "a");
    let ids = w.canvases.delete_folder("Work", NOW + 1).unwrap();
    assert_eq!(ids, vec![plan.canvas.summary.id]);
    assert!(w.vault.join("canvases/Work/Plan.excalidraw").is_file());
}

#[test]
fn the_icon_is_a_record_change_only() {
    let w = world();
    w.canvases.create_folder(None, "Work", NOW).unwrap();
    let iconed = w
        .canvases
        .set_folder_icon("work", Some("star"), NOW + 1)
        .unwrap();
    assert_eq!(iconed.unwrap().icon.as_deref(), Some("star"));
    assert!(
        w.canvases
            .set_folder_icon("Gone", None, NOW)
            .unwrap()
            .is_none()
    );
}
