/**
 * Shared handle between the first-run tour (which arms the prompt) and the star
 * card (which shows it). Kept apart from the tour hook so the card never has to
 * pull driver.js in behind it.
 */

/** `'pending'` while the star prompt is still owed, `'done'` once the user answered it. */
export const STAR_PROMPT_KEY = 'memry:onboarding:star:v1'
/** Fired when the tour ends, so the already-mounted star card can show itself. */
export const STAR_PROMPT_EVENT = 'memry:onboarding:star-prompt'
