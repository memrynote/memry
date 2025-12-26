# useEffect Audit

Scope: all `useEffect(` calls in `src/renderer/src` (216 total), reviewed manually.

Legend:
- Good: required side effect (DOM, subscriptions, timers, persistence, external systems)
- OK: state sync/derived use; acceptable but can be simplified
- Needs change: derived state or avoidable effect; alternative provided

## src/renderer/src/pages/template-editor.tsx
- useEffect @128: Good. Load template data when editing.
- useEffect @159: Good. Initialize initial state ref for new templates.

## src/renderer/src/components/shared/outline-info-panel.tsx
- useEffect @84: Good. Scroll active heading into view when popup opens.
- useEffect @99: Good. Cleanup hover timeout on unmount.

## src/renderer/src/pages/journal.tsx
- useEffect @202: OK. Sync editor load counter when entry finishes loading for selected date.
- useEffect @224: OK. Reset last-loaded ref when selected date changes.
- useEffect @250: Good. Delay spinner with a timer to avoid flicker.
- useEffect @268: Good. Sync sidebar open state with focus mode.
- useEffect @286: Good. Restore sidebar state on unmount.
- useEffect @449: Good. Keyboard shortcut listener with cleanup.
- useEffect @475: Good. Load focus mode from localStorage on mount.
- useEffect @480: Good. Persist focus mode to localStorage.

## src/renderer/src/components/card-view.tsx
- useEffect @152: Good. Scroll focused card into view.
- useEffect @327: OK. Reset focus when items change to keep focus valid.
- useEffect @555: Good. Global keydown listener for navigation.

## src/renderer/src/contexts/tasks/index.tsx
- useEffect @249: Good. Load tasks/projects from database when vault opens.
- useEffect @320: Good. Reset loaded flag when vault closes.
- useEffect @337: Good. Sync tasks to parent callback.
- useEffect @341: Good. Sync projects to parent callback.
- useEffect @348: Good. Subscribe to task/project events for live updates.

## src/renderer/src/pages/tasks.tsx
- useEffect @352: OK. Reset view mode when it becomes unavailable; consider clamping in setter.
- useEffect @448: Good. Sync selection to parent for drag/drop.
- useEffect @651: Good. Keyboard shortcut listener with cleanup.

## src/renderer/src/contexts/tabs/persistence/hooks.ts
- useEffect @36: Good. Debounced tab state persistence.
- useEffect @66: Good. Save state on beforeunload.
- useEffect @174: Good. Auto-restore session on mount.

## src/renderer/src/pages/inbox.tsx
- useEffect @139: Good. Global keyboard shortcuts for inbox actions.

## src/renderer/src/components/note/info-section/InfoSection.tsx
- useEffect @98: Good. Detect new property and set auto-focus state.

## src/renderer/src/pages/note.tsx
- useEffect @214: Good. Load note on noteId change.
- useEffect @219: Good. Cleanup save timeout on unmount.
- useEffect @228: Good. Subscribe to note deletion events.

## src/renderer/src/components/note/info-section/editors/DateEditor.tsx
- useEffect @24: OK. Sync local value from prop; could be fully controlled if desired.
- useEffect @28: Good. Auto-focus input when requested.

## src/renderer/src/components/note/content-area/ContentArea.tsx
- useEffect @323: Good. Keep noteId ref in sync for uploads.
- useEffect @451: Good. Load initial content once on mount.
- useEffect @569: Good. Initial heading extraction for outline.
- useEffect @577: Good. Intercept link clicks in editor DOM.
- useEffect @734: Good. Capture drop events for non-image uploads.

## src/renderer/src/components/ui/calendar.tsx
- useEffect @182: Good. Focus day button when focused by keyboard.

## src/renderer/src/components/note/info-section/editors/TextEditor.tsx
- useEffect @22: OK. Sync local value from prop.
- useEffect @26: Good. Auto-focus/select input.

## src/renderer/src/lib/hooks/use-mobile.ts
- useEffect @8: Good. MatchMedia listener for mobile breakpoint.

## src/renderer/src/components/note/info-section/editors/UrlEditor.tsx
- useEffect @23: OK. Sync local value from prop.
- useEffect @27: Good. Auto-focus/select input.

