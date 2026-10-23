export type Translate = (key: string, values?: Record<string, string | number>) => string

/** The module each pane of the stage window draws. */
export type StageFocus =
  | 'home'
  | 'inbox'
  | 'journal'
  | 'calendar'
  | 'tasks'
  | 'graph'
  | 'canvas'
  | 'agent'
