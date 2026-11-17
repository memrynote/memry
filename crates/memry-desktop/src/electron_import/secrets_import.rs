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
//! not in Electron's format, the device key against the vault's current-device row
//! (`device_key_mismatch`), the master key against the verifier (`KeyVerifierMismatch`), and a
//! read of every target slot (a locked keychain fails here, and a slot holding another value is
//! never overwritten). Then the writes: sync secrets, the verifier again on the master key read
//! back from the keychain, generic secrets, and the device key last. A failure after the first
//! write deletes exactly the entries this run wrote (the ledger) and nothing it found in place.
//!
//! **Reruns.** A slot that already holds Electron's value is left alone and counted as present,
//! so a run after a crash converges on the same state and writes nothing twice.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::{keys, sodium};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

use super::secrets::{SecretsReport, UnreadableReason, UnreadableSecret};
use super::vault_evidence::VaultEvidence;
use crate::seams::secure_store::{
    AdoptError, Adoption, DeviceIdentityStore, GenericSecrets, KEYS, KeyringStore, SERVICE, account,
};

/// Electron's service of the five sync secrets (`KEYCHAIN_ENTRIES`).
const ELECTRON_SYNC: &str = "com.memry.sync";
/// Electron's other services: `com.memry.<x>` and `memry.<x>`.
const ELECTRON_PREFIXES: [&str; 2] = ["com.memry.", "memry."];
const DEVICE_KEY_LEN: usize = 64;

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
    /// Every vault of the config, in its order.
    pub vaults: Vec<VaultEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    SignInAgain,
    Unreadable(UnreadableReason),
    /// A sync account of another `MEMRY_DEVICE` than this app's.
    OtherDevice,
    /// Neither `com.memry.<x>` nor `memry.<x>`.
    UnknownService,
    /// The target slot already holds another value, which is kept.
    KeptExisting,
    /// Another Electron entry maps to the same target with another value; the first one is kept.
    Collision,
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
    pub skipped: Vec<SkippedSecret>,
    /// Sign-in is needed before sync: the sync secrets were skipped.
    pub sign_in_required: bool,
    /// The legacy keytar items could not be listed (Sign in again only).
    pub keytar_unlisted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretsError {
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

fn kind(key: SecureStoreKey) -> &'static str {
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
        let value = Zeroizing::new(entry.value.as_bytes().to_vec());
        match targets.get(&(target.clone(), entry.account.clone())) {
            Some(&index) if plan.generic[index].value == value => {}
            Some(_) => plan.skip(service, account_name, SkipReason::Collision),
            None => {
                targets.insert((target.clone(), entry.account.clone()), plan.generic.len());
                plan.generic.push(Generic {
                    service: target,
                    account: entry.account.clone(),
                    value,
                });
            }
        }
    }
    Ok(plan)
}

/// The device key against every vault's current-device row that holds a public key, compared as
/// base64 text (`sync-core-handlers.ts` integrity check). Also proves the 64 bytes are one
/// Ed25519 secret key: seed then public half.
fn check_device(device: &Secret, evidence: &SecretsEvidence) -> Result<(), SecretsError> {
    let malformed = SecretsError::Malformed {
        kind: kind(SecureStoreKey::DeviceSigningKey),
    };
    let (public, secret) =
        sodium::sign_seed_keypair(&device[..32]).map_err(|_| malformed.clone())?;
    if secret.as_slice() != device.as_slice() {
        return Err(malformed);
    }
    let public = STANDARD.encode(public);
    let registered = evidence
        .vaults
        .iter()
        .filter_map(|v| v.device_public_key.as_deref());
    for row in registered {
        if row != public {
            return Err(SecretsError::DeviceKeyMismatch);
        }
    }
    Ok(())
}

/// The master key against config `sync.accountKeyVerifier`, else against the
/// `vault.crypto.verifier.v1` row of the first vault that holds one (chapter 01 §1.4).
fn check_master(master: &[u8], evidence: &SecretsEvidence) -> Result<Verified, SecretsError> {
    let crypto = |_| SecretsError::KeyVerifierMismatch;
    if let Some(expected) = &evidence.account_key_verifier {
        let local = keys::account_key_verifier(master).map_err(crypto)?;
        return if keys::account_key_verifier_matches(&local, expected) {
            Ok(Verified::AccountKeyVerifier)
        } else {
            Err(SecretsError::KeyVerifierMismatch)
        };
    }
    let row = evidence
        .vaults
        .iter()
        .find_map(|v| Some((v.vault_id.as_deref()?, v.key_verifier.as_deref()?)));
    let Some((vault_id, expected)) = row else {
        return Ok(Verified::NoVerifier);
    };
    let vault_key = keys::derive_vault_key(master).map_err(crypto)?;
    let local = keys::local_vault_key_verifier(&vault_key, vault_id).map_err(crypto)?;
    if sodium::memcmp(local.as_bytes(), expected.as_bytes()) {
        Ok(Verified::VaultKeyVerifier)
    } else {
        Err(SecretsError::KeyVerifierMismatch)
    }
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

/// Runs the phase. `report` comes from [`super::secrets::read_all_secrets`]; `keyring` and
/// `identity` are this app's stores (the same keychain). No vault may be open: the core mints a
/// device key when it reads none, and the adoption must come first.
pub fn import_secrets(
    report: &SecretsReport,
    evidence: &SecretsEvidence,
    mode: SecretsMode,
    keyring: &KeyringStore,
    identity: &DeviceIdentityStore,
) -> Result<SecretsOutcome, SecretsError> {
    let mut plan = plan(report, mode, keyring.device_suffix())?;
    if let Some(device) = &plan.device {
        check_device(device, evidence)?;
    }
    let verified = match (mode, plan.master_key()) {
        (SecretsMode::SignInAgain, _) => Verified::Skipped,
        (SecretsMode::Full, None) => Verified::NoMasterKey,
        (SecretsMode::Full, Some(master)) => check_master(master, evidence)?,
    };
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
        skipped,
        sign_in_required: mode == SecretsMode::SignInAgain,
        keytar_unlisted: report.keytar_error.is_some(),
    };
    let mut ledger = Ledger::default();
    match write(&plan, pending, keyring, identity, evidence, &mut ledger) {
        Ok((written, device_key)) => {
            outcome.written = written;
            if let Some(device_key) = device_key {
                outcome.present += usize::from(device_key == DeviceKey::AlreadyHeld);
                outcome.device_key = device_key;
            }
            Ok(outcome)
        }
        Err(error) => Err(ledger.roll_back(keyring, error)),
    }
}

fn write(
    plan: &Plan,
    pending: Pending<'_>,
    keyring: &KeyringStore,
    identity: &DeviceIdentityStore,
    evidence: &SecretsEvidence,
    ledger: &mut Ledger,
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
        keyring.set_secret(&slot.service, &slot.account, &slot.value)?;
        ledger.0.push(Written::Generic {
            service: slot.service.clone(),
            account: slot.account.clone(),
        });
    }
    let written = ledger.0.len();
    let Some(device) = &plan.device else {
        return Ok((written, None));
    };
    match identity.adopt_electron(device) {
        Ok(Adoption::Adopted) => Ok((written + 1, Some(DeviceKey::Adopted))),
        Ok(Adoption::AlreadyHeld) => Ok((written, Some(DeviceKey::AlreadyHeld))),
        Err(AdoptError::Taken) => Err(SecretsError::TargetOccupied {
            kind: kind(SecureStoreKey::DeviceSigningKey),
        }),
        Err(AdoptError::Store(error)) => Err(SecretsError::Keychain(error)),
    }
}

#[cfg(test)]
mod tests;
