/**
 * Shared types for the HTML import pure package.
 *
 * Pure data shapes — no electron / fs / db / jsdom dependencies.
 */

/** One file descriptor given as input to mapFiles. */
export interface HtmlFileDescriptor {
  /** Path relative to the selection root (e.g. 'docs/page.html' or 'page.html'). */
  relPath: string
  /** Absolute path on disk. */
  absPath: string
  /** Page title derived from <title> element or sanitized filename. */
  title: string
}

/** One note entry in the HTML import plan. */
export interface HtmlNotePlan {
  absPath: string
  /** Note title (from <title> or filename). */
  title: string
  /** Vault folder path, e.g. 'HTML' or 'HTML/docs'. */
  vaultFolder: string
}

/** Result of mapFiles. */
export interface HtmlImportPlan {
  notes: HtmlNotePlan[]
}
