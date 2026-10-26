//! Decrypting every store entry and merging legacy keytar items into one report.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use super::chromium::{self, DecryptFailure};
use super::key_source::{ChromiumKeySource, KeySourceError};
use super::{
    KeytarSource, SecretEntry, SecretSource, SecretStoreFile, SecretsReport, UnreadableReason,
    UnreadableSecret,
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

impl<'a> Keys<'a> {
    fn password(&mut self, name: &'static str) -> &Lookup<Zeroizing<Vec<u8>>> {
        let source = self.source;
        self.passwords
            .entry(name)
            .or_insert_with(|| source.password(name))
    }

    fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Zeroizing<String>, UnreadableReason> {
        let mut attempt = Attempt::default();
        let plain = match self.profile.host {
            HostOs::Windows => self.windows_candidate(ciphertext, &mut attempt),
            host => self.password_candidates(host, ciphertext, &mut attempt),
        };
        plain.ok_or_else(|| attempt.reason())
    }

    fn windows_candidate(
        &mut self,
        ciphertext: &[u8],
        attempt: &mut Attempt,
    ) -> Option<Zeroizing<String>> {
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

    fn password_candidates(
        &mut self,
        host: HostOs,
        ciphertext: &[u8],
        attempt: &mut Attempt,
    ) -> Option<Zeroizing<String>> {
        // Linux `v10` has a fixed key, so it decrypts with no key source at all.
        if host == HostOs::Linux && !chromium::linux_needs_password(ciphertext) {
            match chromium::decrypt_linux(None, ciphertext) {
                Ok(plain) => return Some(plain),
                Err(failure) => attempt.corrupt |= failure == DecryptFailure::Corrupt,
            }
        }
        for name in self.profile.app_names.0.clone() {
            let lookup = self.password(name).clone();
            attempt.note_lookup(&lookup);
            let Ok(Some(password)) = lookup else { continue };
            attempt.keyed = true;
            let result = if host == HostOs::MacOs {
                chromium::decrypt_macos(&password, ciphertext)
            } else {
                chromium::decrypt_linux(Some(&password), ciphertext)
            };
            match result {
                Ok(plain) => return Some(plain),
                Err(failure) => attempt.corrupt |= failure == DecryptFailure::Corrupt,
            }
        }
        None
    }
}

/// Decrypts every entry of `secure-secrets.json` and fills gaps from `keytar`. A decrypted
/// safeStorage entry wins over a keytar value; an entry that does not decrypt and has no keytar
/// copy is listed as unreadable, never as absent.
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
    for (service, accounts) in &store.entries {
        for (account, encoded) in accounts {
            let outcome = match STANDARD.decode(encoded) {
                Ok(ciphertext) => keys.decrypt(&ciphertext),
                Err(_) => Err(UnreadableReason::CorruptCiphertext),
            };
            match outcome {
                Ok(value) => report.entries.push(SecretEntry {
                    service: service.clone(),
                    account: account.clone(),
                    value,
                    source: SecretSource::SafeStorage,
                }),
                Err(reason) => failed.push(UnreadableSecret {
                    service: service.clone(),
                    account: account.clone(),
                    reason,
                }),
            }
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
