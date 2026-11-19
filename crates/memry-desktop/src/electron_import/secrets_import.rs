//! Phase `secrets` of the first-launch migration (Step 37, #3554): Electron's decrypted secrets
//! ([`super::secrets::read_all_secrets`]) into this app's keychain namespace.
//!
//! **Electron's store is never written.** Every write goes to this app's own services: the four
//! sync secrets through [`KeyringStore`] (service `com.memrynote.memry`), the device key through
//! [`DeviceIdentityStore::adopt_electron`], and every other Electron service `com.memry.<x>` or
//! `memry.<x>` through [`GenericSecrets`] under `com.memrynote.memry.<x>`, which refuses every
//! Electron service. Electron moves its keychain items into its own file and deletes the keychain
//! copy, so a shared item could vanish under this app (`secret-storage.ts` `setSecret`).
//!
//! **Order.** Everything that can refuse runs before the first write: unreadable entries, values
//! not in Electron's format, the device key against the current-device rows of Electron's device
//! id (`device_key_mismatch`, [`checks::check_device`]), the master key against the verifier
//! (`KeyVerifierMismatch`), whether this profile may take the device key
//! ([`DeviceIdentityStore::adoptable`]), and a read of every target slot (a locked keychain fails
//! here, and a slot holding another value is never overwritten). Then the writes: sync secrets,
//! the verifier again on the master key read back from the keychain, generic secrets, and the
//! device key last. A failure after the first write deletes exactly the entries this run wrote
//! (the ledger) and nothing it found in place. A generic secret the keychain refuses as `Failed`
//! (Windows Credential Manager refuses a blob over 2560 bytes) is skipped and listed
//! (`WriteRefused`); `Locked` stops the phase.
//!
//! **Reruns.** The phase owns the marker `secrets-import.done` in this app's data dir, written
//! after a run that ended `Ok`. A run that finds it answers [`SecretsPhase::Done`] without reading
//! Electron's data: once this app refreshed a token or signed out, Electron's secrets are stale,
//! and copying them again would fail on the rotated token or sign the user back in. Before the
//! marker (a crash mid-run, or a marker write that failed), a slot that already holds Electron's
//! value is left alone and counted as present, so the rerun converges and writes nothing twice.
//!
//! **Shared refresh token.** The copied refresh token is the one Electron holds, so both apps
//! share one device's token chain. Reusing a rotated token outside the server's grace window
//! revokes the device: going back to Electron after this app refreshed (or the reverse) signs both
//! apps out. Local data is safe; the user signs in again.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

use super::ImportError;
use super::secrets::{SecretsReport, UnreadableReason, UnreadableSecret};
use super::vault_evidence::VaultEvidence;
use crate::seams::secure_store::{
    AdoptError, Adoption, DeviceIdentityStore, GenericSecrets, KEYS, KeyringStore, SERVICE,
    account, device_account,
};
use checks::{check_device, check_master};
pub use done::forget_secrets_import;
use done::{DONE_FILE, mark_done};

mod checks;
mod done;

/// Electron's service of the five sync secrets (`KEYCHAIN_ENTRIES`).
const ELECTRON_SYNC: &str = "com.memry.sync";
/// Electron's other services: `com.memry.<x>` and `memry.<x>`.
const ELECTRON_PREFIXES: [&str; 2] = ["com.memry.", "memry."];
const DEVICE_KEY_LEN: usize = 64;
/// Electron's local provider key: `api-key`, `api-key:<MEMRY_DEVICE>` in a dev run
/// (`local-provider-keychain.ts:6-9`). Every other Electron service names its accounts as this
/// app does.
const LOCAL_PROVIDER: &str = "memry.agent.local-provider";
const LOCAL_PROVIDER_ACCOUNT: &str = "api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretsMode {
    Full,
    /// The user chose "Sign in again" after an unreadable entry: the sync secrets (master key,
    /// device key, tokens, setup token) and every unreadable entry are skipped, and the other
    /// secrets that decrypted are copied.
    SignInAgain,
}

