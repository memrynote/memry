//! Task-tree shape rules of `task-block.ts`: the depth cap and the re-nesting
//! of a tree BlockNote's parser built under the wrong parent.

use std::collections::HashMap;

use serde_json::Value as Json;

use super::{MAX_NOTE_TASK_DEPTH, children_of, is_task_block, task_id_of};
use crate::markdown::shared::block_colors::js_value::{prop, spread_all};

/// `{...child, props: {...child.props, parentTaskId}}`.
fn with_parent(child: &Json, parent_task_id: &str) -> Json {
    let props = prop(child, "props").cloned().unwrap_or(Json::Null);
    let mut merged = spread_all(&[&props]);
    merged.insert(
        "parentTaskId".to_owned(),
        Json::String(parent_task_id.to_owned()),
    );
    set_key(child, "props", Json::Object(merged))
}

/// `{...block, key: value}`.
fn set_key(block: &Json, key: &str, value: Json) -> Json {
    let mut next = block.clone();
    if let Some(map) = next.as_object_mut() {
        map.insert(key.to_owned(), value);
    }
    next
}

fn too_deep(children: &[Json], depth: usize) -> bool {
    children.iter().any(|child| {
        is_task_block(child)
            && (depth > MAX_NOTE_TASK_DEPTH || too_deep(children_of(child), depth + 1))
    })
}

/// The node, then the task blocks lifted out from under it to its own level.
fn cap(node: &Json, depth: usize) -> Vec<Json> {
    let mut kept: Vec<Json> = Vec::new();
    let mut lifted: Vec<Json> = Vec::new();
    for child in children_of(node) {
        if !is_task_block(child) {
            kept.push(child.clone());
            continue;
        }
        let mut capped = cap(child, depth + 1).into_iter();
        let own = capped.next();
        let target = if depth < MAX_NOTE_TASK_DEPTH {
            &mut kept
        } else {
            &mut lifted
        };
        target.extend(own);
        target.extend(capped);
    }
    let own = if depth < MAX_NOTE_TASK_DEPTH {
        let parent_task_id = task_id_of(node);
        kept.iter()
            .map(|child| {
                if is_task_block(child) {
                    with_parent(child, &parent_task_id)
                } else {
                    child.clone()
                }
            })
            .collect()
    } else {
        kept
    };
    let mut out = vec![set_key(node, "children", Json::Array(own))];
    out.extend(lifted);
    out
}

/// A top-level task block with every task block below [`MAX_NOTE_TASK_DEPTH`]
/// lifted to that depth, in document order, each `parentTaskId` naming its new
/// tree parent. Returns `block` unchanged when nothing sits too deep.
pub fn cap_task_tree_depth(block: &Json) -> Json {
    if !too_deep(children_of(block), 1) {
        return block.clone();
    }
    cap(block, 0).swap_remove(0)
}

struct Node {
    block: Json,
    depth: usize,
    children: Vec<usize>,
}

/// BlockNote's markdown parser strips a task item's sub-lines inconsistently,
/// so a third-level line two spaces deeper per level lands under the wrong
/// parent. The tree is rebuilt from line order and each line's source depth. A
/// tree holding anything but task blocks, or a task the source scan missed, is
/// left as parsed.
pub(super) fn renest_task_tree(root: &Json, depths: &HashMap<String, usize>) -> Json {
    let Some(&root_depth) = depths.get(&task_id_of(root)) else {
        return root.clone();
    };
    let mut flat: Vec<&Json> = Vec::new();
    if !collect(children_of(root), depths, &mut flat) {
        return root.clone();
    }

    let mut nodes = vec![Node {
        block: root.clone(),
        depth: root_depth,
        children: Vec::new(),
    }];
    let mut stack = vec![0_usize];
    for block in flat {
        let depth = depths[&task_id_of(block)];
        while stack.len() > 1 && nodes[stack[stack.len() - 1]].depth >= depth {
            stack.pop();
        }
        if nodes[stack[stack.len() - 1]].depth >= depth {
            return root.clone();
        }
        nodes.push(Node {
            block: block.clone(),
            depth,
            children: Vec::new(),
        });
        let index = nodes.len() - 1;
        let parent = stack[stack.len() - 1];
        nodes[parent].children.push(index);
        stack.push(index);
    }
    let root_parent = prop(root, "props")
        .and_then(|props| prop(props, "parentTaskId"))
        .and_then(Json::as_str)
        .unwrap_or("");
    build(&nodes, 0, root_parent)
}

/// `every` over the descendants in document order; false at the first one that
/// is not a task block the scan knows.
fn collect<'a>(
    children: &'a [Json],
    depths: &HashMap<String, usize>,
    flat: &mut Vec<&'a Json>,
) -> bool {
    children.iter().all(|child| {
        if !is_task_block(child) || !depths.contains_key(&task_id_of(child)) {
            return false;
        }
        flat.push(child);
        collect(children_of(child), depths, flat)
    })
}

fn build(nodes: &[Node], index: usize, parent_task_id: &str) -> Json {
    let node = &nodes[index];
    let own_id = task_id_of(&node.block);
    let children = node
        .children
        .iter()
        .map(|child| build(nodes, *child, &own_id))
        .collect();
    set_key(
        &with_parent(&node.block, parent_task_id),
        "children",
        Json::Array(children),
    )
}
