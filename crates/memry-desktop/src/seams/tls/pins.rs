//! The pin table and its audit, ported from `packages/sync-client/src/certificate-pins.ts`. A
//! parity test reads that file, so a pin change has to land in both.

/// A pin is `sha256/` and the standard base64 (padded) of the SHA-256 of a certificate's
/// SubjectPublicKeyInfo.
pub const PIN_PREFIX: &str = "sha256/";
pub const DEFAULT_SYNC_HOST: &str = "sync.memrynote.com";

/// The production table. `sync.memrynote.com` still holds placeholders, which means standard TLS
/// (the release owner replaces them using `cargo run -p memry-desktop --example cert_check`);
/// staging holds its real pin.
pub const PINNED_CERTIFICATE_HASHES_BY_HOST: &[(&str, &[&str])] = &[
    (
        DEFAULT_SYNC_HOST,
        &[
            "sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64",
            "sha256/PLACEHOLDER_BACKUP_CERT_HASH_BASE64",
        ],
    ),
    (
        "sync-staging.memrynote.com",
        &["sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4="],
    ),
];

pub fn normalize_hostname(hostname: &str) -> String {
    hostname.trim().to_ascii_lowercase().trim_end_matches('.').to_owned()
}

pub fn is_placeholder(pin: &str) -> bool {
    pin.to_ascii_uppercase().contains("PLACEHOLDER")
}

/// `sha256/<43 base64 characters>=`: the shape of a hash of 32 bytes.
pub fn is_well_formed(pin: &str) -> bool {
    pin.strip_prefix(PIN_PREFIX).is_some_and(|hash| {
        hash.len() == 44
            && hash.ends_with('=')
            && hash[..43]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    })
}

/// What the table says about a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinPolicy<'a> {
    /// No entry: standard TLS (the build gate rejects this for the sync host).
    Unlisted,
    /// An entry with a placeholder: pinning is not activated, standard TLS.
    Placeholder,
    Pinned(&'a [String]),
}

#[derive(Debug, Clone, Default)]
pub struct PinTable {
    entries: Vec<(String, Vec<String>)>,
}

impl PinTable {
    pub fn production() -> Self {
        Self::new(PINNED_CERTIFICATE_HASHES_BY_HOST.iter().map(|(host, pins)| {
            (
                (*host).to_owned(),
                pins.iter().map(|pin| (*pin).to_owned()).collect(),
            )
        }))
    }

