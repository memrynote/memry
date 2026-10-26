//! Legacy keytar items: the OS-store fallbacks `getSecret` still reads
//! (`apps/desktop/src/main/secrets/secret-storage.ts`).

use zeroize::Zeroizing;

use crate::electron_import::ImportError;

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

pub struct KeytarItem {
    pub service: String,
    pub account: String,
    pub value: Zeroizing<String>,
}

/// Legacy keytar items, read through the OS store. Only the services above are read.
pub trait KeytarSource {
    fn items(&self) -> Result<Vec<KeytarItem>, ImportError>;
}

/// No legacy items; for hosts where keytar never ran and for tests.
pub struct NoKeytar;

impl KeytarSource for NoKeytar {
    fn items(&self) -> Result<Vec<KeytarItem>, ImportError> {
        Ok(Vec::new())
    }
}
