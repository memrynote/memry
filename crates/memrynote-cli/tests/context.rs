//! The vault open and the migration guard, through `run_cli` over real folders: what a command
//! leaves on disk beside Electron data, a running app's move journal and its index.

use std::path::{Path, PathBuf};

use memry_desktop::electron_import::profile::{HostOs, ProfileEnv};
use memrynote_cli::{CliDeps, CliIo, run_cli};

const NOT_MIGRATED: &str = "MemryNote has not finished updating your data. Open MemryNote once, then run this command again.\n";
const OVER_ELECTRON: &str = "This vault still holds data of the previous MemryNote that was never brought over, so the command line cannot use it. Use this vault in MemryNote.\n";
const RECOVERING: &str = "MemryNote is repairing this vault's database. Open MemryNote and let it finish, then run this command again.\n";
const DAMAGED: &str = "This vault's database is damaged. Open MemryNote and choose Repair, then run this command again.\n";

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
        // One component at a time, so the path has the separators the CLI's own joins give.
        rel.split('/')
            .fold(self.dir.path().to_path_buf(), |dir, part| dir.join(part))
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

    // The app's own config does not end it: the app writes that before its import ran.
    write(&rig.path("appdata/memry-config.json"), b"{}");
    assert_eq!(rig.vault_status().2, NOT_MIGRATED);
    assert!(!vault.join(".memry").exists(), "nothing created");

    // The import's marker does.
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

/// A profile the app has nothing to import from (no config, no secrets) does not block.
#[test]
fn a_profile_without_config_or_secrets_does_not_block() {
    let rig = Rig::new();
    write(&rig.path("profile/Local State"), b"{}");
    assert_eq!(rig.vault_status().0, 0);
}

#[test]
fn a_profile_with_only_secrets_blocks() {
    let rig = Rig::new();
    write(&rig.path("profile/secure-secrets.json"), b"{}");
    assert_eq!(rig.vault_status(), (1, String::new(), NOT_MIGRATED.into()));
}

/// A profile search that fails blocks: what it could not read may be the user's data.
#[test]
fn a_profile_search_that_fails_blocks() {
    let rig = Rig::new();
    write(&rig.path("profile/memry-config.json"), b"{}");
    write(
        &rig.path("profile/app-identity.json"),
        br#"{"version":2,"appName":"memrynote"}"#,
    );
    write(&rig.path("appdata/memry-config.json"), b"{}");
    assert_eq!(rig.vault_status(), (1, String::new(), NOT_MIGRATED.into()));
}

/// A vault this core created (origin native) that Electron opened later: the core is the
/// vault's database, and the command line keeps working on it.
#[test]
fn a_native_vault_electron_opened_later_stays_open() {
    let rig = Rig::new();
    assert_eq!(rig.vault_status().0, 0);
    write(&rig.path("vault/.memry/data.db"), b"electron data");
    assert_eq!(rig.vault_status(), rig_ok(&rig));
}

fn rig_ok(rig: &Rig) -> (i32, String, String) {
    let vault = rig.path("vault");
    let status = serde_json::json!({ "isOpen": true, "path": vault });
    (
        0,
        format!("{}\n", serde_json::to_string_pretty(&status).expect("json")),
        String::new(),
    )
}

/// A core the app created over Electron's database without importing it: the command line
/// refuses with its own message, which does not promise that opening the app fixes it.
#[test]
fn a_core_created_over_electron_refuses_with_its_own_message() {
    let rig = Rig::new();
    write(&rig.path("vault/.memry/data.db"), b"electron data");
    let core = rig.path("vault/.memry/core");
    std::fs::create_dir(&core).expect("mkdir core");
    let vault = memry_core::api::vault::Vault::open_with(
        core.to_string_lossy().into_owned(),
        memry_core::storage::OpenOptions::default(),
    )
    .expect("core");
    vault
        .record_origin(memry_core::domain::notes::identity::Origin::OverElectron)
        .expect("origin");
    drop(vault);
    let (code, out, err) = rig.vault_status();
    assert_eq!((code, out.as_str()), (1, ""));
    assert_eq!(err, OVER_ELECTRON);
}

