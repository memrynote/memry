/**
 * Said on every canvas tool that takes a canvas id. Two canvases in different
 * folders may share a title, so a bare title is refused when it matches more
 * than one — the tools list the candidates rather than picking one, because
 * drawing on the wrong canvas destroys work silently.
 */
export const CANVAS_ID_HINT =
  'Takes the canvas id or its folder-qualified name ("Work/Plan") from vault_list_canvases; ' +
  'a bare title matching more than one canvas is refused with the candidates listed.'
export const CHECKLIST_HINT =
  'Checkbox lines you add are stored as plain checkboxes, marked {check}, unless the owner ' +
  'turned on task conversion for agents; then they become tasks and the reply lists them in ' +
  'created_tasks. Create tasks with vault_create_task.'
export const CREATED_FOLDERS_HINT =
  'The reply lists the folders the call created in created_folders.'