## src/renderer/src/components/note/info-section/editors/LongTextEditor.tsx
- useEffect @22: OK. Sync local value from prop.
- useEffect @26: Good. Auto-focus/select textarea.
- useEffect @34: Good. Auto-resize textarea on content change.

## src/renderer/src/components/virtualized-notes-tree.tsx
- useEffect @254: Good. Persist expanded folders to storage.

## src/renderer/src/components/note/note-title/TitleInput.tsx
- useEffect @23: OK. Sync local value from prop.
- useEffect @36: Good. Auto-resize textarea to content.
- useEffect @41: Good. Auto-focus and move cursor to end.

## src/renderer/src/components/stale/stale-card.tsx
- useEffect @136: Good. Scroll focused card into view.

## src/renderer/src/components/ui/toast.tsx
- useEffect @21: Good. Animate toast in/out and auto-dismiss timer.

## src/renderer/src/components/note/tags-row/TagInputPopup.tsx
- useEffect @36: Good. Focus input when popup opens.
- useEffect @43: Good. Reset state when popup closes.

## src/renderer/src/components/note/info-section/editors/NumberEditor.tsx
- useEffect @22: OK. Sync local value from prop.
- useEffect @26: Good. Auto-focus/select input.

## src/renderer/src/components/note/info-section/PropertyRow.tsx
- useEffect @39: Good. Enter edit mode when autoFocus is true.

## src/renderer/src/components/note/version-history.tsx
- useEffect @118: Good. Keydown handling + focus restore on close.
- useEffect @165: Good. Load versions on open; reset state on close.

## src/renderer/src/components/split-view/split-pane.tsx
- useEffect @46: OK. Sync local ratio from prop when not resizing.
- useEffect @60: Good. Mousemove/mouseup listeners and cursor lock during resize.

## src/renderer/src/components/note/info-section/AddPropertyPopup.tsx
- useEffect @37: Good. Focus first option when popup opens.

## src/renderer/src/components/note/note-title/use-click-outside.ts
- useEffect @8: Good. Document click/touch listeners with cleanup.

## src/renderer/src/components/split-view/tab-content.tsx
- useEffect @37: Good. Save scroll position on unmount/tab change.
- useEffect @55: Good. Restore scroll position on mount.

## src/renderer/src/components/note/outline-edge.tsx
- useEffect @79: Good. Scroll active heading into view when popup opens.
- useEffect @92: Good. Cleanup hover timeout on unmount.

## src/renderer/src/components/inline-quick-file.tsx
- useEffect @33: Good. Auto-focus input on mount.

## src/renderer/src/components/note/export-dialog.tsx
- useEffect @75: Good. Escape key handler for dialog close.

## src/renderer/src/components/ui/sidebar.tsx
- useEffect @95: Good. Keyboard shortcut to toggle sidebar.

## src/renderer/src/components/note/note-layout.tsx
- useEffect @40: Good. Load sidebar preference from localStorage.

## src/renderer/src/components/bulk/delete-confirmation-dialog.tsx
- useEffect @29: Good. Escape key handler while dialog open.

## src/renderer/src/components/bulk/bulk-file-panel.tsx
- useEffect @72: Good. Reset state when panel opens.
- useEffect @80: Good. Keydown listener for Cmd/Ctrl+Enter.

## src/renderer/src/components/bulk/bulk-tag-popover.tsx
- useEffect @36: Good. Reset tag state and focus input on open.

## src/renderer/src/components/icon-picker.tsx
- useEffect @394: Good. Click-outside/escape listeners and input focus on open.

## src/renderer/src/components/sr-announcer.tsx
- useEffect @47: Good. Register global announcer callback and drain queue.

## src/renderer/src/components/tasks/custom-repeat-dialog.tsx
- useEffect @389: Good. Reset form state on open/config change.

## src/renderer/src/hooks/use-note-editor.ts
- useEffect @145: Good. Load note on mount/noteId change.
- useEffect @154: Good. Subscribe to note deletion/external change events.
- useEffect @179: Good. Cleanup save timeout on unmount.

## src/renderer/src/components/list-view.tsx
- useEffect @282: OK. Reset focus when items change to keep focus valid.
- useEffect @293: OK. Reset highlighted index when query changes.
- useEffect @528: Good. Global keydown listener for navigation.
- useEffect @534: Good. Click-outside listener to cancel quick file.

