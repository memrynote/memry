//! Decrypting every store entry and merging legacy keytar items into one report.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use super::chromium::{self, DecryptFailure};
use super::key_source::{ChromiumKeySource, KeySourceError};
use super::{
    KeytarSource, SecretEntry, SecretSource, SecretStoreFile, SecretsReport, StoreLeaf,
    UnreadableReason, UnreadableSecret,
};
use crate::electron_import::ImportError;
use crate::electron_import::profile::{ElectronProfile, HostOs};

type Lookup<T> = Result<Option<T>, KeySourceError>;

/// What one ciphertext learned from its failing candidates.
#[derive(Default)]
struct Attempt {
    corrupt: bool,
    /// Some key was available and decrypted to nothing usable.
    keyed: bool,
    denied: bool,
    failed: Option<String>,
    missing: bool,
}

impl Attempt {
    /// A key source that refused or errored outranks a wrong key: the right key may sit behind
    /// it, so the caller must be able to retry (denied: the prompt; failed: the error).
    fn reason(&self) -> UnreadableReason {
        if self.corrupt {
            UnreadableReason::CorruptCiphertext
        } else if self.denied {
            UnreadableReason::KeySourceDenied
        } else if self.failed.is_some() {
            UnreadableReason::KeySourceFailed
        } else if self.keyed {
            UnreadableReason::WrongIdentity
        } else if self.missing {
            UnreadableReason::KeySourceMissing
        } else {
            UnreadableReason::WrongIdentity
        }
    }

    fn note_lookup<T>(&mut self, lookup: &Lookup<T>) {
        match lookup {
            Ok(Some(_)) => {}
            Ok(None) => self.missing = true,
            Err(KeySourceError::Denied) => self.denied = true,
            Err(KeySourceError::Failed(message)) => {
                self.failed.get_or_insert_with(|| message.clone());
            }
        }
    }
}

/// Key material fetched once per run, so a locked keychain prompts once per item.
struct Keys<'a> {
    source: &'a dyn ChromiumKeySource,
    profile: &'a ElectronProfile,
    passwords: HashMap<&'static str, Lookup<Zeroizing<Vec<u8>>>>,
    windows: Option<Lookup<Zeroizing<[u8; 32]>>>,
}

impl Keys<'_> {
    fn password(&mut self, name: &'static str) -> &Lookup<Zeroizing<Vec<u8>>> {
        let source = self.source;
        self.passwords.entry(name).or_insert_with(|| {
            let lookup = source.password(name);
            log_failure("password", &lookup);
            lookup
        })
    }

    /// Windows: GCM authenticates the key, so any UTF-8 result is final.
    fn windows(&mut self, ciphertext: &[u8], attempt: &mut Attempt) -> Option<Zeroizing<String>> {
        let (source, profile) = (self.source, self.profile);
        let lookup = self.windows.get_or_insert_with(|| {
            let lookup = source.windows_key(profile);
            log_failure("windows key", &lookup);
            lookup
        });
        attempt.note_lookup(lookup);
        let Ok(Some(key)) = lookup else { return None };
        attempt.keyed = true;
        match chromium::decrypt_windows(key, ciphertext) {
            Ok(plain) => Some(plain),
            Err(failure) => {
                attempt.corrupt |= failure == DecryptFailure::Corrupt;
                None
            }
        }
    }

    /// Decrypts `ciphertext` with the keys of the app names from `from` on, stopping after the
    /// first name that decrypts it to anything: the next name's key is only asked for (and only
    /// prompts) when nothing decrypted yet. `next` is where the caller resumes.
    fn scan(
        &mut self,
        ciphertext: &[u8],
        from: usize,
        attempt: &mut Attempt,
        validated: &mut Vec<chromium::CbcKey>,
    ) -> Scan {
        let host = self.profile.host;
        let mut scan = Scan {
            accepted: None,
            relaxed: Vec::new(),
            next: from,
        };
        // Linux `v10` has a fixed key, so it needs no key source at all.
        if from == 0 && host == HostOs::Linux && !chromium::linux_needs_password(ciphertext) {
            match chromium::cbc_keys(host, None, ciphertext) {
                Ok(found) => try_keys(found, ciphertext, attempt, validated, &mut scan),
                Err(_) => attempt.corrupt = true,
            }
            if scan.accepted.is_some() || !scan.relaxed.is_empty() {
                scan.next = self.profile.app_names.0.len();
                return scan;
            }
        }
        let names = self.profile.app_names.0.clone();
        for (index, name) in names.into_iter().enumerate().skip(from) {
            scan.next = index + 1;
            let lookup = self.password(name).clone();
            attempt.note_lookup(&lookup);
            let Ok(Some(password)) = lookup else { continue };
            attempt.keyed = true;
            match chromium::cbc_keys(host, Some(&password), ciphertext) {
                Ok(found) => try_keys(found, ciphertext, attempt, validated, &mut scan),
                Err(_) => attempt.corrupt = true,
            }
            if scan.accepted.is_some() || !scan.relaxed.is_empty() {
                break;
            }
        }
        scan
    }
}

