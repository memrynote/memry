//! Commands over the open vault's files (`vault:resolve-embeds` of `ipc/vault-handlers.ts`). The
//! decisions live in `memry_desktop::vault`.

use std::collections::BTreeMap;

use memry_desktop::session::Session;
use memry_desktop::vault::embeds::resolve_embeds;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};

/// Embed targets one call resolves (`refs` of the handler's schema, `.max(500)`).
const MAX_EMBED_REFS: usize = 500;

/// What each `![[target]]` image embed of `refs` resolves to in the open vault: relative to the
/// note at `note_path` when given, a `memry-file://` URL otherwise. An embed that names no file
/// is left out, and so is every embed while no vault is open.
#[tauri::command]
#[specta::specta]
pub async fn vault_resolve_embeds(
    app: AppHandle<Wry>,
    refs: Vec<String>,
    note_path: Option<String>,
) -> Result<BTreeMap<String, String>, CommandError> {
    if refs.len() > MAX_EMBED_REFS {
        let error = CommandError::new(
            ErrorKind::Invalid,
            "invalid_refs",
            format!("at most {MAX_EMBED_REFS} embeds resolve at once"),
        );
        log_failure("vault_resolve_embeds", &error);
        return Err(error);
    }
    let Some(open) = app.state::<Session>().current() else {
        return Ok(BTreeMap::new());
    };
    blocking("vault_resolve_embeds", move || {
        let files = open.vault.note_files();
        Ok(resolve_embeds(
            &open.path,
            &files,
            &refs,
            note_path.as_deref(),
        ))
    })
    .await
}