## src/renderer/src/components/notes-tree.tsx
- useEffect @302: Good. Focus note rename input when renaming.
- useEffect @310: Good. Focus folder rename input when renaming.
- useEffect @318: Good. Load folder template names asynchronously.
- useEffect @985: Good. Delete/backspace handler on tree container.
- useEffect @1064: Good. Notify parent when action buttons change.

## src/renderer/src/components/tasks/filters/due-date-filter.tsx
- useEffect @43: OK. Sync local state from prop; consider fully controlled state if desired.

## src/renderer/src/components/filing/filing-panel.tsx
- useEffect @105: Good. Reset state on open/item change.
- useEffect @114: Good. Keyboard shortcut listener for filing.

## src/renderer/src/hooks/use-task-order.ts
- useEffect @84: Good. Persist ordering to localStorage.

## src/renderer/src/components/note/related-notes/AddReferencePopup.tsx
- useEffect @37: Good. Focus input on open.
- useEffect @43: OK. Recompute search results on query; could be useMemo if synchronous.

## src/renderer/src/components/filing/link-search.tsx
- useEffect @101: Good. Click-outside listener to close dropdown.
- useEffect @118: OK. Reset highlighted index when results change.

## src/renderer/src/hooks/use-note-properties.ts
- useEffect @97: Good. Fetch note properties on noteId change.

## src/renderer/src/components/tasks/bulk-actions/selection-checkbox.tsx
- useEffect @46: Good. Imperatively set indeterminate state on checkbox.

## src/renderer/src/hooks/use-journal-scroll.ts
- useEffect @230: Good. Scroll listener with rAF throttling.
- useEffect @253: Good. Initial scroll to today when cards register.

## src/renderer/src/components/search/search-modal.tsx
- useEffect @28: Good. Reset state and focus input on open.
- useEffect @37: OK. Reset selection when results change.
- useEffect @42: Good. Scroll selected item into view.

## src/renderer/src/components/kibo-ui/tree/index.tsx
- useEffect @448: OK. Sync inherited icon from parent context; could compute in render if no local overrides.
- useEffect @457: Good. Register/unregister tree node.
- useEffect @857: OK. Mark parent node as having children.
- useEffect @910: OK. Mark parent node as having children.

## src/renderer/src/components/tabs/tab-bar-with-drag.tsx
- useEffect @63: Good. Scroll listener + ResizeObserver for tab bar.

## src/renderer/src/hooks/use-focus-trap.ts
- useEffect @61: Good. Focus trap activation, keydown listener, and focus restore.

## src/renderer/src/components/tasks/drag-drop/sortable-task-row.tsx
- useEffect @144: Good. Scroll row into view when selected.

## src/renderer/src/components/tasks/calendar/calendar-view.tsx
- useEffect @50: Good. Window resize listener to compute compact layout.

## src/renderer/src/hooks/use-reveal-in-sidebar.ts
- useEffect @103: Good. Custom event listener for reveal-in-sidebar.

## src/renderer/src/components/tasks/filters/search-input.tsx
- useEffect @58: Good. Auto-focus input when requested.

## src/renderer/src/components/tabs/tab-bar.tsx
- useEffect @50: Good. Scroll listener + ResizeObserver for tab bar.

## src/renderer/src/components/tasks/task-description.tsx
- useEffect @39: Good. Cleanup debounce timer on unmount.
- useEffect @64: OK. Sync local value from prop.
- useEffect @98: Good. Auto-resize textarea on content change.

## src/renderer/src/hooks/use-reduced-motion.ts
- useEffect @14: Good. MatchMedia listener for reduced motion preference.

## src/renderer/src/hooks/use-focus-management.ts
- useEffect @16: Good. Track focusin to set active group.

## src/renderer/src/components/preview/audio-player.tsx
- useEffect @32: Good. Interval to simulate playback progress.
- useEffect @58: Needs change. Derived progress from currentTime/duration; compute inline or via useMemo, remove progress state.

## src/renderer/src/hooks/use-expanded-tasks.ts
- useEffect @88: Good. Persist expanded task IDs.
- useEffect @95: Good. Reload expanded IDs when storage key changes.

