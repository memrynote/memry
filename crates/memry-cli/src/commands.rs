//! The six §G4 commands. Each one is core calls plus printing.
//!
//! What is deliberately absent: any route, any retry, any status check, and
//! any markdown. `notes text` prints `extract_text` output — the core has no
//! markdown serialiser and neither does this crate (chapter 12, T123).

use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::Arc;

use memry_core::api::crypto::{
    account_key_verifier, account_key_verifier_matches, derive_master_key, derive_vault_key,
    validate_recovery_phrase,
};
use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::{DocumentRegistry, UpdateSink};
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::crypto::keys::base64_decode;
use memry_core::protocol::account::{self, AccountCipher, VaultSummary};
use memry_core::protocol::types::Declaration;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::Db;
use memry_core::sync::body_pull::BodyPull;
use memry_core::sync::pull::{PullLoop, PullReport};

use crate::session::{Cli, CliError};

/// How many pages one `pull` drains before it stops and says `hasMore`.
///
/// A ceiling, not a protocol constant: the loop stops at the end of the feed or
/// at the first refused page anyway (chapter 05 §5.14), and this only bounds a
/// single command invocation.
const MAX_PULL_PAGES: u32 = 1_000;

/// The device id the read-only document registry runs under.
///
/// Reading a body never writes an update, so the Yjs client id this derives
/// affects nothing on this path; a write path would take the registered device
/// id instead (chapter 07).
const READER_DEVICE_ID: &str = "memry-cli-reader";

/// `login --email <address>`: chapter 02's OTP path, then registration.
pub async fn login(cli: &Cli, email: &str) -> Result<(), CliError> {
    let session = cli.session()?;
    session.request_email_code(email.to_string()).await?;
    eprintln!("a six-digit code was sent to {email}");

    let code = prompt("one-time code: ")?;
    session.verify_email_code(code).await?;
    let state = session.register_device().await?;

    println!("signed in as {email}");
    println!("state {state:?}");
    Ok(())
}

/// `unlock --recovery-phrase-file <path>`: chapter 01 §1.1's three steps, then
/// the account key verifier.
pub async fn unlock(cli: &Cli, path: &std::path::Path) -> Result<(), CliError> {
    let phrase = std::fs::read_to_string(path)?;
    // Validated before anything is derived, and before the network is touched:
    // chapter 01 §1.3 never runs a derivation on an unvalidated phrase.
    let phrase = validate_recovery_phrase(phrase)?;

    let http = cli.http()?;
    let material = account::key_material(&http).await?;
    let master_key = derive_master_key(phrase, base64_decode(&material.kdf_salt)?)?;

    // Chapter 02 §2.7.1: on this route the account is known, so a mismatch does
    // mean the phrase is wrong, and nothing is persisted before it passes.
    if !account_key_verifier_matches(
        account_key_verifier(master_key.clone())?,
        material.key_verifier,
    ) {
        return Err(CliError::Refused(
            "that recovery phrase does not match this account".to_string(),
        ));
    }

    cli.store().set(SecureStoreKey::MasterKey, master_key)?;
    println!("unlocked");
    Ok(())
}

/// `vaults`: the registry, which is also how a vault id for `pull` is found.
pub async fn vaults(cli: &Cli) -> Result<(), CliError> {
    let http = cli.http()?;
    let vaults = account::vaults(&http).await?;
    if vaults.is_empty() {
        eprintln!("this account has no vaults");
        return Ok(());
    }
    print!("{}", format_vaults(&vaults));
    Ok(())
}

/// `pull --vault <id>`: one run of the core's pull loop into this vault's
/// database.
pub async fn pull(cli: &Cli, vault: &str) -> Result<(), CliError> {
    let vault_key = derive_vault_key(cli.master_key()?)?;
    let http = cli.http()?;
    // Chapter 01 §1.4.0: the signer directory is fetched before the page, so a
    // record signed by a peer opens rather than landing unverified.
    let directory = account::device_directory(&http).await?;
    let cipher = Arc::new(AccountCipher::new(vault_key, directory));

    let db = cli.open_vault(vault)?;
    let report = PullLoop::new(http, db.clone(), Declaration::subscribed(), cipher.clone())
        .with_vault(vault)
        .run(MAX_PULL_PAGES)
        .await?;

    print!("{}", format_pull(&report));

    // The record feed carries note *metadata*; the body is a separate
    // downward feed (chapter 07). Without this the projection fills, `notes
    // list` looks complete, and `notes text` prints nothing — which is exactly
    // what G4 is meant to catch, so the pull runs both.
    //
    // Tombstoned documents are excluded per §7.15: the server still answers
    // with the surviving log, and re-applying it resurrects body state for a
    // document the record feed just said is deleted.
    let doc_ids = live_document_ids(&db)?;
    if !doc_ids.is_empty() {
        let bodies = BodyPull::new(cli.http()?, db, Declaration::subscribed(), cipher)
            .with_vault(vault)
            .pull_documents(&doc_ids)
            .await?;
        println!(
            "bodies {}\nupdates {}\nbaselines {}",
            bodies.documents, bodies.updates, bodies.baselines
        );
    }

    if report.refused {
        // §5.14: the cursor advanced and the run is still unsuccessful. Saying
        // so is the whole point of the breaker.
        return Err(CliError::Refused(
            "the pull was refused: a page produced only corrupt items".to_string(),
        ));
    }
    Ok(())
}