/// What the phase checks the secrets against, read from the untouched Electron data.
#[derive(Debug, Clone, Default)]
pub struct SecretsEvidence {
    /// Config `sync.accountKeyVerifier`.
    pub account_key_verifier: Option<String>,
    /// Config `sync.deviceId` (`store.ts:466`), this install's server device id.
    pub device_id: Option<String>,
    /// The index in `vaults` of config `currentVault`, the vault Electron last had open.
    pub current_vault: Option<usize>,
    /// Every vault of the config, in its order. A vault whose evidence cannot be read fails the
    /// inputs of [`import_secrets`]: a vault left out is a check skipped.
    pub vaults: Vec<VaultEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    SignInAgain,
    Unreadable(UnreadableReason),
    /// An account of another `MEMRY_DEVICE` than this app's.
    OtherDevice,
    /// Neither `com.memry.<x>` nor `memry.<x>`.
    UnknownService,
    /// The target slot already holds another value, which is kept.
    KeptExisting,
    /// Another Electron entry maps to the same target with another value; the first one is kept.
    Collision,
    /// The keychain refused the write (`Failed`), as Windows does a blob over 2560 bytes.
    WriteRefused,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSecret {
    pub service: String,
    pub account: String,
    pub reason: SkipReason,
}

/// How the master key was checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verified {
    AccountKeyVerifier,
    VaultKeyVerifier,
    /// Electron holds a master key and neither verifier exists to check it against.
    NoVerifier,
    NoMasterKey,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKey {
    Adopted,
    AlreadyHeld,
    NotInElectron,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretsOutcome {
    pub written: usize,
    /// Slots that already held Electron's value (an earlier run).
    pub present: usize,
    pub verified: Verified,
    pub device_key: DeviceKey,
    /// The device key matched at least one registered public key. False when no vault holds a
    /// row of Electron's device with one: the key was taken unchecked.
    pub device_checked: bool,
    pub skipped: Vec<SkippedSecret>,
    /// Sign-in is needed before sync: the sync secrets were skipped.
    pub sign_in_required: bool,
    /// The legacy keytar items could not be listed (Sign in again only).
    pub keytar_unlisted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretsPhase {
    /// An earlier run finished; nothing was read or written.
    Done,
    Ran(SecretsOutcome),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretsError {
    /// Electron's secrets or a vault's evidence could not be read. Offers Retry.
    #[error("Electron's data could not be read: {0}")]
    Read(String),
    #[error("the secrets import marker: {0}")]
    DoneMarker(String),
    /// Offers Retry and Sign in again.
    #[error("{} Electron secrets could not be read", .0.len())]
    Unreadable(Vec<UnreadableSecret>),
    /// Offers Retry and Sign in again.
    #[error("the legacy keychain items could not be listed: {0}")]
    KeytarUnlisted(String),
    #[error("Electron's {kind} is not in the format Electron writes")]
    Malformed { kind: &'static str },
    #[error("device_key_mismatch: Electron's device key is not the key this device registered")]
    DeviceKeyMismatch,
    #[error("KeyVerifierMismatch: Electron's master key does not match the account's verifier")]
    KeyVerifierMismatch,
    #[error("this app already holds a different {kind}; it is kept")]
    TargetOccupied { kind: &'static str },
    #[error("the keychain: {0}")]
    Keychain(SecureStoreError),
    /// The rollback after `cause` could not delete `left` entries this run wrote; each holds
    /// Electron's value, so a rerun finds them in place.
    #[error("{cause} (and {left} entries this run wrote could not be removed)")]
    RollbackIncomplete {
        cause: Box<SecretsError>,
        left: usize,
    },
}

impl From<SecureStoreError> for SecretsError {
    fn from(error: SecureStoreError) -> Self {
        Self::Keychain(error)
    }
}

type Secret = Zeroizing<Vec<u8>>;

struct Generic {
    service: String,
    account: String,
    value: Secret,
}

#[derive(Default)]
struct Plan {
    sync: Vec<(SecureStoreKey, Secret)>,
    device: Option<Secret>,
    generic: Vec<Generic>,
    skipped: Vec<SkippedSecret>,
}

impl Plan {
    fn master_key(&self) -> Option<&Secret> {
        self.sync
            .iter()
            .find(|(key, _)| *key == SecureStoreKey::MasterKey)
            .map(|(_, value)| value)
    }

    fn skip(&mut self, service: &str, account: &str, reason: SkipReason) {
        self.skipped.push(SkippedSecret {
            service: service.to_owned(),
            account: account.to_owned(),
            reason,
        });
    }
}

pub(super) fn kind(key: SecureStoreKey) -> &'static str {
    match key {
        SecureStoreKey::MasterKey => "master key",
        SecureStoreKey::DeviceSigningKey => "device signing key",
        SecureStoreKey::AccessToken => "access token",
        SecureStoreKey::RefreshToken => "refresh token",
        SecureStoreKey::SetupToken => "setup token",
    }
}

/// `com.memry.<x>` / `memry.<x>` to `com.memrynote.memry.<x>`.
fn generic_target(service: &str) -> Option<String> {
    let rest = ELECTRON_PREFIXES
        .iter()
        .find_map(|prefix| service.strip_prefix(prefix))?;
    (!rest.is_empty()).then(|| format!("{SERVICE}.{rest}"))
}

/// This app's account of Electron's generic `account`, `None` for another device's.
fn generic_account(service: &str, account: &str, suffix: Option<&str>) -> Option<String> {
    if service != LOCAL_PROVIDER {
        return Some(account.to_owned());
    }
    let electron = match suffix.map(str::trim).filter(|device| !device.is_empty()) {
        Some(device) => format!("{LOCAL_PROVIDER_ACCOUNT}:{device}"),
        None => LOCAL_PROVIDER_ACCOUNT.to_owned(),
    };
    // `ai/local_provider` names its account `device_account("api-key", MEMRY_DEVICE)`.
    (account == electron).then(|| device_account(LOCAL_PROVIDER_ACCOUNT, suffix))
}

fn plan(
    report: &SecretsReport,
    mode: SecretsMode,
    suffix: Option<&str>,
) -> Result<Plan, SecretsError> {
    if mode == SecretsMode::Full {
        if !report.unreadable.is_empty() {
            return Err(SecretsError::Unreadable(report.unreadable.clone()));
        }
        if let Some(error) = &report.keytar_error {
            return Err(SecretsError::KeytarUnlisted(error.clone()));
        }
    }
    let mut plan = Plan::default();
    for u in &report.unreadable {
        plan.skip(&u.service, &u.account, SkipReason::Unreadable(u.reason));
    }
    let mut targets: BTreeMap<(String, String), usize> = BTreeMap::new();
    for entry in &report.entries {
        let (service, account_name) = (entry.service.as_str(), entry.account.as_str());
        if service == ELECTRON_SYNC {
            if mode == SecretsMode::SignInAgain {
                plan.skip(service, account_name, SkipReason::SignInAgain);
                continue;
            }
            let Some(key) = KEYS
                .into_iter()
                .find(|key| account(*key, suffix) == account_name)
            else {
                plan.skip(service, account_name, SkipReason::OtherDevice);
                continue;
            };
            // Electron stores each of the five as base64 of the bytes (`keychain.ts` `storeKey`).
            let bytes = Zeroizing::new(
                STANDARD
                    .decode(entry.value.as_bytes())
                    .map_err(|_| SecretsError::Malformed { kind: kind(key) })?,
            );
            if key == SecureStoreKey::DeviceSigningKey {
                if bytes.len() != DEVICE_KEY_LEN {
                    return Err(SecretsError::Malformed { kind: kind(key) });
                }
                plan.device = Some(bytes);
            } else {
                plan.sync.push((key, bytes));
            }
            continue;
        }
        let Some(target) = generic_target(service) else {
            plan.skip(service, account_name, SkipReason::UnknownService);
            continue;
        };
        let Some(target_account) = generic_account(service, account_name, suffix) else {
            plan.skip(service, account_name, SkipReason::OtherDevice);
            continue;
        };
        let value = Zeroizing::new(entry.value.as_bytes().to_vec());
        match targets.get(&(target.clone(), target_account.clone())) {
            Some(&index) if plan.generic[index].value == value => {}
            Some(_) => plan.skip(service, account_name, SkipReason::Collision),
            None => {
                targets.insert((target.clone(), target_account.clone()), plan.generic.len());
                plan.generic.push(Generic {
                    service: target,
                    account: target_account,
                    value,
                });
            }
        }
    }
    Ok(plan)
}

enum Written {
    Sync(SecureStoreKey),
    Generic { service: String, account: String },
}

/// What this run wrote, deleted again in reverse on a failure.
#[derive(Default)]
struct Ledger(Vec<Written>);

impl Ledger {
    fn roll_back(self, keyring: &KeyringStore, cause: SecretsError) -> SecretsError {
        let mut left = 0;
        for written in self.0.into_iter().rev() {
            let result = match &written {
                Written::Sync(key) => keyring.delete(*key),
                Written::Generic { service, account } => keyring.delete_secret(service, account),
            };
            if let Err(error) = result {
                left += 1;
                let what = match &written {
                    Written::Sync(key) => kind(*key).to_owned(),
                    Written::Generic { service, .. } => service.clone(),
                };
                tracing::warn!(
                    scope = "ElectronImport",
                    "the rollback could not remove the {what} this run wrote: {error}"
                );
            }
        }
        if left == 0 {
            cause
        } else {
            SecretsError::RollbackIncomplete {
                cause: Box::new(cause),
                left,
            }
        }
    }
}

/// Slots that need a write, after reading every target once. Nothing is written yet.
struct Pending<'a> {
    sync: Vec<&'a (SecureStoreKey, Secret)>,
    generic: Vec<&'a Generic>,
    present: usize,
}

fn read_targets<'a>(
    plan: &'a Plan,
    keyring: &KeyringStore,
    skipped: &mut Vec<SkippedSecret>,
) -> Result<Pending<'a>, SecretsError> {
    let mut pending = Pending {
        sync: Vec::new(),
        generic: Vec::new(),
        present: 0,
    };
    for slot in &plan.sync {
        match keyring.get(slot.0)? {
            None => pending.sync.push(slot),
            Some(held) if held == *slot.1 => pending.present += 1,
            Some(_) => return Err(SecretsError::TargetOccupied { kind: kind(slot.0) }),
        }
    }
    for slot in &plan.generic {
        match keyring.get_secret(&slot.service, &slot.account)? {
            None => pending.generic.push(slot),
            Some(held) if held == *slot.value => pending.present += 1,
            Some(_) => skipped.push(SkippedSecret {
                service: slot.service.clone(),
                account: slot.account.clone(),
                reason: SkipReason::KeptExisting,
            }),
        }
    }
    Ok(pending)
}

/// Runs the phase, or answers [`SecretsPhase::Done`] when an earlier run finished (module doc,
/// **Reruns**). `inputs` reads Electron's secrets ([`super::secrets::read_all_secrets`]) and the
/// evidence; it runs only when the phase is not done, and any error it returns stops the phase.
/// `keyring` and `identity` are this app's stores (the same keychain) and `app_dir` its data dir.
/// No vault may be open: the core mints a device key when it reads none, and the adoption must
/// come first.
pub fn import_secrets(
    inputs: impl FnOnce() -> Result<(SecretsReport, SecretsEvidence), ImportError>,
    mode: SecretsMode,
    keyring: &KeyringStore,
    identity: &DeviceIdentityStore,
    app_dir: &Path,
) -> Result<SecretsPhase, SecretsError> {
    let done = app_dir.join(DONE_FILE);
    match fs::metadata(&done) {
        Ok(_) => return Ok(SecretsPhase::Done),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(SecretsError::DoneMarker(error.to_string())),
    }
    let (report, evidence) = inputs().map_err(|error| SecretsError::Read(error.to_string()))?;
    let (outcome, synced) = run(&report, &evidence, mode, keyring, identity)?;
    // A failed marker write leaves a finished import: the rerun finds every slot present.
    mark_done(app_dir, &synced)?;
    Ok(SecretsPhase::Ran(outcome))
}

fn adopt_error(error: AdoptError) -> SecretsError {
    match error {
        AdoptError::Taken => SecretsError::TargetOccupied {
            kind: kind(SecureStoreKey::DeviceSigningKey),
        },
        AdoptError::Store(error) => SecretsError::Keychain(error),
    }
}

fn run(
    report: &SecretsReport,
    evidence: &SecretsEvidence,
    mode: SecretsMode,
    keyring: &KeyringStore,
    identity: &DeviceIdentityStore,
) -> Result<(SecretsOutcome, Vec<(SecureStoreKey, Secret)>), SecretsError> {
    let mut plan = plan(report, mode, keyring.device_suffix())?;
    let device_checked = match &plan.device {
        Some(device) => check_device(device, evidence)?,
        None => false,
    };
    let verified = match (mode, plan.master_key()) {
        (SecretsMode::SignInAgain, _) => Verified::Skipped,
        (SecretsMode::Full, None) => Verified::NoMasterKey,
        (SecretsMode::Full, Some(master)) => check_master(master, evidence)?,
    };
    if let Some(device) = &plan.device {
        identity.adoptable(device).map_err(adopt_error)?;
    }
    let mut skipped = std::mem::take(&mut plan.skipped);
    let pending = read_targets(&plan, keyring, &mut skipped)?;
    let mut outcome = SecretsOutcome {
        written: 0,
        present: pending.present,
        verified,
        device_key: match (mode, &plan.device) {
            (SecretsMode::SignInAgain, _) => DeviceKey::Skipped,
            (SecretsMode::Full, None) => DeviceKey::NotInElectron,
            (SecretsMode::Full, Some(_)) => DeviceKey::AlreadyHeld,
        },
        device_checked,
        skipped,
        sign_in_required: mode == SecretsMode::SignInAgain,
        keytar_unlisted: report.keytar_error.is_some(),
    };
    let mut ledger = Ledger::default();
    let written = write(
        &plan,
        pending,
        (keyring, identity),
        evidence,
        &mut ledger,
        &mut outcome.skipped,
    );
    match written {
        Ok((written, device_key)) => {
            outcome.written = written;
            if let Some(device_key) = device_key {
                outcome.present += usize::from(device_key == DeviceKey::AlreadyHeld);
                outcome.device_key = device_key;
            }
            // Every sync slot of the plan now holds Electron's value: written or found present.
            Ok((outcome, plan.sync))
        }
        Err(error) => Err(ledger.roll_back(keyring, error)),
    }
}

fn write(
    plan: &Plan,
    pending: Pending<'_>,
    (keyring, identity): (&KeyringStore, &DeviceIdentityStore),
    evidence: &SecretsEvidence,
    ledger: &mut Ledger,
    skipped: &mut Vec<SkippedSecret>,
) -> Result<(usize, Option<DeviceKey>), SecretsError> {
    for (key, value) in pending.sync {
        keyring.set(*key, value.to_vec())?;
        ledger.0.push(Written::Sync(*key));
    }
    if plan.master_key().is_some() {
        let back = Zeroizing::new(keyring.get(SecureStoreKey::MasterKey)?.unwrap_or_default());
        if Some(&back) != plan.master_key() {
            return Err(SecretsError::Keychain(SecureStoreError::Failed {
                what: "the master key did not read back from the keychain".to_owned(),
            }));
        }
        check_master(&back, evidence)?;
    }
    for slot in pending.generic {
        match keyring.set_secret(&slot.service, &slot.account, &slot.value) {
            Ok(()) => ledger.0.push(Written::Generic {
                service: slot.service.clone(),
                account: slot.account.clone(),
            }),
            Err(SecureStoreError::Failed { what }) => {
                tracing::warn!(
                    scope = "ElectronImport",
                    "the keychain refused the {} secret; it is skipped: {what}",
                    slot.service
                );
                skipped.push(SkippedSecret {
                    service: slot.service.clone(),
                    account: slot.account.clone(),
                    reason: SkipReason::WriteRefused,
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
    let written = ledger.0.len();
    let Some(device) = &plan.device else {
        return Ok((written, None));
    };
    match identity.adopt_electron(device).map_err(adopt_error)? {
        Adoption::Adopted => Ok((written + 1, Some(DeviceKey::Adopted))),
        Adoption::AlreadyHeld => Ok((written, Some(DeviceKey::AlreadyHeld))),
    }
}

#[cfg(test)]
mod tests;
