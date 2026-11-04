//! `.folder.md` against the files Electron writes and reads (Step 13h, #3530), and the guards of
//! a reader of vault files.
//!
//! | Test                                                        | Rule                                       |
//! | ----------------------------------------------------------- | ------------------------------------------ |
//! | electron writes are these bytes                             | `writeFolderConfig`, `folder-md.json`      |
//! | electron reads are this config                              | `readFolderConfig`                         |
//! | electron set-folder-config is these bytes                   | the merge of `notes:set-folder-config`     |
//! | keys and text no build models are kept                      | Electron drops them; a newer build's stay  |
//! | an unreadable file is never written over                    | #720: views lost to a silent `null`        |
//! | aliases cannot expand past the file / nest past the dumper  | untrusted input: steps and depth           |
//! | a write reads back as itself                                | proptest, output bounded                   |

use std::fs;

use memry_core::markdown::frontmatter::{
    Eol, YamlValue, json_to_yaml, stringify_frontmatter_block,
};
use memry_desktop::vault::folder_file::{
    self, FolderFile, FolderFileError, MAX_FOLDER_FILE_BYTES, node_budget, parse, steps,
};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;
use serde_json::{Value, json};

fn vectors() -> Value {
    let raw = include_str!("fixtures/electron-vault/folder-md.json");
    serde_json::from_str(raw).expect("the vectors")
}

/// A file holding `config`'s keys, as Electron's `FolderConfig` object holds them.
fn file_of(config: &Value) -> FolderFile {
    let YamlValue::Map(map) = json_to_yaml(config) else {
        panic!("a config is an object");
    };
    parse(&stringify_frontmatter_block(&map, Eol::Lf).expect("a block")).expect("a file")
}

#[test]
fn electron_writes_are_these_bytes() {
    for case in vectors()["writes"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = file_of(&case["config"]).serialize().unwrap();
        assert_eq!(bytes.as_deref(), case["bytes"].as_str(), "{name}");
    }
}

