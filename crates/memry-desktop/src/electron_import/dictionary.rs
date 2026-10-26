//! Chromium's `Custom Dictionary.txt`: one word per line, then `checksum_v1 = <md5 hex>` over
//! everything before that line (`spellcheck_custom_dictionary.cc`). A failing checksum makes
//! Chromium drop the words, so the reader falls back to `Custom Dictionary.txt.backup`.

use std::fs;
use std::path::Path;

use md5::{Digest, Md5};

use super::ImportError;
use super::profile::ElectronProfile;

const CHECKSUM_PREFIX: &str = "checksum_v1 = ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomDictionary {
    pub words: Vec<String>,
    pub checksum_ok: bool,
    pub from_backup: bool,
}

impl CustomDictionary {
    /// `Ok(None)` when neither file exists. When both checksums fail, the primary file's words
    /// come back with `checksum_ok = false`, so the caller decides whether to trust them.
    pub fn read(profile: &ElectronProfile) -> Result<Option<Self>, ImportError> {
        let primary = profile.dictionary_path();
        let mut backup = primary.clone().into_os_string();
        backup.push(".backup");
        let primary_parsed = read_file(&primary)?;
        if primary_parsed.as_ref().is_some_and(|p| p.checksum_ok) {
            return Ok(primary_parsed);
        }
        if let Some(mut parsed) = read_file(Path::new(&backup))?.filter(|p| p.checksum_ok) {
            parsed.from_backup = true;
            return Ok(Some(parsed));
        }
        Ok(primary_parsed)
    }

    pub fn parse(text: &str) -> Self {
        let mut words = Vec::new();
        let mut checksum_ok = false;
        let mut consumed = 0;
        for line in text.split_inclusive('\n') {
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if let Some(expected) = trimmed.strip_prefix(CHECKSUM_PREFIX) {
                let actual = hex::encode(Md5::digest(&text.as_bytes()[..consumed]));
                checksum_ok = actual.eq_ignore_ascii_case(expected.trim());
                break;
            }
            consumed += line.len();
            if !trimmed.is_empty() {
                words.push(trimmed.to_owned());
            }
        }
        Self {
            words,
            checksum_ok,
            from_backup: false,
        }
    }
}

fn read_file(path: &Path) -> Result<Option<CustomDictionary>, ImportError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ImportError::io(path, e)),
    };
    let text = String::from_utf8(bytes)
        .map_err(|e| ImportError::parse("dictionary", e.utf8_error().valid_up_to()))?;
    Ok(Some(CustomDictionary::parse(&text)))
}

#[cfg(test)]
mod tests;
