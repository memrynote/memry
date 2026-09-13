//! The command surface, exactly as quickstart §G4 invokes it (T113).
//!
//! Parsing is hand-written and pure: one `Vec<String>` in, one [`Parsed`] out,
//! no environment read and no file touched. That is what lets the whole
//! surface be asserted in unit tests without a server, a keychain or a vault.
//!
//! The global options come **before** the command, as §G4 and §G5 write them:
//! `memry --server staging login --email …`, `memry --client-platform ios …`.

use std::fmt;
use std::path::PathBuf;

/// The default environment.
///
/// Staging, never production: there is no production test environment and a
/// headless client pointed at one writes to real users' vaults.
pub const DEFAULT_SERVER: &str = "staging";
pub const STAGING_URL: &str = "https://sync-staging.memrynote.com";
pub const PRODUCTION_URL: &str = "https://sync.memrynote.com";

/// Chapter 11 §11.2's platforms. The CLI is a desktop client unless it is
/// impersonating a phone for the §G5 kill-switch drill.
pub const DEFAULT_CLIENT_PLATFORM: &str = "desktop";

pub const HELP: &str = "\
memry — the headless Memry client

Usage:
  memry [--server <name|url>] [--client-platform <platform>] <command>

Commands:
  login --email <address>                request an email one-time code and register this device
  unlock --recovery-phrase-file <path>   derive the account master key from a 24-word phrase
  vaults                                 list the vaults on the account
  pull --vault <id>                      pull one vault's record feed into its local database
  notes list [--vault <id>]              print the pulled notes, newest first
  notes text <id> [--vault <id>]         print the note body's extracted text
  notes state-vector <id> [--vault <id>] print the note body's Y.Doc state vector, in hex
  notes edit <id> --append <text> [--vault <id>]
                                         append one paragraph block to the note body

Options:
  --server <name|url>          staging (the default), prod, local, or a base URL
  --client-platform <name>     ios, android or desktop (the default); the x-memry-client platform
  -h, --help                   print this help
";

/// Where the client points, and the profile directory that goes with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    /// A filesystem-safe name for this environment's local profile.
    pub label: String,
    pub base_url: String,
}