    pub fn new(entries: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(host, pins)| (normalize_hostname(&host), pins))
                .collect(),
        }
    }

    pub fn pins_for(&self, hostname: &str) -> &[String] {
        let host = normalize_hostname(hostname);
        self.entries
            .iter()
            .find(|(entry, _)| *entry == host)
            .map_or(&[], |(_, pins)| pins.as_slice())
    }

    pub fn policy(&self, hostname: &str) -> PinPolicy<'_> {
        let pins = self.pins_for(hostname);
        if pins.is_empty() {
            PinPolicy::Unlisted
        } else if pins.iter().any(|pin| is_placeholder(pin)) {
            PinPolicy::Placeholder
        } else {
            PinPolicy::Pinned(pins)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditLevel {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audit {
    pub level: AuditLevel,
    pub message: String,
}

/// The build-time audit of a host's entry (`checkCertificatePinConfig`). Placeholders warn,
/// because the runtime treats them as standard TLS; only a host with no entry or a pin that
/// could never match a real certificate is an error, and `strict` (`MEMRY_CERT_PINS_STRICT=1`)
/// makes placeholders an error too.
pub fn audit(hostname: &str, pins: &[String], strict: bool) -> Audit {
    let result = |level, message: String| Audit { level, message };
    if pins.is_empty() {
        return result(
            AuditLevel::Error,
            format!(
                "No certificate pins configured for sync host {hostname}. Add an entry to certificate-pins.ts and pins.rs."
            ),
        );
    }
    let malformed: Vec<&str> = pins
        .iter()
        .map(String::as_str)
        .filter(|pin| !is_well_formed(pin) && !is_placeholder(pin))
        .collect();
    if !malformed.is_empty() {
        return result(
            AuditLevel::Error,
            format!(
                "Malformed certificate pin(s) for sync host {hostname}: {}. Expected sha256/<base64 SPKI hash>.",
                malformed.join(", ")
            ),
        );
    }
    if pins.iter().any(|pin| is_placeholder(pin)) {
        let remedy = format!(
            "Run 'cargo run -p memry-desktop --example cert_check -- {hostname}' and update the matching host entry in certificate-pins.ts and pins.rs."
        );
        return if strict {
            result(
                AuditLevel::Error,
                format!(
                    "Certificate pinning is required for sync host {hostname} (MEMRY_CERT_PINS_STRICT=1) but the host still has placeholder pins. {remedy}"
                ),
            )
        } else {
            result(
                AuditLevel::Warn,
                format!(
                    "Certificate pinning is not activated for sync host {hostname} - this build uses standard TLS. {remedy}"
                ),
            )
        };
    }
    result(
        AuditLevel::Ok,
        format!("Certificate pins OK for {hostname} ({} pinned)", pins.len()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4=";

    fn owned(pins: &[&str]) -> Vec<String> {
        pins.iter().map(|p| (*p).to_owned()).collect()
    }

    /// The table of `certificate-pins.ts` is the one the Electron app shipped; the two
    /// files must list the same hosts and pins.
    #[test]
    fn the_table_equals_the_one_in_certificate_pins_ts() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/sync-client/src/certificate-pins.ts"
        );
        let source = std::fs::read_to_string(path).expect("certificate-pins.ts");
        let default_host = regex::Regex::new(r"DEFAULT_SYNC_CERT_HOSTNAME\s*=\s*'([^']+)'")
            .unwrap()
            .captures(&source)
            .expect("the default host")[1]
            .to_owned();
        let table_start = source
            .find("PINNED_CERTIFICATE_HASHES_BY_HOST")
            .expect("the table");
        let table = &source[table_start..source[table_start..].find("\n}").unwrap() + table_start];
        let entry = regex::Regex::new(r"(\[DEFAULT_SYNC_CERT_HOSTNAME\]|'[a-z0-9.-]+')\s*:\s*\[([^\]]*)\]")
            .unwrap();
        let pin = regex::Regex::new(r"'(sha256/[^']+)'").unwrap();
        let mut from_ts: Vec<(String, Vec<String>)> = entry
            .captures_iter(table)
            .map(|c| {
                let host = if &c[1] == "[DEFAULT_SYNC_CERT_HOSTNAME]" {
                    default_host.clone()
                } else {
                    c[1].trim_matches('\'').to_owned()
                };
                let pins = pin.captures_iter(&c[2]).map(|p| p[1].to_owned()).collect();
                (host, pins)
            })
            .collect();
        let mut from_rust: Vec<(String, Vec<String>)> = PINNED_CERTIFICATE_HASHES_BY_HOST
            .iter()
            .map(|(host, pins)| ((*host).to_owned(), owned(pins)))
            .collect();
        from_ts.sort();
        from_rust.sort();
        assert!(!from_ts.is_empty());
        assert_eq!(from_rust, from_ts);
        assert_eq!(DEFAULT_SYNC_HOST, default_host);
    }

    #[test]
    fn hosts_are_matched_case_insensitively_without_a_trailing_dot() {
        let table = PinTable::production();
        assert_eq!(
            table.policy("Sync-Staging.MemryNote.com."),
            PinPolicy::Pinned(&owned(&[REAL]))
        );
        assert_eq!(table.policy("sync.memrynote.com"), PinPolicy::Placeholder);
        assert_eq!(table.policy("example.com"), PinPolicy::Unlisted);
    }

    #[test]
    fn a_placeholder_among_real_pins_means_standard_tls() {
        let table = PinTable::new([("h.test".to_owned(), owned(&[REAL, "sha256/PLACEHOLDER_x"]))]);
        assert_eq!(table.policy("h.test"), PinPolicy::Placeholder);
    }

    #[test]
    fn the_audit_follows_check_certificate_pin_config() {
        assert_eq!(audit("h", &[], false).level, AuditLevel::Error);
        assert_eq!(audit("h", &owned(&["sha256/short"]), false).level, AuditLevel::Error);
        assert_eq!(audit("h", &owned(&[REAL]), true).level, AuditLevel::Ok);
        let placeholder = owned(&["sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64"]);
        assert_eq!(audit("h", &placeholder, false).level, AuditLevel::Warn);
        assert_eq!(audit("h", &placeholder, true).level, AuditLevel::Error);
        assert!(is_well_formed(REAL));
        assert!(!is_well_formed("sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4"));
    }
}
