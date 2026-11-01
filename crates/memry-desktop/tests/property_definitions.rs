//! Property definitions (#3530 Step 13k) over a real vault: `.memry/properties.md` through its
//! owner and the synced records through the core.
//!
//! | Test                                                        | Rule                                    |
//! | ----------------------------------------------------------- | --------------------------------------- |
//! | every edit writes the definitions Electron's service writes | `electron-writes-every-writer-*` files  |
//! | the file wins and the records fill in                       | union of reload + `mergeDatabaseDefinitions` |
//! | an unreadable file refuses every edit                       | `assertFileWritable`, #3048             |
//! | a create keeps what the type shares                         | `notes:create-` / `update-property-definition` |
//! | an edit of a missing or wrong definition says so            | `requireDefinition`, `addStatusOption`  |

mod device_key;

use std::fs;
use std::path::PathBuf;

use memry_core::api::vault::Vault;
use memry_core::domain::property_admin::records::{DefinitionRecord, DefinitionRecords};
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionType, DefinitionsError, EnsuredType, OptionInput,
    PropertyDefinitions, StatusCategoryKey,
};
use memry_desktop::vault::properties_file::{parse, properties_path};
use memry_test_kit::on_small_stack;
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/electron-vault/properties-md.json");

struct Fixture {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    definitions: PropertyDefinitions,
    /// The core's records under the service, to read what they hold.
    records: DefinitionRecords,
    core: Vault,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    let data = vault.join(".memry").join("core");
    fs::create_dir_all(&data).unwrap();
    let store = device_key::with_device_key();
    let core = Vault::open("vault".into(), data.to_string_lossy().into_owned()).unwrap();
    Fixture {
        definitions: PropertyDefinitions::new(
            vault.clone(),
            core.property_definition_records(store.clone()).unwrap(),
        ),
        records: core.property_definition_records(store).unwrap(),
        core,
        vault,
        _dir: dir,
    }
}

impl Fixture {
    fn file(&self) -> Option<String> {
        fs::read_to_string(properties_path(&self.vault)).ok()
    }

    fn set_file(&self, text: &str) {
        fs::write(properties_path(&self.vault), text).unwrap();
    }

    fn record(&self, name: &str) -> Option<DefinitionRecord> {
        let listed = self.records.list().unwrap();
        listed
            .into_iter()
            .find(|stored| stored.record.name == name)
            .map(|stored| stored.record)
    }

    fn queued(&self) -> i64 {
        self.core
            .db_handle()
            .call_blocking(|conn| {
                Ok(conn
                    .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .unwrap())
            })
            .unwrap()
    }
}

fn option(value: &str, color: &str) -> OptionInput {
    OptionInput {
        value: value.into(),
        color: color.into(),
        default: None,
    }
}

fn input(name: &str, type_name: Option<DefinitionType>) -> DefinitionInput {
    DefinitionInput {
        name: name.into(),
        type_name,
        options: None,
        default_value: None,
        color: None,
    }
}

fn record(
    name: &str,
    type_name: &str,
    options: Option<&str>,
    color: Option<&str>,
) -> DefinitionRecord {
    DefinitionRecord {
        name: name.into(),
        type_name: type_name.into(),
        options: options.map(str::to_owned),
        default_value: None,
        color: color.map(str::to_owned),
    }
}

