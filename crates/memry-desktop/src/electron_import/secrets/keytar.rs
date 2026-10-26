//! Legacy keytar items: the OS-store fallbacks `getSecret` still reads
//! (`apps/desktop/src/main/secrets/secret-storage.ts`).

use zeroize::Zeroizing;

use super::key_source::KeySourceError;

/// Services the Electron app wrote with keytar and the migration imports.
pub const KEYTAR_SERVICES: [&str; 6] = [
    "com.memry.sync",
    "com.memry.readwise",
    "com.memry.import.onenote",
    "memry.voice-transcription",
    "memry.agent.local-provider",
    "com.memry.capture",
];
pub const KEYTAR_CALENDAR_PREFIX: &str = "com.memry.calendar.";

pub fn is_keytar_service(service: &str) -> bool {
    KEYTAR_SERVICES.contains(&service) || service.starts_with(KEYTAR_CALENDAR_PREFIX)
}

/// Legacy keytar items, read through the OS store in two steps so that no secret is read (and no
/// prompt shown) for an item the safeStorage store already settled.
pub trait KeytarSource {
    /// `(service, account)` of every item of the services above. Attributes only: no secret is
    /// read and no prompt is shown.
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError>;

    /// The secret of one item. `Ok(None)` when it is gone or not UTF-8 text (keytar wrote text).
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError>;
}

/// No legacy items; for hosts where keytar never ran and for tests.
pub struct NoKeytar;

impl KeytarSource for NoKeytar {
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        Ok(Vec::new())
    }

    fn read(&self, _: &str, _: &str) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        Ok(None)
    }
}