## src/renderer/src/hooks/use-notes.ts
- useEffect @394: Good. Auto-load notes on mount.
- useEffect @401: Good. Subscribe to note events.
- useEffect @540: Good. Load tags and subscribe to tag changes.
- useEffect @584: Good. Load note links on noteId change.
- useEffect @593: Good. Subscribe to note events for link refresh.
- useEffect @659: Good. Load folders on mount.

## src/renderer/src/components/preview/preview-panel.tsx
- useEffect @208: Good. Keydown handler to close preview panel.

## src/renderer/src/hooks/use-pages.ts
- useEffect @106: Good. Persist pages to localStorage.

## src/renderer/src/hooks/use-search-shortcut.ts
- useEffect @29: Good. Global Cmd/Ctrl+P search shortcut.

## src/renderer/src/hooks/use-vault.ts
- useEffect @45: Good. Load initial vault status/config.
- useEffect @67: Good. Subscribe to vault events.
- useEffect @245: Good. Load vault list on mount.

## src/renderer/src/components/tasks/add-task-modal.tsx
- useEffect @93: Good. Reset form and focus title on open.

## src/renderer/src/components/tasks/priority-select.tsx
- useEffect @99: Good. Reset highlighted index when popover opens.
- useEffect @148: Good. Keydown listener for selection.
- useEffect @161: Good. Scroll highlighted option into view.

## src/renderer/src/hooks/use-tags.ts
- useEffect @79: Good. Persist tags to localStorage.

## src/renderer/src/hooks/use-journal.ts
- useEffect @103: Good. Sync isDirty ref.
- useEffect @108: Good. Reset pending state when date changes.
- useEffect @135: Good. Prefetch adjacent journal entries.
- useEffect @305: Good. Cleanup save timer on unmount.
- useEffect @316: Good. Subscribe to journal events.
- useEffect @416: Good. Refresh heatmap on entry changes.

## src/renderer/src/hooks/use-task-settings.ts
- useEffect @74: Good. Persist task settings to localStorage.

## src/renderer/src/components/tasks/task-detail-header.tsx
- useEffect @37: OK. Sync local title from prop.
- useEffect @42: Good. Focus input when editing starts.

## src/renderer/src/components/tabs/tab-bar-with-overflow.tsx
- useEffect @53: Good. Overflow detection with resize observer.
- useEffect @88: Good. Scroll active tab into view.

## src/renderer/src/hooks/use-keyboard-shortcuts-base.ts
- useEffect @134: Good. Global keydown listener for shortcuts.

## src/renderer/src/hooks/use-overdue-celebration.ts
- useEffect @73: Good. Trigger celebration on overdue clear and cleanup timer.

## src/renderer/src/components/tasks/celebration-progress.tsx
- useEffect @37: Good. Trigger celebration animation on completion.

## src/renderer/src/hooks/use-property-definitions.ts
- useEffect @100: Good. Initial fetch of property definitions.

## src/renderer/src/hooks/use-search.ts
- useEffect @52: Good. Debounce hook for search queries.
- useEffect @193: Good. Auto-search on debounced query.
- useEffect @237: Good. Quick search on debounced query.
- useEffect @311: Good. Subscribe to index rebuild events.
- useEffect @328: Good. Load search stats on mount.
- useEffect @388: Good. Load recent searches on mount.

## src/renderer/src/hooks/use-templates.ts
- useEffect @173: Good. Auto-load templates on mount.
- useEffect @180: Good. Subscribe to template events.

## src/renderer/src/hooks/use-active-heading.ts
- useEffect @104: Good. Scroll/resize listeners for active heading tracking.

## src/renderer/src/components/tasks/note-search-dropdown.tsx
- useEffect @44: Good. Debounce search query.
- useEffect @52: Good. Load notes on open/query change.

## src/renderer/src/hooks/use-task-filters.ts
- useEffect @35: Good. Debounce hook.
- useEffect @173: Good. Persist filters on change.
- useEffect @180: Good. Reset filters when view changes.
- useEffect @351: Good. Load saved filters on mount.
- useEffect @368: Good. Subscribe to saved filter events.

## src/renderer/src/components/tasks/virtualized-all-tasks-view.tsx
- useEffect @431: Good. Remeasure virtualizer when expanded state changes.

## src/renderer/src/hooks/use-tasks-linked-to-note.ts
- useEffect @47: Good. Load linked tasks on noteId change.
- useEffect @57: Good. Subscribe to task events for refresh.

