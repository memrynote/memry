//! The OpenAI API key of voice transcription (`voice-transcription-keychain.ts`). Electron keeps
//! it under `memry.voice-transcription`; this app writes only under `com.memrynote.memry.*`
//! (decision of the #3532 15a2 review), and Step 37 (#3554) imports the Electron entry.

use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use zeroize::Zeroizing;

use crate::ai::cached_key::CachedKey;
use crate::seams::secure_store::{GenericSecrets, device_account};

pub const SERVICE: &str = "com.memrynote.memry.voice-transcription";
const ACCOUNT: &str = "openai";

pub struct OpenAiKey {
    key: CachedKey,
    account: String,
}

impl OpenAiKey {
    /// `device` is the `MEMRY_DEVICE` value (the `-<device>` account suffix).
    pub fn new(secrets: Arc<dyn GenericSecrets>, device: Option<&str>) -> Self {
        Self {
            key: CachedKey::new(secrets, SERVICE, "voice transcription API key"),
            account: device_account(ACCOUNT, device),
        }
    }

    pub fn get(&self) -> Result<Option<Zeroizing<String>>, SecureStoreError> {
        self.key.get(&self.account)
    }

    /// `hasVoiceTranscriptionOpenAIApiKey`: a stored key that is not blank.
    pub fn has_key(&self) -> Result<bool, SecureStoreError> {
        Ok(self.get()?.is_some_and(|key| !key.trim().is_empty()))
    }

    /// `setVoiceTranscriptionOpenAIApiKey`: stores the trimmed key; a blank one deletes it.
    pub fn set(&self, api_key: &str) -> Result<(), SecureStoreError> {
        let trimmed = api_key.trim();
        let key = (!trimmed.is_empty()).then(|| Zeroizing::new(trimmed.to_owned()));
        self.key.set(&self.account, key)
    }
}
