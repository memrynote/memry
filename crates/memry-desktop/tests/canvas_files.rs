//! Canvas documents and the shapes library on a real temp vault: the disk cases of Electron's
//! `apps/desktop/src/main/canvas/scene-file.test.ts` and `library-file.ts`.
//!
//! | Test                                                      | Electron                          |
//! | --------------------------------------------------------- | --------------------------------- |
//! | a new document is written whole and read back             | `scene-file.test.ts:160,330`      |
//! | a missing document or a folder in its place reads as none | `scene-file.test.ts:170,349`      |
//! | a write never replaces a file changed since it was read   | departure: Electron overwrites    |
//! | listing finds documents at any depth up to the cap        | `scene-file.test.ts:180-189,380-390,468` |
//! | a path is allocated per folder, case-insensitively        | `scene-file.test.ts:194-218,295-315,358-372` |
//! | titles and folders get portable names                     | `scene-file.test.ts:281,290,402-458` |
//! | a stored path cannot leave the vault                      | `scene-file.test.ts:274`          |
//! | a rename keeps the old path when it cannot move           | `scene-file.test.ts:226-237`      |
//! | the library is Electron's file, written only on change    | `library-file.ts:48-91`           |

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use memry_core::domain::canvas::file_format::library_text;
use memry_core::domain::canvas::folder_paths::CanvasFolderError;
use memry_desktop::canvas::library::{read_canvas_library, write_canvas_library};
use memry_desktop::canvas::scene_file::{
    Expect, WriteError, allocate_canvas_path, folder_of_canvas_path, list_canvas_files,
    portable_canvas_folder, read_canvas_file, rename_canvas_file, resolve_canvas_file,
    write_canvas_file,
};
use serde_json::json;

fn vault() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("canvas-files")
        .tempdir()
        .unwrap()
}

