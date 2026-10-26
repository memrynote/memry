//! Windows readers: Chromium's DPAPI-wrapped key in `Local State` and legacy keytar credentials.
//!
//! Read-only: `CryptUnprotectData` with the UI-forbidden flag, `CredEnumerateW` and `CredReadW`.
//! Nothing here writes a credential.

use std::fs;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Credentials::{CREDENTIALW, CredEnumerateW, CredFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
};
use windows::core::HSTRING;
use zeroize::Zeroizing;

use super::key_source::{ChromiumKeySource, KeySourceError};
use super::keytar::{KEYTAR_CALENDAR_PREFIX, KEYTAR_SERVICES, KeytarItem, KeytarSource};
use crate::electron_import::ImportError;
use crate::electron_import::profile::ElectronProfile;

const DPAPI_PREFIX: &[u8] = b"DPAPI";

/// `os_crypt.encrypted_key` of `Local State`: base64 of `DPAPI` + a `CryptProtectData` blob of
/// the 32-byte AES key. `Ok(None)` when the file or the key is absent.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeySource;

impl ChromiumKeySource for OsKeySource {
    fn password(&self, _app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        Ok(None)
    }

    fn windows_key(
        &self,
        profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        let path = profile.local_state_path();
        let raw = match fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(KeySourceError::Failed(format!("Local State: {e}"))),
        };
        let state: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| KeySourceError::Failed("Local State is not valid JSON".into()))?;
        let Some(encoded) = state
            .get("os_crypt")
            .and_then(|o| o.get("encrypted_key"))
            .and_then(|k| k.as_str())
        else {
            return Ok(None);
        };
        let wrapped = STANDARD
            .decode(encoded)
            .map_err(|_| KeySourceError::Failed("encrypted_key is not base64".into()))?;
        let blob = wrapped
            .strip_prefix(DPAPI_PREFIX)
            .ok_or_else(|| KeySourceError::Failed("encrypted_key lacks the DPAPI prefix".into()))?;
        let key = unprotect(blob)?;
        let key: [u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| KeySourceError::Failed("unwrapped key is not 32 bytes".into()))?;
        Ok(Some(Zeroizing::new(key)))
    }
}

/// `CryptUnprotectData` without any UI. The output buffer is wiped and freed before returning.
fn unprotect(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, KeySourceError> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(blob.len())
            .map_err(|_| KeySourceError::Failed("DPAPI blob too large".into()))?,
        pbData: blob.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` points at `blob` for the call; `output` receives a LocalAlloc buffer that
    // is copied, wiped and released below. No UI is possible: CRYPTPROTECT_UI_FORBIDDEN.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| KeySourceError::Failed(format!("CryptUnprotectData: {e}")))?;
        let slice = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let copy = Zeroizing::new(slice.to_vec());
        slice.fill(0);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(copy)
    }
}

/// keytar's `CRED_TYPE_GENERIC` credentials: target name `service/account`, UTF-8 password blob.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsKeytar;

impl OsKeytar {
    fn enumerate(filter: &str) -> Result<Vec<KeytarItem>, ImportError> {
        let mut count = 0_u32;
        let mut creds: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: CredEnumerateW fills `count` and `creds` on success; the array is released with
        // CredFree below and every pointer read stays inside `count` entries.
        unsafe {
            if let Err(error) = CredEnumerateW(&HSTRING::from(filter), None, &mut count, &mut creds)
            {
                // HRESULT_FROM_WIN32(ERROR_NOT_FOUND): nothing matches. Any other failure is a
                // real error and must not read as "no items".
                return if error.code().0 == 0x8007_0490_u32 as i32 {
                    Ok(Vec::new())
                } else {
                    Err(ImportError::KeySource(format!("CredEnumerateW: {error}")))
                };
            }
            let mut items = Vec::new();
            for i in 0..count as usize {
                let cred = &**creds.add(i);
                let Ok(target) = cred.TargetName.to_string() else {
                    continue;
                };
                let Some((service, account)) = target.split_once('/') else {
                    continue;
                };
                let blob = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                if let Ok(text) = std::str::from_utf8(blob) {
                    items.push(KeytarItem {
                        service: service.to_owned(),
                        account: account.to_owned(),
                        value: Zeroizing::new(text.to_owned()),
                    });
                }
            }
            CredFree(creds.cast());
            Ok(items)
        }
    }
}

impl KeytarSource for OsKeytar {
    fn items(&self) -> Result<Vec<KeytarItem>, ImportError> {
        let mut items = Vec::new();
        for service in KEYTAR_SERVICES {
            items.extend(Self::enumerate(&format!("{service}/*"))?);
        }
        items.extend(Self::enumerate(&format!("{KEYTAR_CALENDAR_PREFIX}*"))?);
        Ok(items)
    }
}
