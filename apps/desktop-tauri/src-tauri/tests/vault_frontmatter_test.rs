use memry_desktop_tauri_lib::vault::frontmatter::{create_frontmatter, parse_note, serialize_note};

#[test]
fn parses_minimal_frontmatter() {
    let raw = "---\nid: abc123\ntitle: Hello\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\n---\nbody";
    let parsed = parse_note(raw, Some("notes/hello.md")).unwrap();
    assert_eq!(parsed.frontmatter.id, "abc123");
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("Hello"));
    assert_eq!(parsed.content, "body");
    assert!(parsed.had_frontmatter);
    assert!(!parsed.was_modified);
}

#[test]
fn auto_generates_missing_required_fields() {
    let raw = "no frontmatter here\n";
    let parsed = parse_note(raw, Some("notes/x.md")).unwrap();
    assert!(!parsed.frontmatter.id.is_empty());
    assert!(!parsed.frontmatter.created.is_empty());
    assert!(!parsed.frontmatter.modified.is_empty());
    assert!(parsed.was_modified);
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("X"));
}

#[test]
fn extracts_title_from_filename_when_missing() {
    let raw =
        "---\nid: x\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\n---\nbody";
    let parsed = parse_note(raw, Some("notes/my-cool-thought.md")).unwrap();
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("My Cool Thought"));
}

#[test]
fn turkish_chars_roundtrip_byte_identical() {
    let title = "Toplantı: çay & kahve — ÖĞRENME günü";
    let body = "İçerik düzenlendi: çalışma & öğrenme.";
    let mut fm = create_frontmatter(title, &["work".to_string()]);
    fm.id = "fixed-id".to_string();
    let serialized = serialize_note(&fm, body).unwrap();
    let parsed = parse_note(&serialized, None).unwrap();
    assert_eq!(parsed.frontmatter.title.as_deref(), Some(title));
    assert_eq!(parsed.content, body);
}

#[test]
fn multiline_yaml_string_roundtrip() {
    let raw = "---\nid: x\ntitle: With Block\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\nproperties:\n  description: |\n    line one\n    line two\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let props = parsed.frontmatter.properties.as_ref().unwrap();
    let desc = props.get("description").unwrap();
    assert!(desc.as_str().unwrap().contains("line one"));
    assert!(desc.as_str().unwrap().contains("line two"));
}

#[test]
fn date_field_preserved_as_string() {
    let raw =
        "---\nid: x\ntitle: Dated\ncreated: 2026-04-26\nmodified: 2026-04-26T10:30:00Z\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    assert_eq!(parsed.frontmatter.created, "2026-04-26");
    assert_eq!(parsed.frontmatter.modified, "2026-04-26T10:30:00Z");
}

#[test]
fn tags_normalized_to_vec_strings() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\ntags:\n  - work\n  - life\n  - WORK\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    assert_eq!(parsed.frontmatter.tags, vec!["work", "life", "WORK"]);
}

#[test]
fn preserves_non_reserved_properties_through_roundtrip() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\nstatus: active\npriority: 3\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let serialized = serialize_note(&parsed.frontmatter, &parsed.content).unwrap();
    assert!(serialized.contains("status: active"));
    assert!(serialized.contains("priority: 3"));
}

#[test]
fn extract_properties_skips_reserved_keys() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\ntags:\n  - work\nstatus: active\nflag: true\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let props = parsed.frontmatter.extract_properties();
    assert!(props.contains_key("status"));
    assert!(props.contains_key("flag"));
    assert!(!props.contains_key("id"));
    assert!(!props.contains_key("title"));
    assert!(!props.contains_key("tags"));
}