/// The files Electron's `PropertyDefinitionsService` left after each step of
/// `everyWriter` (`fixtures/gen-properties-vectors.mjs`), and how this build rewrites them.
fn electron_steps() -> Vec<(String, String)> {
    let all: Value = serde_json::from_str(VECTORS).unwrap();
    all["reads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| {
            v["name"]
                .as_str()
                .unwrap()
                .starts_with("electron-writes-every-writer-")
        })
        .map(|v| {
            (
                v["input"].as_str().unwrap().to_owned(),
                v["rewritten"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

type Step = fn(&PropertyDefinitions) -> Result<(), DefinitionsError>;

/// `everyWriter`, each step as the command that does it. `None`: the step has no command here
/// (`project` is system-managed and not a type a create takes).
fn every_writer() -> Vec<Option<Step>> {
    use DefinitionType as T;
    vec![
        Some(|d| d.ensure("S", EnsuredType::Status)),
        Some(|d| d.ensure("T", EnsuredType::Status)),
        Some(|d| d.create(input("U", Some(T::Status))).map(drop)),
        Some(|d| d.add_status_option("S", StatusCategoryKey::Todo, option("Later", "sky"))),
        Some(|d| d.add_status_option("V", StatusCategoryKey::Done, option("Shipped", "green"))),
        Some(|d| d.set_option_color("T", "Done", "green")),
        Some(|d| d.remove_option("S", "Abandoned")),
        Some(|d| {
            let mut stage = input("Stage", Some(T::Select));
            stage.options = Some(vec![option("Idea", "sky")]);
            stage.default_value = Some("Idea".into());
            stage.color = Some("sky".into());
            d.create(stage).map(drop)
        }),
        Some(|d| d.add_option("Stage", option("Draft", "violet"))),
        Some(|d| d.rename_option("Stage", "Idea", "Thought")),
        Some(|d| d.set_option_color("Stage", "Draft", "rose")),
        Some(|d| d.remove_option("Stage", "Thought")),
        Some(|d| d.create(input("Tags", Some(T::Multiselect))).map(drop)),
        Some(|d| d.set_show_on_calendar("Due", true)),
        Some(|d| d.set_show_on_calendar("Due", false)),
        Some(|d| {
            let mut started = input("Started", Some(T::Date));
            started.color = Some("amber".into());
            d.create(started)?;
            d.set_show_on_calendar("Started", true)
        }),
        Some(|d| d.set_show_on_calendar("Started", false)),
        None,
        Some(|d| d.delete("U")),
        Some(|d| d.ensure("W", EnsuredType::Status)),
    ]
}

#[test]
fn every_edit_writes_the_definitions_electrons_service_writes() {
    let f = fixture();
    let steps = electron_steps();
    let writers = every_writer();
    assert_eq!(steps.len(), writers.len());
    for (at, ((electron, rewritten), writer)) in steps.iter().zip(writers).enumerate() {
        match writer {
            // Electron's own bytes: this build writes the same definitions without its aliases.
            Some(writer) => {
                writer(&f.definitions).unwrap_or_else(|e| panic!("step {}: {e}", at + 1));
                let ours = f.file().unwrap();
                assert_eq!(
                    parse(&ours).unwrap().definitions,
                    parse(electron).unwrap().definitions,
                    "step {}",
                    at + 1
                );
                assert_eq!(&ours, rewritten, "step {}", at + 1);
            }
            None => f.set_file(electron),
        }
        // The next step starts from Electron's file, so one wrong step fails alone.
        f.set_file(electron);
    }

    // Each record holds what the file holds, and a removed definition has none.
    let stage = r#"[{"value":"Draft","color":"rose"}]"#;
    let mut expected = record("Stage", "select", Some(stage), Some("sky"));
    expected.default_value = Some("Idea".into());
    assert_eq!(f.record("Stage"), Some(expected));
    assert_eq!(
        f.record("Started"),
        Some(record("Started", "date", None, Some("amber")))
    );
    assert_eq!(
        f.record("Tags"),
        Some(record("Tags", "multiselect", Some("[]"), None))
    );
    for gone in ["Due", "U", "project"] {
        assert_eq!(f.record(gone), None, "{gone}");
    }
    let s = f.record("S").unwrap().options.unwrap();
    let categories: Value = serde_json::from_str(&s).unwrap();
    assert_eq!(
        categories["categories"]["todo"]["options"][1],
        serde_json::json!({"value": "Later", "color": "sky"})
    );
    assert_eq!(
        categories["categories"]["done"]["options"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn the_file_wins_and_the_records_fill_in() {
    let f = fixture();
    f.set_file(
        "---\nproperties:\n  Stage:\n    type: select\n    options:\n      - value: A\n        color: sky\n  Due:\n    type: date\n    showOnCalendar: true\n---\n",
    );
    let now = 1_760_000_000_000;
    for stored in [
        record("Stage", "text", None, Some("rose")),
        record(
            "Area",
            "multiselect",
            Some(r#"[{"value":"Home","color":"sage"},{"value":"","color":"red"}]"#),
            None,
        ),
        record("Link", "relation", None, None),
    ] {
        f.records.put(&stored, now).unwrap();
    }

    let listed = f.definitions.list().unwrap();
    let shown: Vec<(&str, DefinitionType, Option<&str>)> = listed
        .iter()
        .map(|d| (d.name.as_str(), d.type_name, d.options.as_deref()))
        .collect();
    assert_eq!(
        shown,
        [
            (
                "Area",
                DefinitionType::Multiselect,
                Some(r#"[{"value":"Home","color":"sage"}]"#)
            ),
            ("Due", DefinitionType::Date, None),
            (
                "Stage",
                DefinitionType::Select,
                Some(r#"[{"value":"A","color":"sky"}]"#)
            ),
        ]
    );
    assert_eq!(listed[2].color, None);
    assert_eq!(listed[0].created_at, "2025-10-09T08:53:20.000Z");
    assert_eq!(listed[1].created_at, "");
    assert_eq!(f.definitions.calendar_names(), ["Due"]);

    // An edit of a name only a record holds puts it in the file, and the record follows the
    // file's definition of a name both hold.
    f.definitions
        .add_option("Area", option("Gym", "mint"))
        .unwrap();
    f.definitions
        .set_option_color("Stage", "A", "rose")
        .unwrap();
    let file = parse(&f.file().unwrap()).unwrap();
    let names: Vec<&str> = file.definitions.iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["Stage", "Due", "Area"]);
    let area = r#"[{"value":"Home","color":"sage"},{"value":"Gym","color":"mint"}]"#;
    assert_eq!(
        f.record("Area"),
        Some(record("Area", "multiselect", Some(area), None))
    );
    let stage = r#"[{"value":"A","color":"rose"}]"#;
    assert_eq!(
        f.record("Stage"),
        Some(record("Stage", "select", Some(stage), None))
    );
}

#[test]
fn an_unreadable_file_refuses_every_edit_and_keeps_both_stores() {
    let f = fixture();
    f.records
        .put(
            &record("Area", "select", Some("[]"), None),
            1_760_000_000_000,
        )
        .unwrap();
    let corrupt = "---\nproperties: [\n---\n";
    f.set_file(corrupt);
    let before = f.queued();
    let edits: Vec<Step> = vec![
        |d| d.create(input("New", Some(DefinitionType::Text))).map(drop),
        |d| d.update(input("Area", None)).map(drop),
        |d| d.ensure("Area", EnsuredType::Status),
        |d| d.add_option("Area", option("A", "sky")),
        |d| d.add_status_option("S", StatusCategoryKey::Todo, option("A", "sky")),
        |d| d.remove_option("Area", "A"),
        |d| d.rename_option("Area", "A", "B"),
        |d| d.set_option_color("Area", "A", "rose"),
        |d| d.delete("Area"),
        |d| d.set_show_on_calendar("Due", true),
    ];
    for (at, edit) in edits.into_iter().enumerate() {
        let error = edit(&f.definitions).unwrap_err();
        assert_eq!(
            error.kind_and_code(),
            (
                FailureKind::PropertyWrite,
                "property_definitions_unreadable"
            ),
            "edit {at}: {error}"
        );
        assert_eq!(f.file().as_deref(), Some(corrupt), "edit {at}");
        assert_eq!(f.queued(), before, "edit {at}");
    }
    // The records still show.
    let listed = f.definitions.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Area");
    assert!(f.definitions.calendar_names().is_empty());
}

#[test]
fn a_create_keeps_what_the_type_shares_and_an_update_what_it_does_not_name() {
    let f = fixture();
    let mut stage = input("Stage", Some(DefinitionType::Select));
    stage.options = Some(vec![option("A", "sky")]);
    stage.default_value = Some("A".into());
    stage.color = Some("rose".into());
    f.definitions.create(stage).unwrap();

    // Same type: the options and the default stay.
    let again = f
        .definitions
        .create(input("Stage", Some(DefinitionType::Select)))
        .unwrap()
        .unwrap();
    assert_eq!(
        again.options.as_deref(),
        Some(r#"[{"value":"A","color":"sky"}]"#)
    );
    assert_eq!(again.default_value.as_deref(), Some("A"));
    // Another type: only the color stays.
    let status = f
        .definitions
        .create(input("Stage", Some(DefinitionType::Status)))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            status.type_name,
            status.default_value,
            status.color.as_deref()
        ),
        (DefinitionType::Status, None, Some("rose"))
    );
    // An added option keeps only its value and color, as `PropertyOptionInputSchema` does.
    let review = OptionInput {
        default: Some(true),
        ..option("Review", "amber")
    };
    f.definitions
        .add_status_option("Stage", StatusCategoryKey::InProgress, review)
        .unwrap();
    // Ensuring the type it has changes nothing.
    f.definitions.ensure("Stage", EnsuredType::Status).unwrap();

    // An update without a type keeps the categories.
    let mut recolor = input("Stage", None);
    recolor.color = Some("sky".into());
    let updated = f.definitions.update(recolor).unwrap().unwrap();
    assert_eq!(updated.color.as_deref(), Some("sky"));
    assert!(updated.options.unwrap().contains(
        r#"[{"value":"In Progress","color":"amber"},{"value":"Review","color":"amber"}]"#
    ));
    assert_eq!(
        updated.created_at,
        f.definitions.list().unwrap()[0].created_at
    );
    assert_eq!(f.definitions.update(input("Missing", None)).unwrap(), None);
    assert_eq!(f.file().map(|file| file.contains("Missing")), Some(false));

    // Ensuring another list type keeps the options; showing it on the calendar makes it a date.
    let mut kind = input("Kind", Some(DefinitionType::Text));
    kind.options = Some(vec![option("X", "sky")]);
    kind.color = Some("rose".into());
    f.definitions.create(kind).unwrap();
    f.definitions
        .ensure("Kind", EnsuredType::Multiselect)
        .unwrap();
    let view = |name: &str| {
        let listed = f.definitions.list().unwrap();
        listed.into_iter().find(|d| d.name == name).unwrap()
    };
    let kind = view("Kind");
    assert_eq!(
        (
            kind.type_name,
            kind.options.as_deref(),
            kind.color.as_deref()
        ),
        (
            DefinitionType::Multiselect,
            Some(r#"[{"value":"X","color":"sky"}]"#),
            Some("rose")
        )
    );
    f.definitions.set_show_on_calendar("Kind", true).unwrap();
    let kind = view("Kind");
    assert_eq!((kind.type_name, kind.color), (DefinitionType::Date, None));
    assert_eq!(f.definitions.calendar_names(), ["Kind"]);

    // An update keeps the calendar flag and every field it does not name.
    let mut due = input("Kind", None);
    due.default_value = Some("today".into());
    f.definitions.update(due).unwrap();
    let mut recolor = input("Kind", None);
    recolor.color = Some("sky".into());
    let kind = f.definitions.update(recolor).unwrap().unwrap();
    assert_eq!(
        (kind.default_value.as_deref(), kind.color.as_deref()),
        (Some("today"), Some("sky"))
    );
    assert_eq!(f.definitions.calendar_names(), ["Kind"]);

    // An added list option keeps only its value and color too.
    let flagged = OptionInput {
        default: Some(true),
        ..option("New", "sky")
    };
    f.definitions.add_option("Fresh", flagged).unwrap();
    assert_eq!(
        view("Fresh").options.as_deref(),
        Some(r#"[{"value":"New","color":"sky"}]"#)
    );
}

#[test]
fn an_edit_of_a_missing_or_wrong_definition_says_so() {
    let f = fixture();
    let mut area = input("Area", Some(DefinitionType::Select));
    area.options = Some(vec![option("A", "sky")]);
    f.definitions.create(area).unwrap();
    f.definitions.ensure("St", EnsuredType::Status).unwrap();
    let before = f.file();
    let queued = f.queued();
    let missing: Vec<Step> = vec![
        |d| d.remove_option("Gone", "A"),
        |d| d.rename_option("Gone", "A", "B"),
        |d| d.set_option_color("Gone", "A", "rose"),
    ];
    for edit in missing {
        let error = edit(&f.definitions).unwrap_err();
        assert_eq!(error.to_string(), "No property definition named \"Gone\"");
        assert_eq!(error.kind_and_code().0, FailureKind::NotFound);
    }
    let error = f
        .definitions
        .add_status_option("Area", StatusCategoryKey::Done, option("Done", "green"))
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Property \"Area\" is not a status property"
    );
    for refused in [
        f.definitions.add_option("", option("A", "sky")),
        f.definitions.add_option("Area", option("", "sky")),
        f.definitions.add_option("Area", option("A", "")),
        f.definitions.rename_option("Area", "A", ""),
        f.definitions.set_option_color("Area", "A", ""),
        f.definitions
            .create(input("project", Some(DefinitionType::Project)))
            .map(drop),
        f.definitions
            .update(input("Area", Some(DefinitionType::Project)))
            .map(drop),
    ] {
        assert_eq!(refused.unwrap_err().kind_and_code().0, FailureKind::Invalid);
    }
    // An option the definition has already is not added twice.
    f.definitions
        .add_option("Area", option("A", "rose"))
        .unwrap();
    let todo = option("Not started", "rose");
    f.definitions
        .add_status_option("St", StatusCategoryKey::Todo, todo)
        .unwrap();
    // Nothing above reached either store.
    assert_eq!(f.file(), before);
    assert_eq!(f.queued(), queued);
}

/// A record from another device is untrusted: options nested far past any real definition read
/// as none on a small stack, and an edit of the name writes a definition every build reads.
#[test]
fn a_deeply_nested_synced_definition_reads_as_no_options() {
    on_small_stack(|| {
        let f = fixture();
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        let hostile = record("Deep", "select", Some(&deep), None);
        f.records.put(&hostile, 1_760_000_000_000).unwrap();
        let listed = f.definitions.list().unwrap();
        assert_eq!(listed[0].options.as_deref(), Some("[]"));
        f.definitions
            .add_option("Deep", option("A", "sky"))
            .unwrap();
        let file = parse(&f.file().unwrap()).unwrap();
        assert_eq!(
            format!("{:?}", file.definitions.get("Deep").unwrap().kind),
            r#"Select([SelectOption { value: "A", color: "sky", default: None }])"#
        );
    });
}
