/**
 * AI Connections Service (Mock Implementation)
 *
 * Simulates AI-powered semantic search to find related journal entries and notes.
 * Returns static mock data after a simulated 2-second delay.
 *
 * This is a placeholder for the real AI integration in phase 006-ai.
 *
 * @module services/ai-connections-service
 */

import type { AIConnection } from '@/components/journal/ai-connections-panel'

// =============================================================================
// Constants
// =============================================================================

/** Minimum content length required to trigger AI analysis */
export const MIN_CONTENT_LENGTH = 50

/** Simulated delay for AI analysis in milliseconds */
const AI_ANALYSIS_DELAY_MS = 2000

// =============================================================================
// Mock Data
// =============================================================================

/**
 * Static mock connections that simulate AI-suggested related content.
 * In the real implementation, these would be computed based on semantic similarity.
 */
const MOCK_CONNECTIONS: AIConnection[] = [
  {
    id: 'ai-conn-1',
    type: 'journal',
    date: 'Nov 15, 2024',
    preview:
      'Also discussed Project Alpha timeline with the team today. Sarah mentioned concerns about the deadline...',
    score: 0.92,
    matchedKeywords: ['project', 'team', 'timeline']
  },
  {
    id: 'ai-conn-2',
    type: 'note',
    title: 'Meeting Notes - Q3 Planning',
    preview:
      'Key decisions about resource allocation and hiring plans for the next quarter. Need to follow up on budget...',
    score: 0.87,
    matchedKeywords: ['planning', 'decisions', 'quarter']
  },
  {
    id: 'ai-conn-3',
    type: 'journal',
    date: 'Oct 28, 2024',
    preview:
      "Feeling optimistic about the project direction after today's review session. The team is aligned on goals...",
    score: 0.78,
    matchedKeywords: ['project', 'review', 'goals']
  },
  {
    id: 'ai-conn-4',
    type: 'note',
    title: 'Personal Goals 2024',
    preview:
      'Focus areas for this year: deep work, health habits, and learning new skills. Weekly review is essential...',
    score: 0.71,
    matchedKeywords: ['goals', 'focus', 'review']
  },
  {
    id: 'ai-conn-5',
    type: 'journal',
    date: 'Sep 12, 2024',
    preview:
      'Started the morning with a gratitude practice. Three things I am grateful for today: supportive colleagues...',
    score: 0.65,
    matchedKeywords: ['gratitude', 'morning', 'practice']
  }
]

// =============================================================================
// Service Functions
// =============================================================================

/**
 * Get AI-suggested connections based on journal content.
 *
 * This mock implementation:
 * - Returns empty array immediately if content is too short
 * - Simulates a 2-second AI analysis delay
 * - Returns static mock connections regardless of content
 *
 * @param content - The journal entry content to analyze
 * @param signal - Optional AbortSignal to cancel the request
 * @returns Promise resolving to array of AI connections
 */
export async function getAIConnections(
  content: string,
  signal?: AbortSignal
): Promise<AIConnection[]> {
  // Skip analysis for short content
  if (content.length < MIN_CONTENT_LENGTH) {
    return []
  }

  // Simulate AI analysis delay
  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(resolve, AI_ANALYSIS_DELAY_MS)

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }
  })

  // Check if aborted after delay
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  // Return mock connections (in real implementation, this would be based on content similarity)
  return MOCK_CONNECTIONS
}

/**
 * Parse a human-readable date string to ISO format (YYYY-MM-DD).
 *
 * Handles formats like "Nov 15, 2024" or "October 28, 2024".
 *
 * @param dateStr - Human-readable date string
 * @returns ISO date string (YYYY-MM-DD) or null if parsing fails
 */
export function parseConnectionDate(dateStr: string): string | null {
  try {
    // Parse the date string using built-in Date parser
    const parsed = new Date(dateStr)

    // Check if valid
    if (isNaN(parsed.getTime())) {
      return null
    }

    // Format as YYYY-MM-DD
    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
  } catch {
    return null
  }
}
