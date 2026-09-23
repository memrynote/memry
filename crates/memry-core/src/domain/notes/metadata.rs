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
/// Sets or clears a note's cover (N703).
///
/// **`coverImage` is not a field of the note schema**, and writing it anyway
/// is safe rather than reckless: §13.2 makes an unknown top-level payload key
/// a thing every conforming client must carry, and §13.2.1 records how desktop
/// meets that obligation — it stores every stripped top-level key in
/// `sync_unknown_fields` and merges it back on push, so a cover written here
/// survives an older desktop editing the same note.
///
/// The shape is `{ "url": ..., "offsetY": ... }`, which is the shape
/// `payload-schemas.json` already carries for this key and the shape N208
/// reads. Inventing a different one would leave this client the only reader of
/// its own writes.
///
/// `None` writes an explicit **null** rather than removing the key, for
/// §13.4's reason: an absent key means "this sender does not know", which is
/// not what removing a cover means.
pub fn set_cover(
    conn: &Connection,
    note_id: &str,
    url: Option<&str>,
    offset_y: f64,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let change = match url {
        Some(url) => Change::Set(serde_json::json!({
            "url": url,
            "offsetY": offset_y.clamp(0.0, 1.0),
        })),
        None => Change::Set(Value::Null),
    };
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("coverImage", change)],
        device_id,
        now_ms,
    )
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