/// The app's recovery of a damaged `data.db` is under way: the command line neither runs it nor
/// touches its files.
#[test]
fn a_recovery_in_progress_is_left_to_the_app() {
    let rig = Rig::new();
    assert_eq!(rig.vault_status().0, 0);
    let db = rig.path("vault/.memry/core/data.db");
    let marker = rig.path("vault/.memry/core/data.db.recovering");
    write(&marker, b"");
    let before = std::fs::read(&db).expect("db");

    let (code, out, err) = rig.vault_status();
    assert_eq!((code, out.as_str(), err.as_str()), (1, "", RECOVERING));
    assert!(marker.exists(), "the marker is the app's");
    assert_eq!(std::fs::read(&db).expect("db"), before);
}

/// A damaged `data.db` the app has not repaired: the command line refuses and leaves it as found
/// (no migration, no journal), so the app's salvage gets every row the damage left.
#[test]
fn a_damaged_database_is_left_to_the_app() {
    let rig = Rig::new();
    assert_eq!(rig.vault_status().0, 0);
    let db = rig.path("vault/.memry/core/data.db");
    for side in ["data.db-wal", "data.db-shm"] {
        let _ = std::fs::remove_file(rig.path("vault/.memry/core").join(side));
    }
    let mut bytes = std::fs::read(&db).expect("db");
    bytes[..64].copy_from_slice(&[0xAB; 64]);
    std::fs::write(&db, &bytes).expect("damage");

    let (code, out, err) = rig.vault_status();
    assert_eq!((code, out.as_str(), err.as_str()), (1, "", DAMAGED));
    assert_eq!(std::fs::read(&db).expect("db"), bytes);
    assert!(!rig.path("vault/.memry/core/data.db-wal").exists());
}

/// Several commands that create a vault's core at once (a script, a running app). Some of them
/// can fail with `database is locked`: a migration's deferred transaction that read before
/// another process committed cannot upgrade to a write, and the switch to WAL
/// (`memry_core::storage::pragmas::configure_writer`) needs the database to itself. Both are
/// core's opener to fix (a core follow-up the PR names); the PR records the departure. None of
/// them may leave the vault half migrated: the next command opens it.
#[test]
fn concurrent_first_opens_leave_a_usable_vault() {
    let rig = Rig::new();
    let barrier = std::sync::Barrier::new(16);
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    rig.vault_status()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("join"))
            .collect()
    });
    for (code, _, err) in &results {
        assert!(*code == 0 || err.contains("database is locked"), "{err}");
    }
    assert_eq!(rig.vault_status(), rig_ok(&rig));
}

/// `vault reindex` beside a running app never sets a damaged index aside: the app's open handles
/// would lose their file. The command fails and the file stays byte for byte.
#[test]
fn a_reindex_refuses_a_damaged_index_and_leaves_it() {
    let rig = Rig::new();
    assert_eq!(rig.vault_status().0, 0);
    let core = rig.path("vault/.memry/core");
    write(&core.join("index.db"), b"damaged index");

    let vault = rig.path("vault");
    let (code, out, err) = rig.run(&[
        "--vault",
        vault.to_str().expect("utf-8"),
        "vault",
        "reindex",
    ]);
    assert_eq!((code, out.as_str()), (1, ""), "{err}");
    assert!(
        err.starts_with("The search index cannot be updated here"),
        "{err}"
    );
    assert_eq!(
        std::fs::read(core.join("index.db")).expect("index"),
        b"damaged index"
    );
    let siblings: Vec<_> = std::fs::read_dir(&core)
        .expect("core")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("index.db") && name != "index.db")
        .collect();
    assert!(siblings.is_empty(), "set aside: {siblings:?}");
}

/// `vault update-config` refuses a folder outside the vault (`vaultFolder`, #5678): nothing is
/// written or created.
#[test]
fn update_config_refuses_a_folder_outside_the_vault() {
    let rig = Rig::new();
    write(&rig.path("vault/.memry/config.json"), b"{}");
    let vault = rig.path("vault");
    let (code, _, err) = rig.run(&[
        "--vault",
        vault.to_str().expect("utf-8"),
        "vault",
        "update-config",
        r#"{"defaultNoteFolder":"../outside"}"#,
    ]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "Refusing to set defaultNoteFolder: \"../outside\" is the vault itself or outside it.\n"
    );
    assert!(!rig.path("outside").exists(), "a folder outside the vault");
    assert_eq!(
        std::fs::read(vault.join(".memry/config.json")).expect("config"),
        b"{}"
    );
}