/// One of quickstart §G4's invocations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Login {
        email: String,
    },
    Unlock {
        recovery_phrase_file: PathBuf,
    },
    Vaults,
    Pull {
        vault: String,
    },
    NotesList {
        vault: Option<String>,
    },
    NotesText {
        note: String,
        vault: Option<String>,
    },
    NotesStateVector {
        note: String,
        vault: Option<String>,
    },
    /// Quickstart §G5's headless write: one `blockContainer > paragraph >
    /// text` node appended through yrs. Not a markdown path (chapter 12
    /// §12.1.2).
    NotesEdit {
        note: String,
        append: String,
        vault: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub server: Server,
    pub client_platform: String,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Help,
    Run(Box<Invocation>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    pub message: String,
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UsageError {}

fn usage<T>(message: impl Into<String>) -> Result<T, UsageError> {
    Err(UsageError {
        message: message.into(),
    })
}

/// `staging`, `prod`, `local`, or a base URL.
pub fn resolve_server(value: &str) -> Result<Server, UsageError> {
    match value {
        "staging" => Ok(Server {
            label: "staging".to_string(),
            base_url: STAGING_URL.to_string(),
        }),
        "prod" | "production" => Ok(Server {
            label: "production".to_string(),
            base_url: PRODUCTION_URL.to_string(),
        }),
        "local" => Ok(Server {
            label: "local".to_string(),
            base_url: "http://localhost:8787".to_string(),
        }),
        url if url.starts_with("http://") || url.starts_with("https://") => Ok(Server {
            label: label_for(url),
            base_url: url.trim_end_matches('/').to_string(),
        }),
        other => usage(format!(
            "unknown server `{other}`: expected staging, prod, local, or a base URL"
        )),
    }
}

/// A profile directory name for an arbitrary base URL.
fn label_for(url: &str) -> String {
    let host = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    host.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

pub fn parse(args: Vec<String>) -> Result<Parsed, UsageError> {
    let mut args = args.into_iter().peekable();
    let mut server = DEFAULT_SERVER.to_string();
    let mut client_platform = DEFAULT_CLIENT_PLATFORM.to_string();

    while let Some(argument) = args.peek() {
        match argument.as_str() {
            "-h" | "--help" | "help" => return Ok(Parsed::Help),
            "--server" => {
                args.next();
                server = value(&mut args, "--server")?;
            }
            "--client-platform" => {
                args.next();
                client_platform = value(&mut args, "--client-platform")?;
            }
            flag if flag.starts_with('-') => return usage(format!("unknown option `{flag}`")),
            _ => break,
        }
    }

    let Some(command) = args.next() else {
        return Ok(Parsed::Help);
    };
    let command = parse_command(&command, &mut args)?;
    if let Some(extra) = args.next() {
        return usage(format!("unexpected argument `{extra}`"));
    }

    Ok(Parsed::Run(Box::new(Invocation {
        server: resolve_server(&server)?,
        client_platform,
        command,
    })))
}

type Args = std::iter::Peekable<std::vec::IntoIter<String>>;

fn parse_command(name: &str, args: &mut Args) -> Result<Command, UsageError> {
    match name {
        "login" => Ok(Command::Login {
            email: required(args, "--email", "login")?,
        }),
        "unlock" => Ok(Command::Unlock {
            recovery_phrase_file: PathBuf::from(required(
                args,
                "--recovery-phrase-file",
                "unlock",
            )?),
        }),
        "vaults" => Ok(Command::Vaults),
        "pull" => Ok(Command::Pull {
            vault: required(args, "--vault", "pull")?,
        }),
        "notes" => parse_notes(args),
        other => usage(format!("unknown command `{other}`")),
    }
}

fn parse_notes(args: &mut Args) -> Result<Command, UsageError> {
    let Some(subcommand) = args.next() else {
        return usage("notes needs a subcommand: list, text, state-vector, or edit");
    };
    match subcommand.as_str() {
        "list" => Ok(Command::NotesList {
            vault: optional(args, "--vault")?,
        }),
        // Every note subcommand takes `--vault`, because every one of them
        // resolves a vault and refuses when a profile holds more than one.
        // `notes text` used to print "say which one with --vault" and then
        // reject `--vault` as an unexpected argument: an error message whose
        // instruction does not exist is a dead end, and the only way out was
        // to guess.
        "text" => {
            let note = positional(args, "notes text", "a note id")?;
            Ok(Command::NotesText {
                note,
                vault: optional(args, "--vault")?,
            })
        }
        "state-vector" => {
            let note = positional(args, "notes state-vector", "a note id")?;
            Ok(Command::NotesStateVector {
                note,
                vault: optional(args, "--vault")?,
            })
        }
        "edit" => {
            let note = positional(args, "notes edit", "a note id")?;
            let append = required(args, "--append", "notes edit")?;
            Ok(Command::NotesEdit {
                note,
                // `--append` is required rather than optional: it is the only
                // edit this client makes, and an `edit` that did nothing
                // would be a successful command that changed no note.
                append,
                vault: optional(args, "--vault")?,
            })
        }
        other => usage(format!("unknown notes subcommand `{other}`")),
    }
}

fn value(args: &mut Args, flag: &str) -> Result<String, UsageError> {
    match args.next() {
        Some(value) if !value.starts_with('-') => Ok(value),
        _ => usage(format!("{flag} needs a value")),
    }
}

fn required(args: &mut Args, flag: &str, command: &str) -> Result<String, UsageError> {
    match args.next() {
        Some(found) if found == flag => value(args, flag),
        Some(found) => usage(format!("{command} takes {flag}, not `{found}`")),
        None => usage(format!("{command} needs {flag}")),
    }
}

fn optional(args: &mut Args, flag: &str) -> Result<Option<String>, UsageError> {
    match args.peek() {
        Some(found) if found == flag => {
            args.next();
            value(args, flag).map(Some)
        }
        Some(found) => usage(format!("unexpected argument `{found}`")),
        None => Ok(None),
    }
}

fn positional(args: &mut Args, command: &str, what: &str) -> Result<String, UsageError> {
    match args.next() {
        Some(value) if !value.starts_with('-') => Ok(value),
        _ => usage(format!("{command} needs {what}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(line: &str) -> Result<Parsed, UsageError> {
        parse(line.split_whitespace().map(str::to_string).collect())
    }

    fn invocation(line: &str) -> Invocation {
        match run(line).expect("the line parses") {
            Parsed::Run(invocation) => *invocation,
            Parsed::Help => panic!("expected a command, got help"),
        }
    }

    #[test]
    fn the_quickstart_g4_invocations_parse_exactly_as_written() {
        let login = invocation("--server staging login --email person@example.test");
        assert_eq!(login.server.base_url, STAGING_URL);
        assert_eq!(
            login.command,
            Command::Login {
                email: "person@example.test".to_string()
            }
        );

        assert_eq!(
            invocation("unlock --recovery-phrase-file phrase.txt").command,
            Command::Unlock {
                recovery_phrase_file: PathBuf::from("phrase.txt")
            }
        );
        assert_eq!(invocation("vaults").command, Command::Vaults);
        assert_eq!(
            invocation("pull --vault v-1").command,
            Command::Pull {
                vault: "v-1".to_string()
            }
        );
        assert_eq!(
            invocation("notes list --vault v-1").command,
            Command::NotesList {
                vault: Some("v-1".to_string())
            }
        );
        assert_eq!(
            invocation("notes text note-1").command,
            Command::NotesText {
                note: "note-1".to_string(),
                vault: None
            }
        );
        // The dead end this closed: `notes text` printed "say which one with
        // --vault" and then rejected `--vault` as an unexpected argument.
        assert_eq!(
            invocation("notes text note-1 --vault v-1").command,
            Command::NotesText {
                note: "note-1".to_string(),
                vault: Some("v-1".to_string())
            }
        );
        assert_eq!(
            invocation("notes state-vector note-1").command,
            Command::NotesStateVector {
                note: "note-1".to_string(),
                vault: None
            }
        );
        assert_eq!(
            invocation("notes state-vector note-1 --vault v-1").command,
            Command::NotesStateVector {
                note: "note-1".to_string(),
                vault: Some("v-1".to_string())
            }
        );
    }

    #[test]
    fn the_quickstart_g5_append_parses_exactly_as_written() {
        // §G5 writes it with a quoted value; the shell hands it over as one
        // argument, so the parser must take a value with a space in it.
        let parsed = parse(
            ["notes", "edit", "note-1", "--append", "from cli"]
                .iter()
                .map(|part| part.to_string())
                .collect(),
        )
        .expect("the line parses");
        let Parsed::Run(invocation) = parsed else {
            panic!("expected a command, got help");
        };
        assert_eq!(
            invocation.command,
            Command::NotesEdit {
                note: "note-1".to_string(),
                append: "from cli".to_string(),
                vault: None,
            }
        );
    }

    #[test]
    fn the_environment_defaults_to_staging_and_the_platform_to_desktop() {
        let vaults = invocation("vaults");
        assert_eq!(vaults.server.label, "staging");
        assert_eq!(vaults.server.base_url, STAGING_URL);
        assert_eq!(vaults.client_platform, "desktop");

        // §G5 flips the platform for the kill-switch drill.
        assert_eq!(
            invocation("--client-platform ios vaults").client_platform,
            "ios"
        );
    }

    #[test]
    fn a_base_url_gets_its_own_profile_and_prod_is_named_in_full() {
        let custom = invocation("--server http://127.0.0.1:8787/ vaults");
        assert_eq!(custom.server.base_url, "http://127.0.0.1:8787");
        assert_eq!(custom.server.label, "127-0-0-1-8787");
        assert_eq!(
            invocation("--server prod vaults").server,
            Server {
                label: "production".to_string(),
                base_url: PRODUCTION_URL.to_string(),
            }
        );
    }

    #[test]
    fn a_missing_argument_is_a_usage_error_and_never_a_default() {
        for line in [
            "login",
            "login --email",
            "login --address person@example.test",
            "unlock",
            "pull",
            "notes",
            "notes text",
            "notes sing note-1",
            "notes edit",
            "notes edit note-1",
            "notes edit note-1 --append",
            "notes edit --append text",
            "--server nowhere vaults",
            "--server",
            "sync --once",
            "vaults --loud",
        ] {
            assert!(run(line).is_err(), "`{line}` should not parse");
        }
    }

    #[test]
    fn help_is_reachable_and_names_every_command() {
        assert_eq!(run("--help"), Ok(Parsed::Help));
        assert_eq!(run("-h"), Ok(Parsed::Help));
        assert_eq!(run(""), Ok(Parsed::Help));
        for command in [
            "login",
            "unlock --recovery-phrase-file",
            "vaults",
            "pull --vault",
            "notes list",
            "notes text",
            "notes state-vector",
            "notes edit",
        ] {
            assert!(HELP.contains(command), "help omits `{command}`");
        }
    }
}