/// Every note and journal that still exists, for the body pass.
///
/// `deleted_at IS NULL` is §7.15's rule made a query rather than a comment.
fn live_document_ids(db: &Db) -> Result<Vec<String>, CliError> {
    let ids = db.call_blocking(|conn| {
        let query = |conn: &mut rusqlite::Connection| -> Result<Vec<String>, rusqlite::Error> {
            let mut stmt = conn.prepare(
                "SELECT item_id FROM sync_items \
                 WHERE item_type IN ('note', 'journal') AND deleted_at IS NULL \
                   AND corrupt_reason IS NULL \
                 ORDER BY item_id",
            )?;
            stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        };
        query(conn).map_err(|error| StorageError::Failed {
            what: format!("listing live documents: {error}"),
        })
    })?;
    Ok(ids)
}

/// `notes list [--vault <id>]`: the projection, newest first.
pub fn notes_list(cli: &Cli, vault: Option<&str>) -> Result<(), CliError> {
    let vault = match vault {
        Some(vault) => vault.to_string(),
        None => cli.only_vault()?,
    };
    let notes = read_notes(&cli.open_vault(&vault)?)?;
    if notes.is_empty() {
        eprintln!("no notes in {vault}");
        return Ok(());
    }
    print!("{}", format_notes(&notes));
    Ok(())
}

/// `notes text <id>`: `extract_text` over the body document (T123).
pub fn notes_text(cli: &Cli, note: &str) -> Result<(), CliError> {
    let vault = cli.only_vault()?;
    let db = cli.open_vault(&vault)?;
    let text = extract_text(&*open_body(&db, note)?)?;
    println!("{text}");
    Ok(())
}

/// `notes state-vector <id>`: the body's Y.Doc state vector, hex, for the §G4
/// comparison against desktop.
pub fn notes_state_vector(cli: &Cli, note: &str) -> Result<(), CliError> {
    let vault = cli.only_vault()?;
    let db = cli.open_vault(&vault)?;
    println!("{}", format_hex(&open_body(&db, note)?.state_vector()?));
    Ok(())
}

/// One row of the `notes` projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRow {
    pub id: String,
    pub title: String,
}

/// The document id of a note body is the note record's id (chapter 07 §7.1),
/// and the body is whatever the update log already holds: this command reads,
/// and never fetches.
fn open_body(db: &Db, note: &str) -> Result<Arc<memry_core::crdt::registry::Document>, CliError> {
    let doc_id = note.to_string();
    let plan = db.call_blocking(move |conn| {
        update_log::load_plan(conn, &doc_id).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })?;

    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(note)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}

