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
    missing: bool,
}

impl Attempt {
    fn reason(&self) -> UnreadableReason {
        if self.corrupt {
            UnreadableReason::CorruptCiphertext
        } else if self.keyed {
            UnreadableReason::WrongIdentity
        } else if self.denied {
            UnreadableReason::KeySourceDenied
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
            // A source that failed outright is as good as missing: nothing was read.
            Err(KeySourceError::Failed(_)) => self.missing = true,
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
        self.passwords
            .entry(name)
            .or_insert_with(|| source.password(name))
    }

    /// Windows: GCM authenticates the key, so any UTF-8 result is final.
    fn windows(&mut self, ciphertext: &[u8], attempt: &mut Attempt) -> Option<Zeroizing<String>> {
        let (source, profile) = (self.source, self.profile);
        let lookup = self
            .windows
            .get_or_insert_with(|| source.windows_key(profile));
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

    /// Every CBC key worth trying for `ciphertext`, across both candidate app names.
    fn cbc_candidates(
        &mut self,
        ciphertext: &[u8],
        attempt: &mut Attempt,
    ) -> Vec<chromium::CbcKey> {
        let host = self.profile.host;
        let mut keys = Vec::new();
        // Linux `v10` has a fixed key, so it needs no key source at all.
        if host == HostOs::Linux && !chromium::linux_needs_password(ciphertext) {
            match chromium::cbc_keys(host, None, ciphertext) {
                Ok(found) => keys.extend(found),
                Err(_) => attempt.corrupt = true,
            }
        }
        for name in self.profile.app_names.0.clone() {
            let lookup = self.password(name).clone();
            attempt.note_lookup(&lookup);
            let Ok(Some(password)) = lookup else { continue };
            attempt.keyed = true;
            match chromium::cbc_keys(host, Some(&password), ciphertext) {
                Ok(found) => keys.extend(found),
                Err(_) => attempt.corrupt = true,
            }
        }
        keys
    }
}

/// An entry the first pass could not settle: it decrypted under some key to UTF-8 that is not
/// printable, which proves nothing until a key is validated by another entry.
struct Pending {
    service: String,
    account: String,
    attempt: Attempt,
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
            let mut relaxed = Vec::new();
            let mut accepted = None;
            for key in keys.cbc_candidates(&ciphertext, &mut attempt) {
                match chromium::decrypt_cbc(&key, &ciphertext) {
                    Ok(plain) if chromium::is_printable(&plain) => {
                        if !validated.iter().any(|k| **k == *key) {
                            validated.push(key);
                        }
                        accepted = Some(plain);
                        break;
                    }
                    Ok(plain) => relaxed.push((key, plain)),
                    Err(failure) => attempt.corrupt |= failure == DecryptFailure::Corrupt,
                }
            }
            match accepted {
                Some(value) => report.entries.push(entry(service, account, value)),
                None if !relaxed.is_empty() => pending.push(Pending {
                    service: service.clone(),
                    account: account.clone(),
                    attempt,
                    relaxed,
                }),
                None => failed.push(unreadable(service, account, &attempt)),
            }
        }
    }
    for item in pending {
        let found = item
            .relaxed
            .into_iter()
            .find(|(key, _)| validated.iter().any(|k| **k == **key));
        match found {
            Some((_, value)) => report
                .entries
                .push(entry(&item.service, &item.account, value)),
            None => failed.push(unreadable(&item.service, &item.account, &item.attempt)),
        }
    }
    for item in keytar.items()? {
        if report.get(&item.service, &item.account).is_none() {
            report.entries.push(SecretEntry {
                service: item.service,
                account: item.account,
                value: item.value,
                source: SecretSource::Keytar,
            });
        }
    }
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
    }
}