#[test]
fn electron_reads_are_this_config() {
    for case in vectors()["reads"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let read = parse(case["input"].as_str().unwrap()).map(|file| file.config());
        match name {
            // A frontmatter that is a list: Electron reads no keys and its next write replaces
            // the list; here the file is unreadable, so nothing replaces it.
            "frontmatter-list" => assert!(read.is_err(), "{name}"),
            _ => {
                let read = read
                    .ok()
                    .map(|config| serde_json::to_value(config).unwrap());
                assert_eq!(
                    read.as_ref(),
                    Some(&case["config"]).filter(|c| !c.is_null()),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn electron_set_folder_config_is_these_bytes() {
    for case in vectors()["sets"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut file = parse(case["before"].as_str().unwrap_or("")).unwrap();
        let config = &case["config"];
        let icon = match config.get("icon") {
            Some(icon) => icon.as_str().map(str::to_owned),
            None => file.icon().map(str::to_owned),
        };
        file.set(
            icon.as_deref(),
            config["template"].as_str(),
            config["inherit"].as_bool().unwrap(),
        );
        let bytes = file.serialize().unwrap();
        assert_eq!(bytes.as_deref(), case["bytes"].as_str(), "{name}");
    }
}

#[test]
fn keys_and_text_no_build_models_are_kept() {
    let mut file = parse("---\nicon: x\nsort: manual\n---\nA note to self\n").unwrap();
    file.set(None, Some("daily"), true);
    assert_eq!(
        file.serialize().unwrap().as_deref(),
        Some("---\ntemplate: daily\nsort: manual\n---\nA note to self\n")
    );
    // Nothing modelled left, the newer build's key still there: the file stays.
    file.set(None, None, true);
    assert_eq!(
        file.serialize().unwrap().as_deref(),
        Some("---\nsort: manual\n---\nA note to self\n")
    );
}

#[test]
fn an_unreadable_file_is_never_written_over() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path();
    fs::create_dir(vault.join("Work")).unwrap();
    let broken = "---\nviews: [\n---\n";
    fs::write(vault.join("Work/.folder.md"), broken).unwrap();
    let refused = folder_file::update(vault, "Work", |file| file.set(Some("x"), None, true));
    assert!(
        matches!(refused, Err(FolderFileError::Unreadable { .. })),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(vault.join("Work/.folder.md")).unwrap(),
        broken
    );

    let large = format!(
        "---\nicon: x\n---\n{}",
        "a".repeat(MAX_FOLDER_FILE_BYTES as usize)
    );
    fs::write(vault.join("Work/.folder.md"), &large).unwrap();
    assert!(matches!(
        folder_file::read(vault, "Work"),
        Err(FolderFileError::Unreadable { .. })
    ));
    let refused = folder_file::update(vault, "Work", |file| file.set(Some("y"), None, true));
    assert!(refused.is_err());
    assert_eq!(
        fs::read_to_string(vault.join("Work/.folder.md")).unwrap(),
        large
    );
}

#[test]
fn a_write_creates_the_folder_and_an_empty_config_removes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path();
    folder_file::update(vault, "a/b", |file| {
        file.set(Some("lucide:book"), None, true)
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(vault.join("a/b/.folder.md")).unwrap(),
        "---\nicon: 'lucide:book'\n---\n\n"
    );
    folder_file::update(vault, "a/b", |file| file.set(None, None, true)).unwrap();
    assert!(!vault.join("a/b/.folder.md").exists());
    assert!(matches!(
        folder_file::update(vault, "../out", |file| file.set(Some("x"), None, true)),
        Err(FolderFileError::Write { .. })
    ));
}

/// `levels` anchors, each a list of ten references to the one before: `10^levels` values once
/// expanded, from a few hundred bytes.
fn alias_bomb(levels: usize) -> String {
    let mut raw = String::from("---\nformulas:\n  l0: &l0 [x, x, x, x, x, x, x, x, x, x]\n");
    for level in 1..=levels {
        let prev = format!("*l{}", level - 1);
        let refs = [prev.as_str(); 10].join(", ");
        raw.push_str(&format!("  l{level}: &l{level} [{refs}]\n"));
    }
    raw + "---\n"
}

#[test]
fn aliases_cannot_expand_past_the_file() {
    let raw = alias_bomb(6);
    let bound = node_budget(raw.len()) + 1;
    assert_steps_at_most("an alias bomb", steps, bound, || {
        assert!(
            parse(&raw).is_err(),
            "a million values from {} bytes",
            raw.len()
        );
    });
}

/// `count` anchors, each wrapping the one before in `per` lists: `count * per` levels deep.
fn alias_tower(count: usize, per: usize) -> String {
    let mut raw = String::from("---\nviews:\n");
    for level in 0..count {
        let inner = if level == 0 {
            "x".to_owned()
        } else {
            format!("*t{}", level - 1)
        };
        let value = format!("{}{inner}{}", "[".repeat(per), "]".repeat(per));
        raw.push_str(&format!("  - &t{level} {value}\n"));
    }
    raw + "---\n"
}

#[test]
fn aliases_cannot_nest_past_the_dumper() {
    let deep = alias_tower(6, 60);
    on_small_stack(move || assert!(parse(&deep).is_err(), "360 levels"));
    // A file as deep as the reader takes is read and written back on a thread's stack.
    let deepest = alias_tower(3, 30);
    on_small_stack(move || {
        let file = parse(&deepest).unwrap_or_else(|e| panic!("90 levels: {e}"));
        assert!(file.config().views.is_some());
        let out = file.serialize().unwrap().unwrap();
        assert_output_bounded("a deep file", deepest.len(), out.len());
    });
}

/// Text with no white space at its end: gray-matter trims the YAML it writes, so a last value
/// ending in a line break and spaces loses them on the way to the file, in Electron as here.
fn text() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 :#'\"\\-_ğü📁\n]{0,24}".prop_map(|text| text.trim_end().to_owned())
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn a_write_reads_back_as_itself(
        icon in proptest::option::of(text()),
        template in proptest::option::of(text()),
        inherit in any::<bool>(),
        views in proptest::collection::vec(text(), 0..4),
        formulas in proptest::collection::btree_map("[a-z]{1,6}", text(), 0..4),
    ) {
        let config = json!({ "views": views.iter().map(|v| json!({ "name": v })).collect::<Vec<_>>(), "formulas": formulas });
        let (icon, template) = (icon.filter(|i| !i.is_empty()), template.filter(|t| !t.is_empty()));
        let mut file = file_of(&config);
        file.set(icon.as_deref(), template.as_deref(), inherit);
        let Some(bytes) = file.serialize().unwrap() else {
            return Ok(());
        };
        let again = parse(&bytes).unwrap();
        prop_assert_eq!(again.icon(), icon.as_deref());
        prop_assert_eq!(again.template(), template.as_deref());
        prop_assert_eq!(again.inherit(), inherit);
        let rewritten = again.serialize().unwrap().unwrap();
        prop_assert!(rewritten.len() <= output_bound(bytes.len()));
        prop_assert_eq!(rewritten, bytes);
    }
}
