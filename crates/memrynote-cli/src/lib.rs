//! The `memrynote` command line (Step 35, #3552): the TypeScript CLI of `apps/cli` on the
//! desktop services, with the same commands, flags, output bytes and exit codes.
//!
//! `run.ts` and `cli-support.ts` are the source of truth until Step 43 freezes them. The golden
//! scenarios in `tests/golden/` hold this crate to their output byte for byte. A command group
//! that is not ported yet exits 1 with [`not_ported`]; `tests/golden/pending.json` lists those,
//! and it may only shrink.

pub mod console;
mod context;
mod locale;
mod migrate_installer;
pub mod output;
pub mod parse;
mod registry;
mod values;
mod vault;
mod vault_admin;

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::electron_import::profile::ProfileEnv;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, default_data_dir, profile_identifier};
use memry_desktop::registry::{AppConfig, CONFIG_FILE, VaultRegistry};

use crate::parse::ParsedCli;

/// The `identifier` of `apps/desktop-tauri/src-tauri/tauri.conf.json` (`build.rs`).
pub const BASE_IDENTIFIER: &str = env!("MEMRYNOTE_BASE_IDENTIFIER");

/// The usage line of `route` in `apps/cli/src/run.ts`.
const USAGE: &str = "Usage: memrynote [--vault <path>] <vault|notes|folders|properties|folder-view|tasks|projects|inbox|journal|tags|settings|locale|reminders|templates|bookmarks|saved-filters|calendar|sync|agent|graph|search|canvas|home-pages|icons|import|readwise>";

/// The command groups of `route` that have no Rust port yet. Each stage of #3552 removes the
/// groups it ports; `vault` and `locale` dispatch inside their modules.
const NOT_PORTED: [&str; 24] = [
    "notes",
    "folders",
    "properties",
    "folder-view",
    "tasks",
    "projects",
    "inbox",
    "journal",
    "tags",
    "settings",
    "reminders",
    "templates",
    "bookmarks",
    "saved-filters",
    "calendar",
    "sync",
    "agent",
    "graph",
    "search",
    "canvas",
    "home-pages",
    "icons",
    "import",
    "readwise",
];

/// Where the output lines go. Each call is one line without its newline.
pub trait CliIo {
    fn out(&mut self, line: &str);
    fn err(&mut self, line: &str);
}

/// A failed command. The message is the whole stderr output, as `run.ts` prints only
/// `error.message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError(pub String);

impl From<&str> for CliError {
    fn from(message: &str) -> Self {
        Self(message.to_owned())
    }
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

pub type CliResult = Result<(), CliError>;

/// What a run reads from its surroundings.
#[derive(Debug, Clone)]
pub struct CliDeps {
    /// The app data folder that holds `memry-config.json`, `None` when the platform has none.
    pub data_dir: Option<PathBuf>,
    /// The directory a relative vault reference resolves against (`path.resolve`).
    pub cwd: PathBuf,
    /// What `~` expands to (`os.homedir()`).
    pub home: Option<PathBuf>,
    /// Where an Electron profile would be, for the migration guard ([`context::check_app`]).
    pub electron_profile: Option<ProfileEnv>,
}

impl CliDeps {
    /// The process's surroundings under the launch switches `env` (the app's, after an e2e
    /// build overlaid its control file). `packaged` is the app's `!tauri::is_dev()`: it only
    /// changes the profile of the `dev` device (`memry_desktop::paths::profile_identifier`).
    pub fn from_env(env: &LaunchEnv, packaged: bool) -> Self {
        Self {
            data_dir: app_data_dir(env, packaged),
            cwd: std::env::current_dir().unwrap_or_default(),
            home: std::env::home_dir(),
            electron_profile: ProfileEnv::from_host(env),
        }
    }