struct Scan {
    accepted: Option<Zeroizing<String>>,
    relaxed: Vec<(chromium::CbcKey, Zeroizing<String>)>,
    next: usize,
}

fn try_keys(
    found: Vec<chromium::CbcKey>,
    ciphertext: &[u8],
    attempt: &mut Attempt,
    validated: &mut Vec<chromium::CbcKey>,
    scan: &mut Scan,
) {
    for key in found {
        match chromium::decrypt_cbc(&key, ciphertext) {
            Ok(plain) if chromium::is_printable(&plain) => {
                if !validated.iter().any(|k| **k == *key) {
                    validated.push(key);
                }
                scan.accepted = Some(plain);
                return;
            }
            Ok(plain) => scan.relaxed.push((key, plain)),
            Err(failure) => attempt.corrupt |= failure == DecryptFailure::Corrupt,
        }
    }
}

fn log_failure<T>(what: &str, lookup: &Lookup<T>) {
    if let Err(KeySourceError::Failed(message)) = lookup {
        tracing::warn!(%message, "electron import: {what} source failed");
    }
}

/// An entry the first pass could not settle: it decrypted under some key to UTF-8 that is not
/// printable, which proves nothing until a key is validated by another entry.
struct Pending {
    service: String,
    account: String,
    attempt: Attempt,
    ciphertext: Vec<u8>,
    /// The app name index the first pass stopped at.
    next: usize,
    relaxed: Vec<(chromium::CbcKey, Zeroizing<String>)>,
}

