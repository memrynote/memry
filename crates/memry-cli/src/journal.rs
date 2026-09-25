//! `journal append|tags|property`: dev-only journal writes (spec 005-journal
//! JP029, gate G0).
//!
//! They call the same core functions the phone's `Journal` surface does
//! (`domain::journal_ops`), so a desktop peer can be checked against exactly
//! what the phone would push: a day created by its first write (D2), and
//! record updates carrying `content: null` (D5). Follow each with `memry push`.

use memry_core::api::errors::StorageError;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::update_log;
use memry_core::domain::journal;
use memry_core::domain::journal_ops::{body, metadata};

use crate::session::{Cli, CliError};

/// `journal append <date> <text>`: one paragraph at the end of the day.
///
/// Refuses a live day whose body is not in this vault's update log: appending
/// to an unloaded document would push one paragraph over a body this client
/// never held, which is what `notes edit` refuses for the same reason.
pub fn append(cli: &Cli, date: &str, text: &str, vault: Option<&str>) -> Result<(), CliError> {
    if text.is_empty() {
        return Err(CliError::Refused("journal append needs text".to_string()));
    }
    let vault = crate::commands::resolve_vault(cli, vault)?;
    let db = cli.open_vault(&vault)?;
    let device_id = cli.device_id()?;
    let wanted = date.to_string();
    let unloaded = db.call_blocking(move |conn| {
        let Some(id) = journal::live_entry(conn, &wanted)? else {
            return Ok(None);
        };
        let empty = update_log::load_plan(conn, &id)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?
            .is_empty();
        Ok(empty.then_some(id))
    })?;
    if let Some(id) = unloaded {
        return Err(CliError::Refused(format!(
            "the body of `{id}` ({date}) is not in this vault's update log: run `memry pull` first"
        )));
    }

    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_string(),
        new_block_id: crate::edit::new_block_id(),
    };
    let day = date.to_string();
    let outcome = db
        .call_blocking(move |conn| Ok(body::edit_day(conn, &day, &edit, &device_id, now_ms())))?
        .map_err(CliError::from)?;
    println!(
        "{date}: {} (created {}, revived {}, changed {})",
        outcome.id, outcome.created, outcome.revived, outcome.changed
    );
    Ok(())
}

/// `journal tags <date> <a,b>`: replaces the day's tags (a record-only write).
pub fn tags(cli: &Cli, date: &str, tags: &[String], vault: Option<&str>) -> Result<(), CliError> {
    let vault = crate::commands::resolve_vault(cli, vault)?;
    let db = cli.open_vault(&vault)?;
    let device_id = cli.device_id()?;
    let (day, list) = (date.to_string(), tags.to_vec());
    let written =
        db.call_blocking(move |conn| metadata::set_tags(conn, &day, &list, &device_id, now_ms()))?;
    println!("{date}: tags {written:?}");
    Ok(())
}

/// `journal property <date> <name> <json>`: sets one property (record-only).
pub fn property(
    cli: &Cli,
    date: &str,
    name: &str,
    value_json: &str,
    vault: Option<&str>,
) -> Result<(), CliError> {
    let value: serde_json::Value = serde_json::from_str(value_json)
        .map_err(|error| CliError::Refused(format!("`{value_json}` is not JSON: {error}")))?;
    let vault = crate::commands::resolve_vault(cli, vault)?;
    let db = cli.open_vault(&vault)?;
    let device_id = cli.device_id()?;
    let (day, key) = (date.to_string(), name.to_string());
    let written = db
        .call_blocking(move |conn| {
            Ok(metadata::set_property(
                conn,
                &day,
                &key,
                value,
                &device_id,
                now_ms(),
            ))
        })?
        .map_err(|error| CliError::Refused(error.to_string()))?;
    println!("{date}: properties {written:?}");
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
