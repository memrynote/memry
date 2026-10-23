//! The v1 visibility rule over a flat block list; the port of
//! `packages/shared/src/portal-resolve.ts` (chapter 12 §12.6.3).

use std::collections::HashMap;

use crate::crdt::blocks::Block;

use super::{
    PortalOpen, PortalResolution, PortalStatus, PortalTarget, extract_anchor,
    parse_portal_definition,
};

fn block_text(block: &Block) -> String {
    block.inline.iter().map(|run| run.text.as_str()).collect()
}

fn resolution(status: PortalStatus) -> PortalResolution {
    PortalResolution {
        status,
        blocks: Vec::new(),
        hidden_siblings: Vec::new(),
        hidden_children: HashMap::new(),
    }
}

/// Resolve a definition over its source note's blocks, with hidden counts.
pub fn resolve_portal_detailed(definition_json: &str, blocks: Vec<Block>) -> PortalResolution {
    let Some(definition) = parse_portal_definition(definition_json) else {
        return resolution(PortalStatus::Invalid);
    };
    match definition.target {
        PortalTarget::Search => resolution(PortalStatus::Invalid),
        PortalTarget::Note { hide, .. } => resolve_note(&hide, blocks),
        PortalTarget::Blocks {
            blocks: roots,
            open,
            ..
        } => resolve_blocks(&roots, &open, blocks),
    }
}

/// The anchor each block owns, and the block each anchor belongs to; a repeat
/// of an earlier anchor owns nothing.
fn owned_anchors(blocks: &[Block]) -> (Vec<Option<String>>, HashMap<String, usize>) {
    let mut index_of_anchor: HashMap<String, usize> = HashMap::new();
    let anchors = blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            let anchor = extract_anchor(&block_text(block))?;
            if index_of_anchor.contains_key(&anchor) {
                return None;
            }
            index_of_anchor.insert(anchor.clone(), i);
            Some(anchor)
        })
        .collect();
    (anchors, index_of_anchor)
}

/// A note target: every block except those `hide` names and their
/// descendants (the blocks after one, up to the next at its depth or
/// shallower). `hidden_siblings` holds the outermost hidden blocks.
fn resolve_note(hide: &[String], blocks: Vec<Block>) -> PortalResolution {
    let (_, index_of_anchor) = owned_anchors(&blocks);
    let hidden_roots: Vec<usize> = hide
        .iter()
        .filter_map(|anchor| index_of_anchor.get(anchor).copied())
        .collect();
    let mut result = resolution(PortalStatus::Ok);
    let mut skip_below: Option<u32> = None;
    for (i, block) in blocks.into_iter().enumerate() {
        if let Some(depth) = skip_below {
            if block.depth > depth {
                continue;
            }
            skip_below = None;
        }
        if hidden_roots.contains(&i) {
            skip_below = Some(block.depth);
            result.hidden_siblings.push(block);
        } else {
            result.blocks.push(block);
        }
    }
    result
}

fn resolve_blocks(
    roots: &[String],
    open: &HashMap<String, PortalOpen>,
    blocks: Vec<Block>,
) -> PortalResolution {
    let (anchors, index_of_anchor) = owned_anchors(&blocks);

    let root_indexes: Vec<usize> = roots
        .iter()
        .filter_map(|anchor| index_of_anchor.get(anchor).copied())
        .collect();
    if root_indexes.is_empty() {
        return resolution(PortalStatus::MissingBlock);
    }

    // Parent of each block: the nearest earlier block that is shallower.
    let mut parents: Vec<Option<usize>> = Vec::with_capacity(blocks.len());
    let mut stack: Vec<usize> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        while stack
            .last()
            .is_some_and(|&top| blocks[top].depth >= block.depth)
        {
            stack.pop();
        }
        parents.push(stack.last().copied());
        stack.push(i);
    }

    let mut visible = vec![false; blocks.len()];
    for i in 0..blocks.len() {
        let mut shown = root_indexes.contains(&i);
        if !shown
            && let Some(p) = parents[i]
            && visible[p]
            && let Some(parent_anchor) = &anchors[p]
            && let Some(entry) = open.get(parent_anchor)
        {
            let own = anchors[i].as_deref();
            shown = match entry {
                PortalOpen::Hide(ids) => !own.is_some_and(|a| ids.iter().any(|id| id == a)),
                PortalOpen::Show(ids) => own.is_some_and(|a| ids.iter().any(|id| id == a)),
            };
        }
        visible[i] = shown;
    }

    let root_parents: Vec<Option<usize>> = root_indexes.iter().map(|&i| parents[i]).collect();
    let mut result = resolution(PortalStatus::Ok);
    for (i, block) in blocks.into_iter().enumerate() {
        if visible[i] {
            result.blocks.push(block);
            continue;
        }
        let parent = parents[i];
        if let Some(p) = parent
            && visible[p]
            && let Some(parent_anchor) = &anchors[p]
        {
            result
                .hidden_children
                .entry(parent_anchor.clone())
                .or_default()
                .push(block.clone());
        }
        if root_parents.contains(&parent) {
            result.hidden_siblings.push(block);
        }
    }
    result
}