## src/renderer/src/hooks/use-undo.ts
- useEffect @128: Good. Register undo listeners.
- useEffect @179: Good. Global undo shortcut handler.

## src/renderer/src/components/tabs/live-announcer.tsx
- useEffect @23: OK. Update live region text on active tab change.

## src/renderer/src/hooks/use-chord-shortcuts.ts
- useEffect @206: Good. Global keydown listener for chord shortcuts.

## src/renderer/src/components/tabs/truncated-tab-title.tsx
- useEffect @29: Good. Measure truncation after render.

## src/renderer/src/components/tasks/projects/projects-tab-content.tsx
- useEffect @219: OK. Sync auto-selected project to parent; consider handling in parent selection logic.

## src/renderer/src/components/journal/journal-editor.tsx
- useEffect @218: Good. Sync editor content from prop changes.
- useEffect @225: Good. Optional focus when day becomes active.

## src/renderer/src/components/tasks/today/virtualized-today-view.tsx
- useEffect @393: Good. Remeasure virtualizer when expanded state changes.

## src/renderer/src/components/tabs/accessible-tab.tsx
- useEffect @46: Good. Focus tab when keyboard-focused.

## src/renderer/src/components/tasks/natural-date-input.tsx
- useEffect @54: Good. Debounce parse of natural date input.
- useEffect @69: OK. Notify parent on value change; could call onInputChange in handler.

## src/renderer/src/components/journal/extensions/wiki-link/wiki-link-autocomplete.tsx
- useEffect @40: OK. Reset selection when items change.
- useEffect @45: Good. Scroll selection into view.

## src/renderer/src/components/tasks/quick-add/autocomplete-dropdown.tsx
- useEffect @112: OK. Reset selection when options change.
- useEffect @117: Good. Scroll selection into view.
- useEffect @161: Good. Keydown listener for navigation.

## src/renderer/src/components/journal/collapsible-section.tsx
- useEffect @49: Good. Measure content height for animation.

## src/renderer/src/components/tasks/task-metadata.tsx
- useEffect @43: Good. Load source note metadata when noteId changes.

## src/renderer/src/components/tasks/task-detail-panel.tsx
- useEffect @105: Good. Escape key handler to close panel.

## src/renderer/src/components/tasks/quick-add-input.tsx
- useEffect @159: Needs change. Derived autocomplete state from value/focus; compute via useMemo and render from derived values instead of effect/state.

## src/renderer/src/components/tasks/detail-panel/subtask-detail-item.tsx
- useEffect @97: Good. Focus input when editing.
- useEffect @105: OK. Sync edit title from subtask prop.

## src/renderer/src/components/tasks/project/virtualized-project-task-list.tsx
- useEffect @311: Good. Remeasure virtualizer when expanded state changes.

## src/renderer/src/components/tasks/task-links-section.tsx
- useEffect @39: Good. Fetch linked note details on noteId change.

## src/renderer/src/components/tasks/kanban/kanban-board.tsx
- useEffect @520: Good. Clear focus when focused task is deleted.
- useEffect @536: Good. Global keydown listener for kanban navigation.

## src/renderer/src/components/journal/extensions/tag/tag-autocomplete.tsx
- useEffect @40: OK. Reset selection when items change.
- useEffect @45: Good. Scroll selection into view.

## src/renderer/src/components/tasks/kanban/kanban-card.tsx
- useEffect @102: Good. Scroll card into view when focused.

## src/renderer/src/components/tasks/sortable-parent-task-row.tsx
- useEffect @103: Good. Scroll row into view when selected.

## src/renderer/src/components/journal/note-drawer.tsx
- useEffect @48: Good. Escape key handler for drawer.
- useEffect @59: Good. Focus close button on open.

## src/renderer/src/components/tasks/kanban/kanban-card-edit.tsx
- useEffect @44: Good. Focus title input on mount.

## src/renderer/src/components/tasks/due-date-picker.tsx
- useEffect @191: Good. Reset state on popover close.
- useEffect @199: OK. Sync time picker visibility with time prop.
- useEffect @298: Good. Keydown listener while popover open.

## src/renderer/src/components/tasks/project-modal.tsx
- useEffect @136: Good. Reset form state when modal opens/changes.
- useEffect @152: OK. Validate form in effect; could compute errors via useMemo.
