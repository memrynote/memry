//! The golden scenarios: this CLI against the output the TypeScript CLI recorded
//! (`tests/golden/generate.mjs`), plus the coverage ratchet over its case labels.
//!
//! `pending.json` lists the manifest entries without a Rust port. It may only shrink: CI holds it
//! to the base branch's (`generate.mjs --pending-base`). Every other entry needs a scenario step.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use memrynote_cli::output::stringify;
use memrynote_cli::parse::parse_cli;
use memrynote_cli::{CliDeps, CliIo, not_ported, run_cli};
use regex::Regex;
use serde_json::Value;

fn golden(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join(name)
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn json_files(dir: &str) -> Vec<(String, Value)> {
    let mut files: Vec<_> = std::fs::read_dir(golden(dir))
        .expect("golden dir")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned();
            (name, read_json(path))
        })
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.as_str().expect("string").to_owned())
        .collect()
}

struct Dirs {
    tmp: String,
    vault: String,
    home: String,
}

/// `expandTokens` of `normalize.mjs`.
fn expand(value: &Value, dirs: &Dirs, aliases: &[(String, String)]) -> Value {
    match value {
        Value::String(text) => {
            let mut out = text.clone();
            let named = [
                ("tmp", &dirs.tmp),
                ("vault", &dirs.vault),
                ("home", &dirs.home),
            ];
            for (name, replacement) in named
                .into_iter()
                .map(|(n, r)| (n.to_owned(), r.clone()))
                .chain(aliases.iter().cloned())
            {
                out = out.replace(&format!("{{{name}}}"), &replacement);
            }
            Value::String(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|i| expand(i, dirs, aliases)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), expand(v, dirs, aliases)))
                .collect(),
        ),
        other => other.clone(),
    }
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").expect("regex")
});
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
        .expect("regex")
});
static MS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[0-9]{13}(?-u:\b)").expect("regex"));
static BELOW_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<(?:vault|home|tmp)>(?:(?:\\\\|\\|/)[^\\/"'\s]+)+"#).expect("regex")
});

/// `normalize` of `normalize.mjs`. `ids` lives for one scenario.
fn normalize(text: &str, dirs: &Dirs, ids: &mut HashMap<String, String>) -> String {
    let mut out = text.to_owned();
    for (token, dir) in [
        ("<vault>", &dirs.vault),
        ("<home>", &dirs.home),
        ("<tmp>", &dirs.tmp),
    ] {
        let escaped = stringify(&Value::String(dir.clone()), None);
        out = out.replace(&escaped[1..escaped.len() - 1], token);
        out = out.replace(dir.as_str(), token);
    }
    out = BELOW_TOKEN
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            caps[0].replace(r"\\", "/").replace('\\', "/")
        })
        .into_owned();
    out = UUID
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            let next = format!("<id{}>", ids.len() + 1);
            ids.entry(caps[0].to_owned()).or_insert(next).clone()
        })
        .into_owned();
    let out = ISO.replace_all(&out, "<iso>");
    MS.replace_all(&out, "<ms>").into_owned()
}

#[derive(Default)]
struct Captured {
    stdout: String,
    stderr: String,
}

impl CliIo for Captured {
    fn out(&mut self, line: &str) {
        self.stdout.push_str(line);
        self.stdout.push('\n');
    }
    fn err(&mut self, line: &str) {
        self.stderr.push_str(line);
        self.stderr.push('\n');
    }
}

/// A scenario's temp folder, laid out as generate.mjs lays it out.
struct Rig {
    _dir: tempfile::TempDir,
    dirs: Dirs,
    deps: CliDeps,
}

fn rig(registry: &Value, files: &Value) -> Rig {
    let dir = tempfile::Builder::new()
        .prefix("memrynote-golden-")
        .tempdir()
        .expect("tempdir");
    // generate.mjs works under the real path (macOS `/var` is `/private/var`).
    #[cfg(unix)]
    let tmp = dir.path().canonicalize().expect("canonical tmp");
    #[cfg(not(unix))]
    let tmp = dir.path().to_path_buf();
    let path_text = |p: &Path| p.to_str().expect("utf-8 temp path").to_owned();
    let dirs = Dirs {
        tmp: path_text(&tmp),
        vault: path_text(&tmp.join("vault")),
        home: path_text(&tmp.join("home")),
    };
    let appdata = tmp.join("appdata");
    for path in [&tmp.join("vault"), &tmp.join("home"), &appdata] {
        std::fs::create_dir(path).expect("mkdir");
    }
    for (file, text) in files.as_object().into_iter().flatten() {
        let target = file
            .split('/')
            .fold(tmp.clone(), |path, part| path.join(part));
        std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
        std::fs::write(&target, text.as_str().expect("file text")).expect("write file");
    }
    if !registry.is_null() {
        let config = stringify(&expand(registry, &dirs, &[]), Some(2));
        std::fs::write(appdata.join("memry-config.json"), config).expect("write registry");
    }
    let deps = CliDeps {
        data_dir: Some(appdata),
        cwd: tmp.clone(),
        home: Some(tmp.join("home")),
    };
    Rig {
        _dir: dir,
        dirs,
        deps,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => stringify(other, None),
    }
}

