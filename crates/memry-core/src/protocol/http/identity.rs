//! The `x-memry-client` identity, chapter 11.

use crate::api::errors::ApiError;

/// `CLIENT_PLATFORMS`, chapter 11 §11.2. **Not** the device-registration
/// platform enum of chapter 02 §2.12: a desktop registers as `macos` and
/// identifies itself here as `desktop`.
pub const CLIENT_PLATFORMS: [&str; 3] = ["ios", "android", "desktop"];

/// The `x-memry-client` value, validated against the server's own grammar.
///
/// Chapter 11 §11.3: an absent, empty or malformed header is treated as absent
/// by the server, which means legacy desktop and **no write gate at all**. A
/// client that sends a typo therefore opts itself out silently, so this type
/// refuses to build one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentity {
    platform: String,
    app_version: String,
}

impl ClientIdentity {
    pub fn new(platform: &str, app_version: &str) -> Result<Self, ApiError> {
        if !CLIENT_PLATFORMS.contains(&platform) {
            return Err(ApiError::InvalidClientIdentity {
                what: format!("platform must be one of {CLIENT_PLATFORMS:?}, got {platform:?}"),
            });
        }
        validate_app_version(app_version)?;
        Ok(Self {
            platform: platform.to_string(),
            app_version: app_version.to_string(),
        })
    }

    /// `<platform>/<major>.<minor>.<patch>[+<build>]`, chapter 11 §11.2.
    pub fn header_value(&self) -> String {
        format!("{}/{}", self.platform, self.app_version)
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    pub fn app_version(&self) -> &str {
        &self.app_version
    }
}

/// The version half of `/^([a-z]+)\/(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/`.
///
/// Hand-checked rather than matched with a regex crate: one grammar, twelve
/// lines, and no dependency that has to be kept in step with the server's.
/// Pre-release identifiers are rejected on purpose (chapter 11 §11.2) — the
/// floor comparison is a numeric triple compare, so `1.0.0-beta.1` would let a
/// beta satisfy a floor its release does not.
fn validate_app_version(app_version: &str) -> Result<(), ApiError> {
    let reject = |what: String| Err(ApiError::InvalidClientIdentity { what });
    let (triple, build) = match app_version.split_once('+') {
        Some((triple, build)) => (triple, Some(build)),
        None => (app_version, None),
    };
    let parts: Vec<&str> = triple.split('.').collect();
    if parts.len() != 3 {
        return reject(format!("{app_version:?} is not a major.minor.patch triple"));
    }
    for part in parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return reject(format!(
                "{app_version:?} has a non-numeric version component"
            ));
        }
    }
    if let Some(build) = build
        && (build.is_empty()
            || !build
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))
    {
        return reject(format!("{app_version:?} has an invalid +build suffix"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_header_follows_the_chapter_11_grammar() {
        let identity = ClientIdentity::new("ios", "1.2.3").unwrap();
        assert_eq!(identity.header_value(), "ios/1.2.3");
        assert_eq!(
            ClientIdentity::new("ios", "1.2.3+42")
                .unwrap()
                .header_value(),
            "ios/1.2.3+42"
        );
    }
    #[test]
    fn a_header_the_server_would_treat_as_absent_is_refused() {
        // macos is the device-registration platform, not a client platform
        // (chapter 02 §2.12).
        assert!(ClientIdentity::new("macos", "1.2.3").is_err());
        assert!(ClientIdentity::new("ios", "1.2").is_err());
        assert!(ClientIdentity::new("ios", "1.2.3-beta.1").is_err());
        assert!(ClientIdentity::new("ios", "1.2.x").is_err());
        assert!(ClientIdentity::new("ios", "1.2.3+").is_err());
        assert!(ClientIdentity::new("", "1.2.3").is_err());
    }
}
