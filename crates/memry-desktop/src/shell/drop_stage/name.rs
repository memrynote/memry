//! The on-disk name of a staged file. The page names the file, so the name is untrusted: it
//! must stay one path segment, be creatable on every OS, and keep its extension (the import
//! decides by extension).

/// Longest name kept, in bytes. Every common file system takes 255; the rest is headroom for a
/// copy suffix a later import might add.
const MAX_NAME_BYTES: usize = 200;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Separators and control characters are removed. Characters Windows refuses in a name become
/// `_`, on every OS, so one dropped file has the same staged name everywhere. Trailing dots and
/// spaces (Windows drops them silently) are trimmed, a reserved device name gets a `_` prefix,
/// and a name over [`MAX_NAME_BYTES`] loses stem characters, never its extension.
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\') && !c.is_control())
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_start().trim_end_matches([' ', '.']);
    let mut name = if trimmed.is_empty() {
        "file".to_owned()
    } else {
        trimmed.to_owned()
    };
    let stem_end = name.find('.').unwrap_or(name.len());
    if RESERVED.contains(&name[..stem_end].to_ascii_uppercase().as_str()) {
        name.insert(0, '_');
    }
    if name.len() > MAX_NAME_BYTES {
        name = shorten(&name);
    }
    name
}

fn shorten(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        // An extension longer than the budget is not one: cut the whole name.
        Some(dot) if dot > 0 && name.len() - dot < MAX_NAME_BYTES / 2 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut end = MAX_NAME_BYTES - ext.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ext}", stem[..end].trim_end_matches([' ', '.']))
}