/// `vault config` is a read: a config without the default keys stays as it is.
#[test]
fn vault_config_leaves_a_partial_config_as_it_is() {
    let rig = Rig::new();
    let partial = br#"{"theme":"kept","excludePatterns":["x"]}"#;
    write(&rig.path("vault/.memry/config.json"), partial);
    let vault = rig.path("vault");
    let (code, _, err) = rig.run(&["--vault", vault.to_str().expect("utf-8"), "vault", "config"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        std::fs::read(vault.join(".memry/config.json")).expect("config"),
        partial
    );
}

/// `vault update-config` waiting on the app's write (the vault config lock) keeps what the app
/// wrote meanwhile: the merge runs on the file as it is once the lock is taken.
#[test]
fn update_config_keeps_what_the_app_wrote_while_it_waited() {
    let rig = Rig::new();
    let config = rig.path("vault/.memry/config.json");
    write(&config, br#"{"theme":"old"}"#);
    let held = std::fs::File::create(rig.path("vault/.memry/config.json.lock")).expect("lock");
    held.lock().expect("hold");
    let vault = rig.path("vault");
    let vault = vault.to_str().expect("utf-8");
    std::thread::scope(|scope| {
        let cli = scope.spawn(|| {
            rig.run(&[
                "--vault",
                vault,
                "vault",
                "update-config",
                r#"{"custom":1}"#,
            ])
        });
        // Let the command open the vault and reach the lock: a lower bound, never asserted.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        std::fs::write(&config, br#"{"theme":"new"}"#).expect("the app's write");
        held.unlock().expect("release");
        let (code, _, err) = cli.join().expect("cli");
        assert_eq!(code, 0, "{err}");
    });
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&config).expect("config")).expect("json");
    assert_eq!(file["theme"], "new", "{file}");
    assert_eq!(file["custom"], 1, "{file}");
}

/// A folder through a link is refused (`vaultFolder`, #5723): a link can lead out of the vault.
#[cfg(unix)]
#[test]
fn update_config_refuses_a_folder_through_a_link() {
    let rig = Rig::new();
    write(&rig.path("vault/.memry/config.json"), b"{}");
    std::fs::create_dir(rig.path("elsewhere")).expect("elsewhere");
    std::os::unix::fs::symlink(rig.path("elsewhere"), rig.path("vault/link")).expect("link");
    let vault = rig.path("vault");
    let (code, _, err) = rig.run(&[
        "--vault",
        vault.to_str().expect("utf-8"),
        "vault",
        "update-config",
        r#"{"defaultNoteFolder":"link/sub"}"#,
    ]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "Refusing to set defaultNoteFolder: \"link\" is a link, and a path through a link can lead outside the vault.\n"
    );
    assert!(
        !rig.path("elsewhere/sub").exists(),
        "created outside the vault"
    );
    assert_eq!(
        std::fs::read(vault.join(".memry/config.json")).expect("config"),
        b"{}"
    );
}

/// An absolute folder lands inside the vault, as `path.join(vaultPath, folder)` put it.
#[test]
fn update_config_puts_an_absolute_folder_inside_the_vault() {
    let rig = Rig::new();
    write(&rig.path("vault/.memry/config.json"), b"{}");
    let vault = rig.path("vault");
    let (code, _, err) = rig.run(&[
        "--vault",
        vault.to_str().expect("utf-8"),
        "vault",
        "update-config",
        r#"{"journalFolder":"/abs/daily"}"#,
    ]);
    assert_eq!(code, 0, "{err}");
    assert!(
        rig.path("vault/abs/daily").is_dir(),
        "not created in the vault"
    );
}

/// A reindex that meets the app's write on `index.db` says the index is busy, not damaged,
/// and commits nothing.
#[test]
fn a_reindex_beside_a_writer_says_the_index_is_busy() {
    let rig = Rig::new();
    assert_eq!(rig.vault_status().0, 0);
    let index = rig.path("vault/.memry/core/index.db");
    drop(memry_core::storage::index_db::open_keeping(&index).expect("a fresh index"));
    let writer = rusqlite::Connection::open(&index).expect("writer");
    writer
        .execute_batch("BEGIN IMMEDIATE")
        .expect("hold the write lock");

    let vault = rig.path("vault");
    let (code, out, err) = rig.run(&[
        "--vault",
        vault.to_str().expect("utf-8"),
        "vault",
        "reindex",
    ]);
    assert_eq!((code, out.as_str()), (1, ""), "{err}");
    assert!(err.starts_with("The search index is busy"), "{err}");
    writer.execute_batch("ROLLBACK").expect("release");
}
