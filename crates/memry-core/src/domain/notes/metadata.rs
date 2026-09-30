//! Split from `notes.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// Sets or clears a note's icon, which the payload spells `emoji` (N701).
///
/// `None` writes an explicit **`null`**, never an absent key: §13.4 is
/// explicit that an absent key means "this sender does not know", so removing
/// the key would tell every other device that nothing changed rather than
/// that the user cleared the icon.
pub fn set_icon(
    conn: &Connection,
    note_id: &str,
    icon: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let change = match icon {
        Some(icon) => Change::set(icon),
        None => Change::Set(Value::Null),
    };
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("emoji", change)],
        device_id,
        now_ms,
    )
}

/// Replaces a note's `aliases` (N706).
///
/// Whole-array rather than add-one, because that is what the field is: §13.7.1
/// carries `aliases` as an array, and §13.2's field-level merge resolves the
/// whole value. A caller that wants to add one reads the current list, appends
/// and writes it back, which is what the shell already does for tags.
///
/// **An alias is what lets a wiki link resolve to a note by a name the note
/// itself declares**, so an empty array is written as an empty array rather
/// than as `null`: the user removing their last alias is a fact, and `null`
/// would read as "this sender does not know" (§13.4).
/// Sets or clears a note's cover (N703), in desktop's `cover` field
/// (chapter 13 §13.7.1.1).
///
/// Desktop keeps a cover in the note's frontmatter and carries it in the
/// payload as `cover: {ref, focus?, credit?, creditUrl?}`. `url` is that
/// `ref`: a vault path such as `attachments/<noteId>/<file>`, `wash:<id>`, or
/// an http(s) URL. `offset_y` is the shell's 0-1 framing, stored as desktop's
/// whole-percent `focus` for a picture and left out for a wash.
///
/// **Credit follows the picture, as `useNoteCover` has it on desktop.**
/// Reframing the same `ref` keeps its photographer; a new `ref` drops them,
/// so a cover is never credited to whoever took the previous one.
///
/// `None` writes an explicit **null**, never an absent key: §13.4 says an
/// absent key means "this sender does not know", and desktop keeps its cover
/// when the key is absent. It nulls the legacy `coverImage` too, which readers
/// fall back to when `cover` is null.
pub fn set_cover(
    conn: &Connection,
    note_id: &str,
    url: Option<&str>,
    offset_y: f64,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let changes = match url {
        Some(url) => {
            let payload = crate::domain::note_meta::note_payload(conn, note_id)?;
            let previous = payload
                .as_ref()
                .and_then(crate::domain::note_meta::cover_of);
            // Reframing an older build's `coverImage` keeps it there: moved
            // into `cover`, its HEIC ref would read as no cover, here and on
            // desktop.
            if let Some(previous) = &previous
                && previous.get("legacy") == Some(&Value::Bool(true))
                && previous.get("ref").and_then(Value::as_str) == Some(url)
                && let Some(mut legacy) = payload
                    .as_ref()
                    .and_then(|it| it.get("coverImage"))
                    .and_then(Value::as_object)
                    .cloned()
            {
                legacy.insert("offsetY".to_owned(), Value::from(offset_y.clamp(0.0, 1.0)));
                return edit(
                    conn,
                    ITEM_TYPE,
                    note_id,
                    vec![("coverImage", Change::Set(Value::Object(legacy)))],
                    device_id,
                    now_ms,
                );
            }
            let focus = (offset_y.clamp(0.0, 1.0) * 100.0).round() as i64;
            let mut cover = serde_json::Map::new();
            cover.insert("ref".to_owned(), Value::from(url));
            // A wash has nothing to frame; desktop writes it with no focus.
            if !url.starts_with("wash:") {
                cover.insert("focus".to_owned(), Value::from(focus));
            }
            if let Some(previous) = previous
                && previous.get("ref").and_then(Value::as_str) == Some(url)
            {
                for key in ["credit", "creditUrl"] {
                    if let Some(value) = previous.get(key) {
                        cover.insert(key.to_owned(), value.clone());
                    }
                }
            }
            vec![("cover", Change::Set(Value::Object(cover)))]
        }
        // Readers fall back to an older build's `coverImage` when `cover` is
        // null, so a removal clears both or the old picture comes back.
        None => vec![
            ("cover", Change::Set(Value::Null)),
            ("coverImage", Change::Set(Value::Null)),
        ],
    };
    edit(conn, ITEM_TYPE, note_id, changes, device_id, now_ms)
}

/// Replaces a note's tags (N705).
///
/// **`tags` is a field of the note payload (§13.7.1), not a property.** The
/// tag rows one layer down are a projection of this array, so writing here is
/// what makes a tag exist; writing a property called `tags` would create a
/// second, unrelated thing that no other client reads.
///
/// Whole-array, like `set_aliases` and for the same reason: §13.2 resolves the
/// whole value, and an empty array is a real answer rather than `null`.
///
/// Chapter 12 §12.5.2 records an unresolved two-writer case for tags, where
/// the body's inline `#tag`s and this array can disagree. Nothing here tries
/// to settle it: this writes what the user asked for and leaves the body
/// alone.
pub fn set_tags(
    conn: &Connection,
    note_id: &str,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let values: Vec<Value> = tags.iter().map(|tag| Value::String(tag.clone())).collect();
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("tags", Change::Set(Value::Array(values)))],
        device_id,
        now_ms,
    )
}

pub fn set_aliases(
    conn: &Connection,
    note_id: &str,
    aliases: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let values: Vec<Value> = aliases
        .iter()
        .map(|alias| Value::String(alias.clone()))
        .collect();
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("aliases", Change::Set(Value::Array(values)))],
        device_id,
        now_ms,
    )
}