/// Decrypts every entry of `secure-secrets.json` and fills gaps from `keytar`. A decrypted
/// safeStorage entry wins over a keytar value; an entry that does not decrypt and has no keytar
/// copy is listed as unreadable, never as absent.
///
/// A CBC key counts as the right one when it decrypts some entry to printable ASCII (the probe of
/// `probeSecretStoreIdentity`). Under a validated key every entry that decrypts to valid UTF-8 is
/// accepted, as `decryptValue` does, so a value such as "sifre" with accents survives.
pub fn read_all_secrets(
    profile: &ElectronProfile,
    key_source: &dyn ChromiumKeySource,
    keytar: &dyn KeytarSource,
) -> Result<SecretsReport, ImportError> {
    let store = SecretStoreFile::read(profile)?.unwrap_or_default();
    let mut keys = Keys {
        source: key_source,
        profile,
        passwords: HashMap::new(),
        windows: None,
    };
    let mut report = SecretsReport::default();
    let mut failed = Vec::new();
    let mut pending = Vec::new();
    let mut validated: Vec<chromium::CbcKey> = Vec::new();
    for service in &store.malformed_services {
        failed.push(UnreadableSecret {
            service: service.clone(),
            account: String::new(),
            reason: UnreadableReason::CorruptCiphertext,
            detail: None,
        });
    }
    for (service, accounts) in &store.entries {
        for (account, leaf) in accounts {
            let ciphertext = match leaf {
                StoreLeaf::Ciphertext(encoded) => STANDARD.decode(encoded).ok(),
                StoreLeaf::Malformed => None,
            };
            let Some(ciphertext) = ciphertext else {
                failed.push(UnreadableSecret {
                    service: service.clone(),
                    account: account.clone(),
                    reason: UnreadableReason::CorruptCiphertext,
                    detail: None,
                });
                continue;
            };
            let mut attempt = Attempt::default();
            if profile.host == HostOs::Windows {
                match keys.windows(&ciphertext, &mut attempt) {
                    Some(value) => report.entries.push(entry(service, account, value)),
                    None => failed.push(unreadable(service, account, &attempt)),
                }
                continue;
            }
            let scan = keys.scan(&ciphertext, 0, &mut attempt, &mut validated);
            match scan.accepted {
                Some(value) => report.entries.push(entry(service, account, value)),
                None if !scan.relaxed.is_empty() => pending.push(Pending {
                    service: service.clone(),
                    account: account.clone(),
                    attempt,
                    ciphertext,
                    next: scan.next,
                    relaxed: scan.relaxed,
                }),
                None => failed.push(unreadable(service, account, &attempt)),
            }
        }
    }
    for mut item in pending {
        let found = loop {
            let settled = item
                .relaxed
                .drain(..)
                .find(|(key, _)| validated.iter().any(|k| **k == **key))
                .map(|(_, value)| value);
            // Only an entry no validated key settles asks the remaining app names.
            if settled.is_some() || item.next >= profile.app_names.0.len() {
                break settled;
            }
            let scan = keys.scan(
                &item.ciphertext,
                item.next,
                &mut item.attempt,
                &mut validated,
            );
            item.next = scan.next;
            if scan.accepted.is_some() {
                break scan.accepted;
            }
            item.relaxed = scan.relaxed;
        };
        match found {
            Some(value) => report
                .entries
                .push(entry(&item.service, &item.account, value)),
            None => failed.push(unreadable(&item.service, &item.account, &item.attempt)),
        }
    }
    read_keytar(keytar, &mut report, &mut failed);
    report.unreadable = failed
        .into_iter()
        .filter(|u| report.get(&u.service, &u.account).is_none())
        .collect();
    Ok(report)
}

fn entry(service: &str, account: &str, value: Zeroizing<String>) -> SecretEntry {
    SecretEntry {
        service: service.to_owned(),
        account: account.to_owned(),
        value,
        source: SecretSource::SafeStorage,
    }
}

fn unreadable(service: &str, account: &str, attempt: &Attempt) -> UnreadableSecret {
    UnreadableSecret {
        service: service.to_owned(),
        account: account.to_owned(),
        reason: attempt.reason(),
        detail: attempt.failed.clone(),
    }
}

/// Fills gaps from keytar. The listing is attributes only; a secret is read only for an item
/// no safeStorage entry decrypted. A keytar failure never discards the decrypted entries: a
/// failed listing is recorded on the report, a failed read makes that item unreadable.
fn read_keytar(
    keytar: &dyn KeytarSource,
    report: &mut SecretsReport,
    failed: &mut Vec<UnreadableSecret>,
) {
    let listed = match keytar.list() {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "electron import: listing legacy keytar items failed");
            report.keytar_error = Some(error.to_string());
            return;
        }
    };
    for (service, account) in listed {
        if report.get(&service, &account).is_some() {
            continue;
        }
        match keytar.read(&service, &account) {
            Ok(Some(value)) => report.entries.push(SecretEntry {
                service,
                account,
                value,
                source: SecretSource::Keytar,
            }),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, "electron import: reading a keytar item failed");
                let (reason, detail) = match error {
                    KeySourceError::Denied => (UnreadableReason::KeySourceDenied, None),
                    KeySourceError::Failed(message) => {
                        (UnreadableReason::KeySourceFailed, Some(message))
                    }
                };
                if !failed
                    .iter()
                    .any(|u| u.service == service && u.account == account)
                {
                    failed.push(UnreadableSecret {
                        service,
                        account,
                        reason,
                        detail,
                    });
                }
            }
        }
    }
}
