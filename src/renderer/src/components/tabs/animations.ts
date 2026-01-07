/**
 * Tab Animation Variants
 * Framer Motion variants for tab system animations
 */

// =============================================================================
// TAB ANIMATIONS
// =============================================================================

/**
 * Tab appear/disappear animation
 */
export const tabVariants = {
  initial: {
    opacity: 0,
    width: 0,
    marginRight: 0
  },
  animate: {
    opacity: 1,
    width: 'auto',
    marginRight: 8,
    transition: {
      duration: 0.2,
      ease: 'easeOut'
    }
  },
  exit: {
    opacity: 0,
    width: 0,
    marginRight: 0,
    transition: {
      duration: 0.15,
      ease: 'easeIn'
    }
  }
}

/**
 * Reduced motion tab variants
 */
export const tabVariantsReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.05 } }
}

// =============================================================================
// CONTENT ANIMATIONS
// =============================================================================

/**
 * Tab content transition
 */
export const contentVariants = {
  initial: {
    opacity: 0,
    y: 10
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.15,
      ease: 'easeOut'
    }
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: {
      duration: 0.1,
      ease: 'easeIn'
    }
  }
}

/**
 * Reduced motion content variants
 */
export const contentVariantsReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.05 } }
}

// =============================================================================
// SPLIT PANE ANIMATIONS
// =============================================================================

/**
 * Split pane appear/disappear
 */
export const splitPaneVariants = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: 0.2 }
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15 }
  }
}

// =============================================================================
// DRAG ANIMATIONS
// =============================================================================

/**
 * Drag feedback variants
 */
export const dragFeedbackVariants = {
  dragging: {
    scale: 1.02,
    boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
    zIndex: 50
  },
  idle: {
    scale: 1,
    boxShadow: 'none',
    zIndex: 0
  }
}

// =============================================================================
// DROP ZONE ANIMATIONS
// =============================================================================

/**
 * Drop zone highlight animation
 */
export const dropZoneVariants = {
  inactive: {
    opacity: 0,
    scale: 0.95
  },
  active: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.15
    }
  }
}

// =============================================================================
// UI ELEMENT ANIMATIONS
// =============================================================================

/**
 * Fade in/out for buttons and indicators
 */
export const fadeVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } }
}

/**
 * Slide in from edge
 */
export const slideInVariants = {
  left: {
    initial: { x: -20, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: -20, opacity: 0 }
  },
  right: {
    initial: { x: 20, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: 20, opacity: 0 }
  }
}
