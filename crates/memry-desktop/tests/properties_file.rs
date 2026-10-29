//! `<vault>/.memry/properties.md` is shared with Electron builds. Through the real owner, on
//! files Electron's own service read and rewrote (`fixtures/gen-properties-vectors.mjs`): the
//! same definitions come out and the same bytes go back, an entry this build cannot read
//! survives every write, a file it cannot read is never replaced, and a hostile file cannot
//! stall or crash a read.

use std::fs;
use std::path::Path;

use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::properties_file::{
    MAX_PROPERTIES_BYTES, PropertiesFileError, PropertyDefinition, PropertyKind, SelectOption,
    parse, properties_path, read, steps, update,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/electron-vault/properties-md.json");

fn vectors(kind: &str) -> Vec<Value> {
    let all: Value = serde_json::from_str(VECTORS).unwrap();
    all[kind].as_array().unwrap().clone()
}

fn vault_with(input: Option<&[u8]>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    if let Some(input) = input {
        fs::write(properties_path(dir.path()), input).unwrap();
    }
    dir
}

fn on_disk(vault: &Path) -> Option<Vec<u8>> {
    fs::read(properties_path(vault)).ok()
}

/// A `text` definition, read the way the file's are.
fn text_definition() -> PropertyDefinition {
    let file = parse("---\nproperties:\n  X: {type: text}\n---\n").unwrap();
    file.definitions.get("X").unwrap().clone()
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect()
}

#[test]
fn files_read_and_rewrite_as_electron_reads_and_rewrites_them() {
    for vector in vectors("reads") {
        let name = vector["name"].as_str().unwrap();
        let input = vector["input"].as_str().unwrap();
        let dir = vault_with(Some(input.as_bytes()));
        let read = read(dir.path());
        if !vector["readable"].as_bool().unwrap() {
            assert!(
                matches!(read, Err(PropertiesFileError::Unreadable { .. })),
                "{name}: {read:?}"
            );
            continue;
        }
        let file = read.unwrap_or_else(|error| panic!("{name}: {error}"));
        let defined: Vec<&str> = file.definitions.iter().map(|(name, _)| name).collect();
        assert_eq!(defined, names(&vector["definitions"]), "{name}");
        let unparsed: Vec<&str> = file.unparsed_names().collect();
        assert_eq!(unparsed, names(&vector["unparsed"]), "{name}");
        assert_eq!(file.healed(), vector["healed"].as_bool().unwrap(), "{name}");
        assert_eq!(
            file.serialize().unwrap(),
            vector["rewritten"].as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn edits_write_what_electron_writes() {
    for vector in vectors("ops") {
        let name = vector["name"].as_str().unwrap();
        let dir = vault_with(vector["input"].as_str().map(str::as_bytes));
        update(dir.path(), |definitions| {
            for op in vector["ops"].as_array().unwrap() {
                if let Some(target) = op["set"].as_str() {
                    let entry = parse(op["entry"].as_str().unwrap()).unwrap();
                    let definition = entry.definitions.get(target).unwrap().clone();
                    definitions.insert(target.to_owned(), definition);
                } else {
                    definitions.remove(op["delete"].as_str().unwrap());
                }
            }
        })
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        let written = on_disk(dir.path()).map(|bytes| String::from_utf8(bytes).unwrap());
        assert_eq!(written.as_deref(), vector["written"].as_str(), "{name}");
    }
}

/// Nested past the YAML loader's depth limit.
fn too_deep() -> Vec<u8> {
    format!(
        "---\nproperties:\n  A: {}{}\n---\n",
        "[".repeat(200),
        "]".repeat(200)
    )
    .into_bytes()
}

/// One option list read under every name that refers to it: 40000 options from 12 KB, ten
/// steps per byte where Electron's own aliases take two.
fn alias_bomb() -> String {
    let options = "{value: v, color: c},".repeat(200);
    let mut file = format!("---\nproperties:\n  A: {{type: select, options: &o [{options}]}}\n");
    for n in 0..200 {
        file.push_str(&format!("  B{n}: {{type: select, options: *o}}\n"));
    }
    file + "---\n"
}

#[test]
fn no_writer_replaces_a_file_it_cannot_read() {
    let too_big = vec![b' '; usize::try_from(MAX_PROPERTIES_BYTES).unwrap() + 1];
    for (what, corrupt) in [
        (
            "frontmatter that does not parse",
            b"---\nproperties: [\n---\n".to_vec(),
        ),
        // Electron reads this as no definitions, and its next write would hold only the new one.
        (
            "a blank line before the frontmatter",
            b"\n---\nproperties:\n  A: {type: text}\n---\n".to_vec(),
        ),
        ("properties a list", b"---\nproperties: [1]\n---\n".to_vec()),
        // JavaScript reads a date there as an object with no keys; the file is refused instead.
        (
            "properties a date",
            b"---\nproperties: 2024-01-02\n---\n".to_vec(),
        ),
        (
            "bytes that are not UTF-8",
            b"---\nproperties:\n  A\xff: {type: text}\n---\n".to_vec(),
        ),
        ("too large", too_big),
        ("nested past the depth limit", too_deep()),
        (
            "aliases that expand past the file",
            alias_bomb().into_bytes(),
        ),
    ] {
        let dir = vault_with(Some(&corrupt));
        let refused = |result: Result<_, PropertiesFileError>| {
            matches!(result, Err(PropertiesFileError::Unreadable { .. }))
        };
        assert!(refused(read(dir.path()).map(|_| ())), "{what}");
        let edit = update(dir.path(), |definitions| {
            definitions.insert("X".into(), text_definition());
        });
        assert!(refused(edit), "{what}");
        assert_eq!(
            on_disk(dir.path()),
            Some(corrupt),
            "{what}: the file is untouched"
        );
    }
}

#[test]
fn a_file_is_written_only_when_its_definitions_change() {
    // Missing, empty, or formatted by hand: an update that changes nothing leaves it alone,
    // and removing a name only an unparsed entry holds changes nothing (it stays, as in
    // Electron, which rewrites the file around it).
    for input in [
        None,
        Some(&b""[..]),
        Some(b"---\nproperties: {A: {type: text}}\n---\n"),
        Some(b"---\nproperties: {U: {type: stars}}\n---\n"),
    ] {
        let dir = vault_with(input);
        update(dir.path(), |definitions| definitions.remove("U")).unwrap();
        assert_eq!(on_disk(dir.path()).as_deref(), input);
    }
    // A relation entry is dropped on the next write even when nothing else changed.
    let dir = vault_with(Some(
        b"---\nproperties:\n  R: {type: relation}\n  A: {type: url}\n---\n",
    ));
    update(dir.path(), |_| {}).unwrap();
    assert_eq!(
        on_disk(dir.path()).unwrap(),
        b"---\nproperties:\n  A:\n    type: url\n    options: []\n---\n\n"
    );
}

#[test]
fn concurrent_writers_keep_each_others_definitions() {
    let dir = vault_with(None);
    let definition = text_definition();
    std::thread::scope(|scope| {
        for writer in 0..8 {
            let (vault, definition) = (dir.path(), definition.clone());
            scope.spawn(move || {
                for n in 0..10 {
                    update(vault, |definitions| {
                        definitions.insert(format!("w{writer}-{n}"), definition.clone());
                    })
                    .unwrap();
                }
            });
        }
    });
    assert_eq!(read(dir.path()).unwrap().definitions.len(), 80);
}

#[test]
fn a_file_another_writer_changed_meanwhile_is_not_overwritten() {
    // `change` runs between the read and the write: another process (an Electron build on
    // the same vault) writing there keeps its file, whether ours replaced or created it.
    let theirs = b"---\nproperties: {Theirs: {type: text}}\n---\n";
    for input in [Some(&b"---\nproperties: {A: {type: url}}\n---\n"[..]), None] {
        let dir = vault_with(input);
        let result = update(dir.path(), |definitions| {
            fs::write(properties_path(dir.path()), theirs).unwrap();
            definitions.insert("Ours".into(), text_definition());
        });
        assert!(
            matches!(result, Err(PropertiesFileError::Write { .. })),
            "{result:?}"
        );
        assert_eq!(on_disk(dir.path()).unwrap(), theirs);
    }
}

#[test]
fn an_edit_of_the_same_size_time_and_hash_is_not_overwritten() {
    // Only the bytes tell these apart: same size, the 32-bit hash Electron stores, and the
    // other writer puts the modification time back.
    let ours = "---\nproperties: {A: {type: url}}\n# b1\n---\n";
    let theirs = "---\nproperties: {A: {type: url}}\n# cP\n---\n";
    assert_eq!(content_hash(ours), content_hash(theirs));
    let dir = vault_with(Some(ours.as_bytes()));
    let path = properties_path(dir.path());
    let result = update(dir.path(), |definitions| {
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, theirs).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(modified).unwrap();
        definitions.insert("Ours".into(), text_definition());
    });
    assert!(
        matches!(result, Err(PropertiesFileError::Write { .. })),
        "{result:?}"
    );
    assert_eq!(on_disk(dir.path()).unwrap(), theirs.as_bytes());
}

#[test]
fn a_definition_no_build_reads_back_is_never_written() {
    // An empty `defaultValue` or `color` reads as none, and is left out of a write.
    let empties = parse("---\nproperties:\n  X: {type: text, defaultValue: '', color: ''}\n---\n");
    assert_eq!(
        empties.unwrap().definitions.get("X"),
        Some(&text_definition())
    );
    let dir = vault_with(None);
    let mut definition = text_definition();
    definition.default_value = Some(String::new());
    definition.color = Some(String::new());
    update(dir.path(), |definitions| {
        definitions.insert("X".into(), definition)
    })
    .unwrap();
    assert_eq!(
        on_disk(dir.path()).unwrap(),
        b"---\nproperties:\n  X:\n    type: text\n    options: []\n---\n\n"
    );
    // An option without a value or a color fails every build's schema, which would read the
    // entry as unparsed: the write is refused, and the file stays as it was.
    let before = on_disk(dir.path());
    for (value, color) in [("", "red"), ("v", "")] {
        let option = SelectOption {
            value: value.into(),
            color: color.into(),
            default: None,
        };
        let select = PropertyDefinition {
            kind: PropertyKind::Select(vec![option]),
            default_value: None,
            color: None,
        };
        let result = update(dir.path(), |definitions| {
            definitions.insert("S".into(), select)
        });
        assert!(
            matches!(result, Err(PropertiesFileError::Write { .. })),
            "{result:?}"
        );
        assert_eq!(on_disk(dir.path()), before);
    }
    let status = parse(
        "---\nproperties:\n  T:\n    type: status\n    categories:\n      todo: {label: T, options: []}\n      in_progress: {label: P, options: []}\n      done: {label: D, options: []}\n---\n",
    )
    .unwrap();
    let mut unlabeled = status.definitions.get("T").unwrap().clone();
    let PropertyKind::Status(categories) = &mut unlabeled.kind else {
        unreachable!()
    };
    categories.done.label = String::new();
    let result = update(dir.path(), |definitions| {
        definitions.insert("T".into(), unlabeled)
    });
    assert!(
        matches!(result, Err(PropertiesFileError::Write { .. })),
        "{result:?}"
    );
    assert_eq!(on_disk(dir.path()), before);
}

#[cfg(unix)]
#[test]
fn a_file_linked_out_of_the_vault_is_refused_not_followed() {
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = outside.path().join("properties.md");
    let content = b"---\nproperties:\n  A: {type: text}\n---\n";
    fs::write(&elsewhere, content).unwrap();
    let dir = vault_with(None);
    std::os::unix::fs::symlink(&elsewhere, properties_path(dir.path())).unwrap();
    assert!(matches!(
        read(dir.path()),
        Err(PropertiesFileError::Unreadable { .. })
    ));
    assert!(update(dir.path(), |definitions| definitions.remove("A")).is_err());
    assert_eq!(fs::read(&elsewhere).unwrap(), content);
}

#[test]
fn deep_and_aliased_files_are_safe_on_a_small_stack() {
    let refused = on_small_stack(|| {
        let dir = vault_with(Some(&too_deep()));
        matches!(
            read(dir.path()),
            Err(PropertiesFileError::Unreadable { .. })
        )
    });
    assert!(refused);
    // An unparsed entry nested just within the limit goes back as it came, on a write.
    let kept = on_small_stack(|| {
        let deep = format!("{}1{}", "[".repeat(90), "]".repeat(90));
        let input = format!("---\nproperties:\n  U: {{type: stars, v: {deep}}}\n---\n");
        let dir = vault_with(Some(input.as_bytes()));
        update(dir.path(), |definitions| {
            definitions.insert("X".into(), text_definition());
        })
        .unwrap();
        let file = read(dir.path()).unwrap();
        file.unparsed_names().eq(["U"]) && file.definitions.get("X").is_some()
    });
    assert!(kept);
    let bomb = alias_bomb();
    // Four steps per byte of the file, and the step that runs out is counted before it
    // fails: at most one more string, shorter than the file.
    assert_steps_at_most("the entry reader", steps, 5 * bomb.len(), || {
        assert!(parse(&bomb).is_err());
    });
}

/// Pieces of every construct the reader looks at, so random files reach each rule.
const PIECES: &[&str] = &[
    "  A:\n",
    "  '2':\n",
    "  B: {type: text}\n",
    "  C: [1]\n",
    "  D: &d {type: url}\n",
    "  E: *d\n",
    "    type: select\n",
    "    type: status\n",
    "    type: date\n",
    "    type: relation\n",
    "    type: stars\n",
    "    options:\n",
    "    options: []\n",
    "      - value: x\n",
    "        color: red\n",
    "        default: true\n",
    "      - {value: '', color: c}\n",
    "    categories:\n",
    "      todo: {label: T, options: []}\n",
    "      in_progress: {label: P, options: []}\n",
    "      done: {label: D, options: [{value: ok, color: g}]}\n",
    "    showOnCalendar: true\n",
    "    defaultValue: ''\n",
    "    color: null\n",
    "    when: 2024-01-02\n",
    "{",
    "}",
    "[",
    "]",
    ": ",
    "- ",
    "\n",
];

fn soup() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(PIECES), 0..30)
        .prop_map(|pieces| format!("---\nproperties:\n{}---\n", pieces.concat()))
}

proptest! {
    #![proptest_config(proptest_config(512))]

    /// Whatever reads reads back the same from its own rewrite, which is a fixpoint.
    #[test]
    fn any_readable_file_rewrites_to_a_fixpoint(input in soup()) {
        if let Ok(file) = parse(&input) {
            let written = file.serialize().unwrap();
            let again = parse(&written).unwrap();
            prop_assert_eq!(&again.definitions, &file.definitions);
            prop_assert!(again.unparsed_names().eq(file.unparsed_names()));
            prop_assert_eq!(again.serialize().unwrap(), written);
        }
    }
}
