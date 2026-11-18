//! The vault open and the migration guard, through `run_cli` over real folders: what a command
//! leaves on disk beside Electron data, a running app's move journal and its index.

use std::path::{Path, PathBuf};

use memry_desktop::electron_import::profile::{HostOs, ProfileEnv};
use memrynote_cli::{CliDeps, CliIo, run_cli};

const NOT_MIGRATED: &str = "MemryNote has not finished updating your data. Open MemryNote once, then run this command again.\n";

#[derive(Default)]
struct Captured {
    out: String,
    err: String,
}

impl CliIo for Captured {
    fn out(&mut self, line: &str) {
        self.out.push_str(line);
        self.out.push('\n');
    }
    fn err(&mut self, line: &str) {
        self.err.push_str(line);
        self.err.push('\n');
    }
}

struct Rig {
    dir: tempfile::TempDir,
    deps: CliDeps,
}

impl Rig {
    /// An app data folder with no `memry-config.json` and a profile search over `profile`.
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        for sub in ["appdata", "vault", "profile"] {
            std::fs::create_dir(dir.path().join(sub)).expect("mkdir");
        }
        let deps = CliDeps {
            data_dir: Some(dir.path().join("appdata")),
            cwd: dir.path().to_path_buf(),
            home: None,
            electron_profile: Some(ProfileEnv {
                app_data: dir.path().join("none"),
                override_dir: Some(dir.path().join("profile")),
                host: HostOs::current(),
            }),
        };
        Self { dir, deps }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let mut io = Captured::default();
        let code = run_cli(&args, &mut io, &self.deps);
        (code, io.out, io.err)
    }

    fn vault_status(&self) -> (i32, String, String) {
        let vault = self.path("vault");
        self.run(&["--vault", vault.to_str().expect("utf-8"), "vault", "status"])
    }
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(path, bytes).expect("write");
}

#[test]
fn an_unmigrated_app_fails_every_vault_command_and_creates_nothing() {
    let rig = Rig::new();
    write(&rig.path("profile/memry-config.json"), b"{}");

    assert_eq!(
        rig.run(&["vault", "list"]),
        (0, "[]\n".into(), String::new())
    );
    let vault = rig.path("vault");
    let notes = rig.run(&["--vault", vault.to_str().expect("utf-8"), "notes", "list"]);
    assert_eq!(notes, (1, String::new(), NOT_MIGRATED.into()));
    assert_eq!(rig.vault_status().2, NOT_MIGRATED);
    assert!(!vault.join(".memry").exists(), "nothing created");

    // The import's marker, or the app's own config, ends the guard.
    write(&rig.path("appdata/electron-import.json"), b"{}");
    assert_eq!(rig.vault_status().0, 0);
    assert!(vault.join(".memry/core/data.db").is_file());
}

#[test]
fn an_unmigrated_vault_fails_every_vault_command_and_creates_nothing() {
    let rig = Rig::new();
    let electron = rig.path("vault/.memry/data.db");
    write(&electron, b"electron data");

    assert_eq!(rig.vault_status(), (1, String::new(), NOT_MIGRATED.into()));
    assert!(!rig.path("vault/.memry/core").exists(), "no core beside it");
    assert_eq!(std::fs::read(&electron).expect("read"), b"electron data");

    // A core the app created there, before the import brought the data over.
    let core = rig.path("vault/.memry/core");
    std::fs::create_dir(&core).expect("mkdir core");
    drop(
        memry_core::api::vault::Vault::open_with(
            core.to_string_lossy().into_owned(),
            memry_core::storage::OpenOptions::default(),
        )
        .expect("core"),
    );
    assert_eq!(rig.vault_status(), (1, String::new(), NOT_MIGRATED.into()));

    let db = rusqlite::Connection::open(core.join("data.db")).expect("open core");
    db.execute(
        "INSERT INTO meta (key, value) VALUES ('electron_import.v1', '{\"version\":1}')",
        [],
    )
    .expect("proof row");
    drop(db);
    let (code, out, err) = rig.vault_status();
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains("\"isOpen\": true"), "{out}");
}

#[test]
fn a_bad_registry_fails_the_command_and_stays_as_it_is() {
    let rig = Rig::new();
    let config = rig.path("appdata/memry-config.json");
    write(&config, b"not json");
    let (code, out, err) = rig.run(&["vault", "list"]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert_eq!(
        err,
        format!(
            "the config file {} could not be read: it is not a JSON object\n",
            config.display()
        )
    );
    assert_eq!(std::fs::read(&config).expect("read"), b"not json");
}

/// The app's open puts back a folder move a crash interrupted; under a running app that move
/// may be in flight. The command line's open leaves it to the app.
#[test]
fn an_open_leaves_a_folder_move_in_flight_alone() {
    let rig = Rig::new();
    write(&rig.path("vault/.memry/config.json"), b"{}");
    let journal = rig.path("vault/.memry/moves/0123456789ab.json");
    let staged = rig.path("vault/.memry-move-0123456789ab/a.md");
    write(&journal, b"{}");
    write(&staged, b"# a\n");

    assert_eq!(rig.vault_status().0, 0);
    assert_eq!(std::fs::read(&journal).expect("journal"), b"{}");
    assert_eq!(std::fs::read(&staged).expect("staged note"), b"# a\n");
}

/// The index belongs to the app, which rebuilds a damaged one; the command line never opens it.
#[test]
fn an_open_never_touches_the_index() {
    let rig = Rig::new();
    let index = rig.path("vault/.memry/core/index.db");
    write(&rig.path("vault/.memry/config.json"), b"{}");
    write(&index, b"damaged index");

    assert_eq!(rig.vault_status().0, 0);
    assert_eq!(std::fs::read(&index).expect("index"), b"damaged index");
}