#[test]
fn scenarios_match_the_typescript_cli() {
    let mut failures = Vec::new();
    let scenarios = json_files("scenarios");
    assert!(!scenarios.is_empty(), "no scenarios");
    for (file, scenario) in scenarios {
        let expected = read_json(&golden("expected").join(&file));
        let expected_steps = expected["steps"].as_array().expect("expected steps");
        let steps = scenario["steps"].as_array().expect("steps");
        assert_eq!(
            steps.len(),
            expected_steps.len(),
            "{file}: expected/ is stale, run generate.mjs"
        );
        let rig = rig(&scenario["registry"], &scenario["files"]);
        let mut aliases: Vec<(String, String)> = Vec::new();
        let mut ids = HashMap::new();
        for (index, (step, want)) in steps.iter().zip(expected_steps).enumerate() {
            assert_eq!(step["argv"], want["argv"], "{file}: expected/ is stale");
            let argv = strings(&expand(&step["argv"], &rig.dirs, &aliases));
            let mut io = Captured::default();
            let exit = run_cli(&argv, &mut io, &rig.deps);
            let got = (
                i64::from(exit),
                normalize(&io.stdout, &rig.dirs, &mut ids),
                normalize(&io.stderr, &rig.dirs, &mut ids),
            );
            let want = (
                want["exit"].as_i64().expect("exit"),
                want["stdout"].as_str().expect("stdout").to_owned(),
                want["stderr"].as_str().expect("stderr").to_owned(),
            );
            if got != want {
                failures.push(format!(
                    "{file} step {index} {argv:?}\n  want {want:?}\n  got  {got:?}"
                ));
            }
            if let Some(capture) = step["capture"].as_object() {
                let output: Value = serde_json::from_str(&io.stdout).expect("captured JSON");
                for (alias, path) in capture {
                    let value = path.as_str().expect("capture path").split('.').fold(
                        &output,
                        |value, key| match value {
                            Value::Array(items) => &items[key.parse::<usize>().expect("index")],
                            other => &other[key],
                        },
                    );
                    aliases.push((alias.clone(), js_string(value)));
                }
            }
            if let Some(ms) = step["sleepMs"].as_u64() {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn manifest_keys() -> BTreeSet<String> {
    read_json(&golden("manifest.json"))
        .as_array()
        .expect("manifest")
        .iter()
        .map(|entry| entry["key"].as_str().expect("key").to_owned())
        .collect()
}

fn pending() -> Vec<String> {
    strings(&read_json(&golden("pending.json")))
}

/// The command words of a step: command, subcommand and positionals, without the global
/// `--vault <path>` and `--json`.
fn words(argv: &[String]) -> Vec<String> {
    let parsed = parse_cli(argv);
    [parsed.command, parsed.subcommand]
        .into_iter()
        .flatten()
        .chain(parsed.positionals)
        .collect()
}

#[test]
fn every_manifest_entry_has_a_scenario_step() {
    let pending: BTreeSet<String> = pending().into_iter().collect();
    let steps: Vec<Vec<String>> = json_files("scenarios")
        .iter()
        .flat_map(|(_, scenario)| {
            scenario["steps"]
                .as_array()
                .expect("steps")
                .iter()
                .map(|step| words(&strings(&step["argv"])))
                .collect::<Vec<_>>()
        })
        .collect();
    let uncovered: Vec<_> = manifest_keys()
        .into_iter()
        .filter(|key| !pending.contains(key))
        .filter(|key| {
            let key: Vec<&str> = key.split(' ').collect();
            !steps.iter().any(|step| {
                step.iter()
                    .map(String::as_str)
                    .take(key.len())
                    .eq(key.iter().copied())
            })
        })
        .collect();
    assert!(
        uncovered.is_empty(),
        "entries with no scenario step: {uncovered:?}"
    );
}

#[test]
fn pending_is_sorted_and_in_the_manifest() {
    let pending = pending();
    let keys = manifest_keys();
    let mut sorted = pending.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(
        pending, sorted,
        "pending.json is sorted and has no duplicates"
    );
    let unknown: Vec<_> = pending.iter().filter(|key| !keys.contains(*key)).collect();
    assert!(
        unknown.is_empty(),
        "pending entries not in the manifest: {unknown:?}"
    );
}

#[test]
fn every_pending_entry_is_not_ported() {
    let rig = rig(&Value::Null, &Value::Null);
    let wrong: Vec<_> = pending()
        .into_iter()
        .filter_map(|key| {
            let argv: Vec<String> = ["--vault", rig.dirs.vault.as_str()]
                .into_iter()
                .chain(key.split(' '))
                .map(str::to_owned)
                .collect();
            let mut io = Captured::default();
            let exit = run_cli(&argv, &mut io, &rig.deps);
            let want = format!("{}\n", not_ported(&parse_cli(&argv)).0);
            (exit != 1 || io.stderr != want || !io.stdout.is_empty()).then_some(key)
        })
        .collect();
    assert!(wrong.is_empty(), "pending entries that run: {wrong:?}");
}

/// The Rust CLI prints what the TypeScript CLI printed. An entry here needs Kaan's approval.
#[test]
fn there_are_no_deliberate_differences() {
    assert_eq!(
        read_json(&golden("deliberate-differences.json")),
        Value::Array(Vec::new())
    );
}

#[test]
fn normalization_matches_the_generator() {
    for case in read_json(&golden("normalize-cases.json"))
        .as_array()
        .expect("cases")
    {
        let dirs = &case["dirs"];
        let dirs = Dirs {
            tmp: dirs["tmp"].as_str().expect("tmp").to_owned(),
            vault: dirs["vault"].as_str().expect("vault").to_owned(),
            home: dirs["home"].as_str().expect("home").to_owned(),
        };
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            normalize(input, &dirs, &mut HashMap::new()),
            case["output"].as_str().expect("output"),
            "{input}"
        );
    }
}
