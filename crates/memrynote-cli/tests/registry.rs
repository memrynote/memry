//! `vault use` and `vault remove` edit only the registry fields they own in the app's
//! `memry-config.json`: every other key, and every unknown field of an entry, survives.

use memrynote_cli::{CliDeps, CliIo, run_cli};
use serde_json::{Value, json};

#[derive(Default)]
struct Lines(String);

impl CliIo for Lines {
    fn out(&mut self, line: &str) {
        self.0.push_str(line);
    }
    fn err(&mut self, line: &str) {
        panic!("unexpected error: {line}");
    }
}

fn run(deps: &CliDeps, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let mut io = Lines::default();
    assert_eq!(run_cli(&args, &mut io, deps), 0);
    io.0
}

#[test]
fn use_and_remove_keep_every_key_they_do_not_own() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = dir.path().join("memry-config.json");
    let original = json!({
        "locale": "tr",
        "currentVault": "/v/a",
        "windowBounds": {"width": 1200},
        "vaults": [
            {"path": "/v/a", "name": "a", "noteCount": 3, "taskCount": 0,
             "lastOpened": "2026-01-02T03:04:05.678Z", "isDefault": true,
             "vaultUuid": "u-1", "futureField": {"kept": [1, 2]}},
            {"path": "/v/b", "name": "b", "noteCount": 1, "taskCount": 2,
             "lastOpened": "2026-01-03T03:04:05.678Z", "isDefault": false,
             "accountBinding": {"userId": "user", "mode": "sync"}}
        ],
        "sync": {"deviceId": "dev-1"}
    });
    std::fs::write(&config, serde_json::to_vec_pretty(&original).expect("json")).expect("seed");
    let deps = CliDeps {
        data_dir: Some(dir.path().to_path_buf()),
        cwd: dir.path().to_path_buf(),
        home: None,
    };

    run(&deps, &["vault", "use", "b"]);
    run(&deps, &["vault", "remove", "a", "--yes"]);

    let stored: Value =
        serde_json::from_slice(&std::fs::read(&config).expect("read")).expect("config");
    let mut expected = original;
    expected["currentVault"] = Value::Null;
    let only = {
        let mut b = expected["vaults"][1].clone();
        b["isDefault"] = Value::Bool(true);
        b
    };
    expected["vaults"] = json!([only]);
    assert_eq!(stored, expected);
    // The vault's files are never touched: the registry is the only file the commands write.
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .expect("dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names, ["memry-config.json"]);
}