fn put(vault: &Path, rel: &str, text: &str) {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn allocate(vault: &Path, title: Option<&str>, folder: Option<&str>) -> String {
    allocate_canvas_path(vault, title, &HashSet::new(), None, folder).unwrap()
}

#[test]
fn a_new_document_is_written_whole_and_read_back() {
    let dir = vault();
    let written =
        write_canvas_file(dir.path(), "canvases/Plan.excalidraw", "{\n}", Expect::New).unwrap();
    let read = read_canvas_file(dir.path(), "canvases/Plan.excalidraw")
        .unwrap()
        .unwrap();
    assert_eq!(read.text, "{\n}");
    assert_eq!(read.sha256, written);
    let names: Vec<_> = fs::read_dir(dir.path().join("canvases"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["Plan.excalidraw"], "no temp file is left behind");
    let again = write_canvas_file(dir.path(), "canvases/Plan.excalidraw", "x", Expect::New);
    assert!(matches!(again, Err(WriteError::Exists)));
    assert_eq!(
        fs::read_to_string(dir.path().join("canvases/Plan.excalidraw")).unwrap(),
        "{\n}"
    );
}

#[test]
fn a_missing_document_or_a_folder_in_its_place_reads_as_none() {
    let dir = vault();
    assert!(
        read_canvas_file(dir.path(), "canvases/None.excalidraw")
            .unwrap()
            .is_none()
    );
    fs::create_dir_all(dir.path().join("canvases/Dir.excalidraw")).unwrap();
    assert!(
        read_canvas_file(dir.path(), "canvases/Dir.excalidraw")
            .unwrap()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn a_document_linked_outside_the_vault_is_refused() {
    let dir = vault();
    let outside = vault();
    fs::write(outside.path().join("x.excalidraw"), "secret").unwrap();
    fs::create_dir_all(dir.path().join("canvases")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("x.excalidraw"),
        dir.path().join("canvases/Link.excalidraw"),
    )
    .unwrap();
    let read = read_canvas_file(dir.path(), "canvases/Link.excalidraw");
    assert!(matches!(
        read,
        Err(memry_desktop::canvas::scene_file::ReadError::Outside)
    ));
}

#[test]
fn a_write_never_replaces_a_file_changed_since_it_was_read() {
    let dir = vault();
    let rel = "canvases/Plan.excalidraw";
    put(dir.path(), rel, "as read");
    let read = read_canvas_file(dir.path(), rel).unwrap().unwrap();
    put(dir.path(), rel, "edited outside");
    let refused = write_canvas_file(dir.path(), rel, "app save", Expect::Unchanged(&read.sha256));
    assert!(matches!(refused, Err(WriteError::Changed)), "{refused:?}");
    assert_eq!(
        fs::read_to_string(dir.path().join(rel)).unwrap(),
        "edited outside"
    );

    let fresh = read_canvas_file(dir.path(), rel).unwrap().unwrap();
    write_canvas_file(
        dir.path(),
        rel,
        "app save",
        Expect::Unchanged(&fresh.sha256),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join(rel)).unwrap(),
        "app save"
    );

    fs::remove_file(dir.path().join(rel)).unwrap();
    let gone = write_canvas_file(dir.path(), rel, "late", Expect::Unchanged(&fresh.sha256));
    assert!(matches!(gone, Err(WriteError::Changed)));
}

#[test]
fn listing_finds_documents_at_any_depth_up_to_the_cap() {
    let dir = vault();
    assert!(list_canvas_files(dir.path()).is_empty());
    put(dir.path(), "canvases/b.excalidraw", "");
    put(dir.path(), "canvases/A.EXCALIDRAW", "");
    put(dir.path(), "canvases/notes.md", "");
    put(dir.path(), "canvases/library.excalidrawlib", "");
    put(dir.path(), "canvases/Work/Q3/plan.excalidraw", "");
    put(dir.path(), "canvases/.trash/gone.excalidraw", "");
    put(dir.path(), "canvases/.hidden.excalidraw", "");
    let eight = "canvases/1/2/3/4/5/6/7/8/deep.excalidraw";
    let nine = "canvases/1/2/3/4/5/6/7/8/9/deeper.excalidraw";
    put(dir.path(), eight, "");
    put(dir.path(), nine, "");
    assert_eq!(
        list_canvas_files(dir.path()),
        [
            eight,
            "canvases/A.EXCALIDRAW",
            "canvases/Work/Q3/plan.excalidraw",
            "canvases/b.excalidraw",
        ]
    );
}

#[test]
fn a_path_is_allocated_per_folder_case_insensitively() {
    let dir = vault();
    let v = dir.path();
    assert_eq!(allocate(v, Some("Plan"), None), "canvases/Plan.excalidraw");
    assert_eq!(allocate(v, Some("   "), None), "canvases/Canvas.excalidraw");
    assert_eq!(allocate(v, None, None), "canvases/Canvas.excalidraw");
    put(v, "canvases/Plan.excalidraw", "");
    assert_eq!(
        allocate(v, Some("plan"), None),
        "canvases/plan 2.excalidraw"
    );
    let taken = HashSet::from(["canvases/plan 2.excalidraw".to_owned()]);
    let next = allocate_canvas_path(v, Some("Plan"), &taken, None, None).unwrap();
    assert_eq!(next, "canvases/Plan 3.excalidraw");
    let own = allocate_canvas_path(
        v,
        Some("PLAN"),
        &HashSet::new(),
        Some("canvases/Plan.excalidraw"),
        None,
    );
    assert_eq!(own.unwrap(), "canvases/PLAN.excalidraw");
    put(v, "canvases/Cafe\u{301}.excalidraw", "");
    assert_eq!(
        allocate(v, Some("Caf\u{e9}"), None),
        "canvases/Caf\u{e9} 2.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("Plan"), Some("Work")),
        "canvases/Work/Plan.excalidraw"
    );
    put(v, "canvases/Work/Plan.excalidraw", "");
    assert_eq!(
        allocate(v, Some("Plan"), Some("Work")),
        "canvases/Work/Plan 2.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("Plan"), Some("Home")),
        "canvases/Home/Plan.excalidraw"
    );
}

#[test]
fn titles_and_folders_get_portable_names() {
    let dir = vault();
    let v = dir.path();
    assert_eq!(
        allocate(v, Some("CON"), None),
        "canvases/CON canvas.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("com0"), None),
        "canvases/com0 canvas.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("lpt\u{b9}"), None),
        "canvases/lpt\u{b9} canvas.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("Plan. . "), None),
        "canvases/Plan.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("../../etc/passwd"), None),
        "canvases/etcpasswd.excalidraw"
    );
    assert_eq!(
        allocate(v, Some("Plan"), Some("CON/aux.")),
        "canvases/CON canvas/aux canvas/Plan.excalidraw"
    );
    assert_eq!(
        portable_canvas_folder(Some("CON/aux.")).unwrap().as_deref(),
        Some("CON canvas/aux canvas")
    );
    assert_eq!(
        portable_canvas_folder(Some("CON canvas/aux canvas"))
            .unwrap()
            .as_deref(),
        Some("CON canvas/aux canvas")
    );
    assert_eq!(portable_canvas_folder(Some("")).unwrap(), None);
    let traversal = allocate(v, Some("Plan"), Some("../../outside"));
    assert!(
        traversal.starts_with("canvases/") && !traversal.split('/').any(|s| s == ".."),
        "{traversal}"
    );
    assert_eq!(
        folder_of_canvas_path("canvases/Work/Q3/Plan.excalidraw").as_deref(),
        Some("Work/Q3")
    );
    assert_eq!(folder_of_canvas_path("canvases/Plan.excalidraw"), None);
    let nine = Some("1/2/3/4/5/6/7/8/9");
    let deep = allocate_canvas_path(v, Some("Plan"), &HashSet::new(), None, nine);
    assert!(matches!(deep, Err(CanvasFolderError::Depth)), "{deep:?}");
}

#[test]
fn a_stored_path_cannot_leave_the_vault() {
    let dir = vault();
    assert!(resolve_canvas_file(dir.path(), "canvases/../../etc/passwd").is_err());
    assert!(
        resolve_canvas_file(dir.path(), "/etc/passwd").is_ok_and(|p| p.starts_with(dir.path()))
    );
    assert_eq!(
        resolve_canvas_file(dir.path(), "canvases/Work/Plan.excalidraw").unwrap(),
        dir.path()
            .join("canvases")
            .join("Work")
            .join("Plan.excalidraw")
    );
    assert!(read_canvas_file(dir.path(), "canvases/../x").is_err());
    let refused = write_canvas_file(dir.path(), "canvases/../x.excalidraw", "x", Expect::Any);
    assert!(refused.is_err());
    assert!(!dir.path().join("x.excalidraw").exists());
}

#[test]
fn a_rename_keeps_the_old_path_when_it_cannot_move() {
    let dir = vault();
    let v = dir.path();
    put(v, "canvases/Plan.excalidraw", "ink");
    let moved = rename_canvas_file(
        v,
        "canvases/Plan.excalidraw",
        "canvases/Work/Idea.excalidraw",
    );
    assert_eq!(moved, "canvases/Work/Idea.excalidraw");
    assert_eq!(
        fs::read_to_string(v.join("canvases/Work/Idea.excalidraw")).unwrap(),
        "ink"
    );
    assert_eq!(
        rename_canvas_file(v, "canvases/Gone.excalidraw", "canvases/B.excalidraw"),
        "canvases/Gone.excalidraw"
    );

    put(v, "canvases/Other.excalidraw", "other ink");
    let kept = rename_canvas_file(
        v,
        "canvases/Work/Idea.excalidraw",
        "canvases/Other.excalidraw",
    );
    assert_eq!(
        kept, "canvases/Work/Idea.excalidraw",
        "never replaces another document"
    );
    assert_eq!(
        fs::read_to_string(v.join("canvases/Other.excalidraw")).unwrap(),
        "other ink"
    );

    let recased = rename_canvas_file(v, "canvases/Other.excalidraw", "canvases/OTHER.excalidraw");
    assert_eq!(recased, "canvases/OTHER.excalidraw");
    assert_eq!(
        list_canvas_files(v),
        ["canvases/OTHER.excalidraw", "canvases/Work/Idea.excalidraw"]
    );
}

#[test]
fn the_library_is_electrons_file_written_only_on_change() {
    let dir = vault();
    let v = dir.path();
    assert!(read_canvas_library(v).unwrap().is_empty());
    let items = vec![json!({"id": "a", "status": "unpublished", "elements": []})];
    assert!(write_canvas_library(v, &items).unwrap());
    let rel = v.join("canvases/library.excalidrawlib");
    assert_eq!(fs::read_to_string(&rel).unwrap(), library_text(&items));
    assert_eq!(read_canvas_library(v).unwrap(), items);
    assert!(
        !write_canvas_library(v, &items).unwrap(),
        "an unchanged list is not written"
    );
    fs::write(&rel, "not json").unwrap();
    assert!(read_canvas_library(v).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_library_linked_outside_the_vault_is_neither_read_nor_saved() {
    let dir = vault();
    let outside = vault();
    let target = outside.path().join("lib.excalidrawlib");
    let text = library_text(&[json!({"id": "mine"})]);
    fs::write(&target, &text).unwrap();
    fs::create_dir_all(dir.path().join("canvases")).unwrap();
    std::os::unix::fs::symlink(&target, dir.path().join("canvases/library.excalidrawlib")).unwrap();
    assert!(read_canvas_library(dir.path()).unwrap().is_empty());
    assert!(!write_canvas_library(dir.path(), &[]).unwrap());
    assert_eq!(fs::read_to_string(&target).unwrap(), text);
    assert!(
        fs::symlink_metadata(dir.path().join("canvases/library.excalidrawlib"))
            .unwrap()
            .is_symlink()
    );
}
