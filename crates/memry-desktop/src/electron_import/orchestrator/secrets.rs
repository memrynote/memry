//! The secrets phase: Step 37c's [`import_secrets`] with this run's inputs.

use std::path::Path;

use serde_json::{Value, json};

use super::{FirstLaunchInput, RunError};
use crate::electron_import::secrets::read_all_secrets;
use crate::electron_import::secrets_import::{SecretsEvidence, SecretsMode, SecretsPhase};
use crate::electron_import::{
    ElectronConfig, ElectronProfile, ImportError, Scratch, import_secrets, read_vault_evidence,
};

/// Runs the phase and returns the report's `secrets` section.
pub(super) fn run(
    input: &FirstLaunchInput<'_>,
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
    data_dir: &Path,
) -> Result<Value, RunError> {
    let mut inline_ai_reenter = Vec::new();
    let inputs = || -> Result<_, ImportError> {
        let report = read_all_secrets(profile, input.key_source, input.keytar)?;
        let evidence = match input.secrets_mode {
            // Sign in again skips every check the evidence feeds.
            SecretsMode::SignInAgain => SecretsEvidence::default(),
            SecretsMode::Full => evidence(config, scratch, &mut inline_ai_reenter)?,
        };
        Ok((report, evidence))
    };
    let phase = import_secrets(
        inputs,
        input.secrets_mode,
        input.keyring,
        input.identity,
        data_dir,
    )
    .map_err(RunError::Secrets)?;
    Ok(match phase {
        SecretsPhase::Done => json!({ "done": true }),
        SecretsPhase::Ran(outcome) => json!({
            "mode": format!("{:?}", input.secrets_mode),
            "written": outcome.written,
            "present": outcome.present,
            "verified": format!("{:?}", outcome.verified),
            "deviceKey": format!("{:?}", outcome.device_key),
            "deviceChecked": outcome.device_checked,
            "signInRequired": outcome.sign_in_required,
            "keytarUnlisted": outcome.keytar_unlisted,
            "skipped": outcome.skipped.iter().map(|s| json!({
                "service": s.service,
                "account": s.account,
                "reason": format!("{:?}", s.reason),
            })).collect::<Vec<_>>(),
            "inlineAiReenter": inline_ai_reenter,
        }),
    })
}

/// One evidence slot per config entry, in config order, so `current_vault` indexes its own
/// vault. A vault without a folder or a `data.db` fills its slot empty, which every check
/// skips. A `data.db` SQLite refuses does too when the config holds the account verifier; with
/// none, its verifier may be the only one, and the phase stops (Retry).
fn evidence(
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
    inline_ai_reenter: &mut Vec<String>,
) -> Result<SecretsEvidence, ImportError> {
    let Some(config) = config else {
        return Ok(SecretsEvidence::default());
    };
    let account_key_verifier = config.account_key_verifier().map(str::to_owned);
    let (stored, _) = config.vaults();
    let mut vaults = Vec::with_capacity(stored.len());
    for vault in &stored {
        let dir = Path::new(&vault.path);
        let read = if dir.is_dir() {
            read_vault_evidence(dir, scratch.root())
        } else {
            Ok(None)
        };
        let evidence = match read {
            Ok(evidence) => evidence.unwrap_or_default(),
            Err(ImportError::Sqlite(_)) if account_key_verifier.is_some() => Default::default(),
            Err(error) => return Err(error),
        };
        if evidence.inline_ai_reenter && !inline_ai_reenter.contains(&vault.path) {
            inline_ai_reenter.push(vault.path.clone());
        }
        vaults.push(evidence);
    }
    let current_vault = config
        .current_vault()
        .and_then(|current| stored.iter().position(|v| v.path == current));
    Ok(SecretsEvidence {
        account_key_verifier,
        device_id: config.device_id().map(str::to_owned),
        current_vault,
        vaults,
    })
}