    /// The registry the app keeps in its data folder, read when a command first needs it, as
    /// the TypeScript CLI reads the store. The TypeScript CLI had none outside the desktop
    /// launcher (`requireVaultRegistry`). The app owns the file: a bad one fails the command
    /// and is left for the app to set aside.
    fn registry(&self) -> Result<VaultRegistry, CliError> {
        let dir = self.data_dir.as_ref().ok_or(
            "No CLI vault registry is available. Pass --vault <path> or run Memry from the desktop app command.",
        )?;
        let config = AppConfig::load_strict(dir.join(CONFIG_FILE))
            .map_err(|error| CliError(error.to_string()))?;
        Ok(VaultRegistry::new(Arc::new(config)))
    }
}

/// The app data folder the app of this build uses: `MEMRY_APP_DATA_DIR` when set, else
/// Tauri's `app_data_dir()` for the profile identifier `main.rs` gives the app.
pub fn app_data_dir(env: &LaunchEnv, packaged: bool) -> Option<PathBuf> {
    let identifier = profile_identifier(BASE_IDENTIFIER, env, packaged, env!("MEMRY_CHECKOUT_DIR"));
    let default = default_data_dir(&identifier).unwrap_or_default();
    let dir = AppPaths::resolve(env, default, PathBuf::new()).data_dir;
    (!dir.as_os_str().is_empty()).then_some(dir)
}

/// Everything after the first `--cli`, as `getHeadlessCliArgs` of
/// `apps/desktop/src/main/cli/headless.ts`. The tokens before it (the executable, an app
/// path, the legacy Linux switches `--ozone-platform=headless --disable-gpu`) are ignored.
pub fn headless_args(argv: &[OsString]) -> Option<Vec<String>> {
    let index = argv.iter().position(|arg| arg == "--cli")?;
    Some(
        argv[index + 1..]
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect(),
    )
}

/// A `--cli` launch of the app binary (`runHeadlessCli`): `migrate-installer` first, then the
/// command line.
pub fn run_headless(args: Vec<String>, env: &LaunchEnv, packaged: bool) -> i32 {
    if args.first().map(String::as_str) == Some("migrate-installer") {
        return migrate_installer::run(&args[1..], &mut ProcessIo);
    }
    run_process(args, &CliDeps::from_env(env, packaged))
}

/// Runs one command line against the process's stdout and stderr and returns the exit code.
pub fn run_process(args: Vec<String>, deps: &CliDeps) -> i32 {
    let code = run_cli(&args, &mut ProcessIo, deps);
    let _ = std::io::stdout().flush();
    code
}

/// `runCli` of `run.ts`: 0 on success, 1 with the message on stderr on any failure.
pub fn run_cli(args: &[String], io: &mut dyn CliIo, deps: &CliDeps) -> i32 {
    let parsed = parse::parse_cli(args);
    match run(&parsed, io, deps) {
        Ok(()) => 0,
        Err(CliError(message)) => {
            io.err(&message);
            1
        }
    }
}

fn run(parsed: &ParsedCli, io: &mut dyn CliIo, deps: &CliDeps) -> CliResult {
    if parsed.command.as_deref() == Some("vault")
        && registry::run_registry_command(parsed, io, deps)?
    {
        return Ok(());
    }
    context::check_app(deps)?;
    // Resolved, checked and opened before any group runs (`createMemryApp`), so a command fails
    // on a missing, unusable or unmigrated vault the same way whether or not it is ported.
    let vault = match &parsed.vault_path {
        Some(path) => path.clone(),
        None => registry::resolve_default_vault_path(&deps.registry()?)?,
    };
    vault::check_path(&vault, &deps.cwd)?;
    let vault = context::open(&vault, deps)?;
    route(parsed, io, &vault)
}

fn route(parsed: &ParsedCli, io: &mut dyn CliIo, vault: &context::VaultContext) -> CliResult {
    match parsed.command.as_deref() {
        Some("vault") => vault::run(parsed, io, vault),
        Some("locale") => locale::run(parsed, io),
        Some(command) if NOT_PORTED.contains(&command) => Err(not_ported(parsed)),
        _ => Err(USAGE.into()),
    }
}

/// The error of a command that has no Rust port yet. Only builds of feat/tauri-v2 reach it:
/// Step 35 stage G deletes it with `tests/golden/pending.json`.
pub fn not_ported(parsed: &ParsedCli) -> CliError {
    let words = [parsed.command.as_deref(), parsed.subcommand.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    CliError(format!(
        "`memrynote {words}` is not available in this build yet."
    ))
}

/// Writes each line with a newline. A closed pipe is not an error of the command.
struct ProcessIo;

impl CliIo for ProcessIo {
    fn out(&mut self, line: &str) {
        let _ = writeln!(std::io::stdout().lock(), "{line}");
    }

    fn err(&mut self, line: &str) {
        let _ = writeln!(std::io::stderr().lock(), "{line}");
    }
}
