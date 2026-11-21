//! Electron's own output (`scene-file.ts`, `library-file.ts`), written by its
//! code into `scene_file.json` and `library.excalidrawlib`, reproduced byte for
//! byte.

use serde_json::Value;

use super::{FileMeta, library_text, read_file_meta, strip_file_meta, with_file_meta};

const SCENE_FILE: &str = include_str!("scene_file.json");
const LIBRARY_ITEMS: &str = include_str!("library_items.json");
const LIBRARY_FILE: &str = include_str!("library.excalidrawlib");

fn fixture() -> Value {
    serde_json::from_str(SCENE_FILE).expect("fixture")
}

fn meta_of(value: &Value) -> FileMeta {
    FileMeta {
        id: value["id"].as_str().expect("id").to_owned(),
        created_at: value["createdAt"].as_i64().expect("createdAt"),
        updated_at: value["updatedAt"].as_i64().expect("updatedAt"),
    }
}

#[test]
fn with_file_meta_writes_electrons_bytes_for_every_fixture_scene() {
    let fixture = fixture();
    let meta = meta_of(&fixture["meta"]);
    for case in fixture["cases"].as_array().expect("cases") {
        let scene = case["scene"].as_str().expect("scene");
        assert_eq!(
            with_file_meta(scene, &meta),
            case["file"].as_str().expect("file"),
            "case {}",
            case["name"]
        );
    }
}

#[test]
fn strip_file_meta_matches_electron_on_its_files_and_on_raw_scenes() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().expect("cases") {
        let name = &case["name"];
        let file = case["file"].as_str().expect("file");
        let scene = case["scene"].as_str().expect("scene");
        assert_eq!(
            strip_file_meta(file),
            case["strippedFile"],
            "file of {name}"
        );
        assert_eq!(
            strip_file_meta(scene),
            case["strippedScene"],
            "scene {name}"
        );
    }
}

#[test]
fn a_rewrite_of_an_unchanged_electron_file_is_byte_identical() {
    let fixture = fixture();
    let meta = meta_of(&fixture["meta"]);
    for case in fixture["cases"].as_array().expect("cases") {
        let file = case["file"].as_str().expect("file");
        assert_eq!(
            with_file_meta(&strip_file_meta(file), &meta),
            file,
            "case {}",
            case["name"]
        );
    }
}

#[test]
fn read_file_meta_matches_electron() {
    const NOW: i64 = 42;
    let fixture = fixture();
    for case in fixture["cases"].as_array().expect("cases") {
        let file = case["file"].as_str().expect("file");
        assert_eq!(
            read_file_meta(file, NOW),
            Some(meta_of(&case["meta"])),
            "case {}",
            case["name"]
        );
    }
    for case in fixture["metaCases"].as_array().expect("metaCases") {
        let content = case["content"].as_str().expect("content");
        let expected = case["meta"].as_object().map(|meta| {
            let instant = |key: &str| meta[key].as_f64().map_or(NOW, |ms| ms as i64);
            FileMeta {
                id: meta["id"].as_str().expect("id").to_owned(),
                created_at: instant("createdAt"),
                updated_at: instant("updatedAt"),
            }
        });
        assert_eq!(read_file_meta(content, NOW), expected, "{content}");
    }
}

#[test]
fn library_text_writes_electrons_library_file() {
    let items: Vec<Value> = serde_json::from_str(LIBRARY_ITEMS).expect("items");
    assert_eq!(library_text(&items), LIBRARY_FILE);
}
