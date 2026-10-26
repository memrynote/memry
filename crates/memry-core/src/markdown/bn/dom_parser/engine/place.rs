//! Placement of nodes into the open context stack (`findPlace`, `enter`).

use super::*;

impl ParseContext<'_> {
    pub(super) fn find_place(
        &mut self,
        node: &Node,
        marks: &[Mark],
        cautious: bool,
    ) -> Result<Option<Vec<Mark>>, ParseError> {
        let mut route: Option<Vec<NodeTypeId>> = None;
        let mut sync_to: Option<u64> = None;
        let mut penalty = 0usize;
        for depth in (0..=self.open).rev() {
            let found = self.context_find_wrapping(depth, node);
            if let Some(found) = found
                && route
                    .as_ref()
                    .is_none_or(|r| r.len() > found.len() + penalty)
            {
                sync_to = Some(self.nodes[depth].uid);
                let empty = found.is_empty();
                route = Some(found);
                if empty {
                    break;
                }
            }
            if self.nodes[depth].solid {
                if cautious {
                    break;
                }
                penalty += 2;
            }
        }
        let Some(route) = route else {
            return Ok(None);
        };
        self.sync(sync_to.expect("a route has a context"));
        let mut marks = marks.to_vec();
        for ty in route {
            marks = self.enter_inner(ty, None, &marks, false, None)?;
        }
        Ok(Some(marks))
    }

    pub(super) fn insert_node(
        &mut self,
        node: Node,
        marks: &[Mark],
        cautious: bool,
    ) -> Result<bool, ParseError> {
        let Some(inner) = self.find_place(&node, marks, cautious)? else {
            return Ok(false);
        };
        self.close_extra(false)?;
        let schema = self.schema;
        let top_ty = self.top().ty;
        if let Some(m) = self.nodes[self.open].matched {
            self.nodes[self.open].matched = schema
                .content_match_at(m)
                .match_type(node.ty)
                .map(|x| x.id());
        }
        let mut node_marks: Vec<Mark> = Vec::new();
        for m in inner.iter().chain(node.marks.iter()) {
            if schema.allows_mark_type(top_ty) {
                node_marks = schema.add_mark_to_set(m, &node_marks);
            }
        }
        let mut placed = node;
        placed.marks = node_marks;
        self.nodes[self.open].content.push(placed);
        Ok(true)
    }

    pub(super) fn enter(
        &mut self,
        ty: NodeTypeId,
        attrs: Option<Attrs>,
        marks: &[Mark],
        preserve: Option<bool>,
    ) -> Result<Option<Vec<Mark>>, ParseError> {
        let probe =
            self.schema
                .create(ty, &attrs_to_given(&attrs), Fragment::default(), Vec::new())?;
        if self.find_place(&probe, marks, false)?.is_some() {
            return Ok(Some(self.enter_inner(ty, attrs, marks, true, preserve)?));
        }
        Ok(None)
    }

    pub(super) fn enter_inner(
        &mut self,
        ty: NodeTypeId,
        attrs: Option<Attrs>,
        marks: &[Mark],
        solid: bool,
        preserve: Option<bool>,
    ) -> Result<Vec<Mark>, ParseError> {
        self.close_extra(false)?;
        let schema = self.schema;
        let open = self.open;
        if let Some(m) = self.nodes[open].matched {
            self.nodes[open].matched = schema.content_match_at(m).match_type(ty).map(|x| x.id());
        }
        let top_options = self.nodes[open].options;
        let mut options = ws_options_for(schema, Some(ty), preserve, top_options);
        if top_options & OPT_OPEN_LEFT != 0 && self.nodes[open].content.is_empty() {
            options |= OPT_OPEN_LEFT;
        }
        let top_ty = self.nodes[open].ty;
        let mut apply: Vec<Mark> = Vec::new();
        let mut rest = Vec::new();
        for m in marks {
            if schema.allows_mark_type(top_ty) {
                apply = schema.add_mark_to_set(m, &apply);
            } else {
                rest.push(m.clone());
            }
        }
        let cx = self.new_context(ty, attrs, apply, solid, options);
        self.nodes.push(cx);
        self.open += 1;
        Ok(rest)
    }
}
