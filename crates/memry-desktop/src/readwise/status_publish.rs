//! The run status other devices read (`status-publish.ts`, #1408 D18): `status.lastChangeAt`
//! (ISO) and `status.error` (an error code, or `null`) in the synced `readwise` group, one field
//! clock per leaf. The pulling device writes a leaf only when a run changed something or the
//! error state changed, so an unchanged hourly run sends nothing. A cleared error is an explicit
//! `null`, never a removed key (§13.4).

use serde_json::Value;

use super::cursor::iso;
use super::library::Library;
use super::run_state::{Attention, RunState};

const LAST_CHANGE_AT: &str = "readwise.status.lastChangeAt";
const ERROR: &str = "readwise.status.error";

fn attention_code(attention: Option<Attention>) -> &'static str {
    match attention {
        Some(Attention::SubscriptionExpired) => "subscription-expired",
        Some(Attention::InvalidToken) | None => "invalid-token",
    }
}

/// `publishRunStatus`: `changed` when the run wrote a note; `now` epoch milliseconds.
pub fn publish_run_status(
    library: &Library,
    state: &RunState,
    changed: bool,
    now: i64,
) -> Result<(), String> {
    let group = state.store().settings_group().map_err(|e| e.to_string())?;
    let stored = group.get("status").and_then(Value::as_object);
    let stored_error = stored
        .and_then(|status| status.get("error"))
        .and_then(Value::as_str);
    let last_run = state.last_run().map_err(|e| e.to_string())?;
    let error = last_run
        .filter(|run| run.needs_attention)
        .map(|run| attention_code(run.attention));
    let error_changed = stored_error != error;
    if !changed && !error_changed {
        return Ok(());
    }
    let settings = (library.open.vault)
        .settings(library.notes.store.clone())
        .map_err(|e| e.to_string())?;
    if changed {
        let at = Value::String(iso(now).map_err(|e| e.to_string())?);
        (settings.set(LAST_CHANGE_AT.to_owned(), at.to_string())).map_err(|e| e.to_string())?;
    }
    if error_changed {
        let error = error.map_or(Value::Null, |code| Value::String(code.to_owned()));
        (settings.set(ERROR.to_owned(), error.to_string())).map_err(|e| e.to_string())?;
    }
    Ok(())
}