fn read_notes(db: &Db) -> Result<Vec<NoteRow>, CliError> {
    Ok(db.call_blocking(|conn| {
        let failed = |error: rusqlite::Error| StorageError::Failed {
            what: error.to_string(),
        };
        let mut statement = conn
            .prepare(
                "SELECT id, title FROM notes \
                 WHERE deleted_at IS NULL \
                 ORDER BY COALESCE(modified_at, created_at, 0) DESC, id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map([], |row| {
                Ok(NoteRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(failed)
    })?)
}

fn prompt(question: &str) -> Result<String, CliError> {
    // The prompt goes to stderr so that a transcript's stdout stays the
    // command's output and nothing else.
    eprint!("{question}");
    std::io::stderr().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(answer.trim().to_string())
}

pub fn format_vaults(vaults: &[VaultSummary]) -> String {
    let mut out = String::new();
    for vault in vaults {
        let _ = writeln!(
            out,
            "{}\t{}",
            vault.id,
            vault.name.as_deref().unwrap_or("-")
        );
    }
    out
}

pub fn format_notes(notes: &[NoteRow]) -> String {
    let mut out = String::new();
    for note in notes {
        let _ = writeln!(out, "{}\t{}", note.id, note.title);
    }
    out
}

pub fn format_pull(report: &PullReport) -> String {
    format!(
        "pages {}\napplied {}\ndeleted {}\nskipped {}\ncorrupt {}\nexpired {}\ndropped-pages {}\ncursor {}\nhas-more {}\nrefused {}\n",
        report.pages,
        report.applied,
        report.deleted,
        report.skipped,
        report.corrupt,
        report.expired,
        report.dropped_pages,
        report.cursor.as_deref().unwrap_or("-"),
        report.has_more,
        report.refused,
    )
}

pub fn format_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use memry_core::storage::open_data;

    #[test]
    fn a_vault_without_a_name_still_prints_its_id() {
        let rendered = format_vaults(&[
            VaultSummary {
                id: "v-1".to_string(),
                name: Some("Work".to_string()),
            },
            VaultSummary {
                id: "v-2".to_string(),
                name: None,
            },
        ]);
        assert_eq!(rendered, "v-1\tWork\nv-2\t-\n");
        assert_eq!(format_vaults(&[]), "");
    }

    #[test]
    fn notes_print_one_tab_separated_row_each() {
        let rendered = format_notes(&[NoteRow {
            id: "note-1".to_string(),
            title: "A note".to_string(),
        }]);
        assert_eq!(rendered, "note-1\tA note\n");
    }

    #[test]
    fn a_pull_report_prints_every_count_the_breaker_needs() {
        let report = PullReport {
            pages: 2,
            applied: 7,
            deleted: 1,
            skipped: 2,
            corrupt: 3,
            expired: 0,
            dropped_pages: 0,
            cursor: Some("42".to_string()),
            has_more: true,
            refused: true,
        };
        let rendered = format_pull(&report);
        assert!(rendered.contains("applied 7"), "{rendered}");
        // §6.3.1's skip is its own count: a merged type whose local clock
        // dominated was neither applied nor corrupt, and a transcript that
        // folded it into either would misreport the run.
        assert!(rendered.contains("skipped 2"), "{rendered}");
        assert!(rendered.contains("corrupt 3"), "{rendered}");
        assert!(rendered.contains("cursor 42"), "{rendered}");
        assert!(rendered.contains("refused true"), "{rendered}");
        // A report with no cursor still prints the field, so a transcript's
        // shape does not change between runs.
        assert!(format_pull(&PullReport::default()).contains("cursor -"));
    }

    #[test]
    fn a_state_vector_prints_as_lowercase_hex() {
        assert_eq!(format_hex(&[0, 15, 16, 255]), "000f10ff");
        assert_eq!(format_hex(&[]), "");
    }

    #[test]
    fn the_notes_read_is_newest_first_and_skips_tombstoned_rows() {
        let dir = std::env::temp_dir().join(format!("memry-cli-notes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let db = open_data(&dir.join("data.db")).expect("open data.db");

        db.call_blocking(|conn| {
            conn.execute_batch(
                "INSERT INTO notes (id, title, modified_at) VALUES ('note-old', 'Older', 10);
                 INSERT INTO notes (id, title, modified_at) VALUES ('note-new', 'Newer', 20);
                 INSERT INTO notes (id, title, modified_at, deleted_at)
                   VALUES ('note-gone', 'Deleted', 30, 31);",
            )
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("seed the projection");

        let notes = read_notes(&db).expect("read the projection");
        assert_eq!(
            notes,
            vec![
                NoteRow {
                    id: "note-new".to_string(),
                    title: "Newer".to_string()
                },
                NoteRow {
                    id: "note-old".to_string(),
                    title: "Older".to_string()
                },
            ]
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_body_with_no_updates_extracts_to_nothing() {
        let dir = std::env::temp_dir().join(format!("memry-cli-body-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let db = open_data(&dir.join("data.db")).expect("open data.db");

        let document = open_body(&db, "note-1").expect("an empty document opens");
        assert_eq!(extract_text(&document).expect("extract"), "");
        // An empty document still has a state vector, and it is still hex.
        let vector = format_hex(&document.state_vector().expect("a state vector"));
        assert!(vector.chars().all(|c| c.is_ascii_hexdigit()), "{vector}");

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
