//! `memry`, the headless client quickstart §G4 drives.
//!
//! The shell is a handful of files and nothing else: [`transport`] fills the
//! network seam, [`session`] fills the secure-store seam and owns the profile
//! directory, [`commands`] calls the core, [`edit`] is §G5's one write and [`push`] sends it. Every protocol decision — which
//! route, which retry, when to refresh, which status means what — is the
//! core's (Constitution I).

mod cli;
mod commands;
mod edit;
mod journal;
mod push;
mod session;
mod transport;

use cli::{Command, Invocation, Parsed};
use memry_core::api::runtime;
use session::{Cli, CliError};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(args) {
        Ok(Parsed::Help) => print!("{}", cli::HELP),
        Ok(Parsed::Run(invocation)) => {
            // The core's runtime, never a second one: the retry ladder and the
            // refresh timer have to share a timer wheel (research R5).
            if let Err(error) = runtime::block_on(run(*invocation)) {
                eprintln!("memry: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("memry: {error}");
            eprint!("{}", cli::HELP);
            std::process::exit(2);
        }
    }
}

async fn run(invocation: Invocation) -> Result<(), CliError> {
    let cli = Cli::open(invocation.server, invocation.client_platform)?;
    match invocation.command {
        Command::Login { email } => commands::login(&cli, &email).await,
        Command::Unlock {
            recovery_phrase_file,
        } => commands::unlock(&cli, &recovery_phrase_file).await,
        Command::Vaults => commands::vaults(&cli).await,
        Command::Pull { vault } => commands::pull(&cli, &vault).await,
        Command::Push { vault } => push::push(&cli, vault.as_deref()).await,
        Command::NotesList { vault } => commands::notes_list(&cli, vault.as_deref()),
        Command::NotesText { note, vault } => commands::notes_text(&cli, &note, vault.as_deref()),
        Command::NotesStateVector { note, vault } => {
            commands::notes_state_vector(&cli, &note, vault.as_deref())
        }
        Command::NotesFetch { note, vault } => {
            commands::notes_fetch(&cli, &note, vault.as_deref()).await
        }
        Command::NotesDigest { note, vault } => {
            commands::notes_digest(&cli, &note, vault.as_deref())
        }
        Command::NotesEdit {
            note,
            append,
            vault,
        } => edit::notes_append(&cli, &note, &append, vault.as_deref()),
        Command::JournalAppend { date, text, vault } => {
            journal::append(&cli, &date, &text, vault.as_deref())
        }
        Command::JournalTags { date, tags, vault } => {
            journal::tags(&cli, &date, &tags, vault.as_deref())
        }
        Command::JournalProperty {
            date,
            name,
            value_json,
            vault,
        } => journal::property(&cli, &date, &name, &value_json, vault.as_deref()),
    }
}
