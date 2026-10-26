//! A block copied without the subtrees the caller is about to replace.
//!
//! The TypeScript spreads a block (`{ ...block, content, children }`), which is
//! shallow. A `serde_json::Value::clone` is deep, so cloning a block and then
//! overwriting its `children` copies every descendant once per level of nesting.

use serde_json::Value as Json;

/// `block.clone()` with each of `keys` that the block holds set to `null`, in
/// its original position. The caller writes the real value back.
pub fn clone_without(block: &Json, keys: &[&str]) -> Json {
    let Some(map) = block.as_object() else {
        return block.clone();
    };
    Json::Object(
        map.iter()
            .map(|(key, value)| {
                let kept = if keys.contains(&key.as_str()) {
                    Json::Null
                } else {
                    value.clone()
                };
                (key.clone(), kept)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn replaced_keys_keep_their_position_and_lose_their_value() {
        let block = json!({"id": "a", "children": [{"id": "b"}], "type": "paragraph"});
        let copy = clone_without(&block, &["children"]);
        assert_eq!(
            serde_json::to_string(&copy).unwrap(),
            r#"{"id":"a","children":null,"type":"paragraph"}"#
        );
    }
}
