/**
 * Built-in note templates.
 *
 * A leaf module on purpose: templates.ts and templates-migration.ts both need
 * this array, and importing it from templates.ts would close an import cycle
 * (vault/index -> templates-migration -> templates -> ... -> vault/index) that
 * leaves the array undefined at module-init time.
 *
 * @module vault/built-in-templates
 */

import type { Template } from '@memry/contracts/templates-api'

export const BUILT_IN_TEMPLATES: Omit<Template, 'createdAt' | 'modifiedAt'>[] = [
  {
    id: 'blank',
    name: 'Blank Note',
    description: 'Start with an empty note',
    icon: '📄',
    isBuiltIn: true,
    tags: [],
    properties: [],
    content: ''
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    description: 'Meeting agenda and notes template',
    icon: '📝',
    isBuiltIn: true,
    tags: ['meeting'],
    properties: [
      { name: 'date', type: 'date', value: null },
      { name: 'attendees', type: 'text', value: '' },
      {
        name: 'status',
        type: 'select',
        value: 'scheduled',
        options: ['scheduled', 'completed', 'cancelled']
      }
    ],
    content: `## Attendees

-

## Agenda

1.
2.
3.

## Notes

## Action Items

- [ ]
`
  },
  {
    id: 'project-brief',
    name: 'Project Brief',
    description: 'Template for project documentation',
    icon: '📋',
    isBuiltIn: true,
    tags: ['project'],
    properties: [
      {
        name: 'status',
        type: 'select',
        value: 'planning',
        options: ['planning', 'active', 'on-hold', 'completed']
      },
      { name: 'priority', type: 'rating', value: 3 },
      { name: 'startDate', type: 'date', value: null },
      { name: 'dueDate', type: 'date', value: null }
    ],
    content: `## Overview

Brief description of the project...

## Goals

-
-

## Scope

### In Scope

-

### Out of Scope

-

## Timeline

## Notes

`
  },
  {
    id: 'daily-standup',
    name: 'Daily Standup',
    description: 'Daily standup format',
    icon: '✅',
    isBuiltIn: true,
    tags: ['standup', 'daily'],
    properties: [{ name: 'date', type: 'date', value: null }],
    content: `## What I did yesterday

-

## What I'm doing today

-

## Blockers

-
`
  },
  // ===========================================================================
  // Journal Templates
  // ===========================================================================
  {
    id: 'morning-pages',
    name: 'Morning Pages',
    description: 'Stream of consciousness writing to start your day',
    icon: '🌅',
    isBuiltIn: true,
    tags: ['morning', 'reflection'],
    properties: [
      {
        name: 'mood',
        type: 'select',
        value: 'neutral',
        options: ['great', 'good', 'neutral', 'low', 'difficult']
      }
    ],
    content: `# Morning Pages

Write freely for the next few minutes. Don't worry about grammar, spelling, or making sense. Just let your thoughts flow...

---

`
  },
  {
    id: 'daily-reflection',
    name: 'Daily Reflection',
    description: 'End-of-day reflection and gratitude',
    icon: '🌆',
    isBuiltIn: true,
    tags: ['reflection', 'gratitude'],
    properties: [
      {
        name: 'mood',
        type: 'select',
        value: 'neutral',
        options: ['great', 'good', 'neutral', 'low', 'difficult']
      },
      { name: 'energy', type: 'rating', value: 3 }
    ],
    content: `# Daily Reflection

## What went well today?

-

## What could have gone better?

-

## What am I grateful for?

1.
2.
3.

## What did I learn?

`
  },
  {
    id: 'gratitude-journal',
    name: 'Gratitude Journal',
    description: 'Focus on what you appreciate',
    icon: '🙏',
    isBuiltIn: true,
    tags: ['gratitude'],
    properties: [],
    content: `# Gratitude

Today I am grateful for:

1.
2.
3.
4.
5.

---

*One moment that made me smile:*

`
  },
  {
    id: 'weekly-review',
    name: 'Weekly Review',
    description: 'Reflect on your week and plan ahead',
    icon: '📅',
    isBuiltIn: true,
    tags: ['weekly', 'review', 'planning'],
    properties: [{ name: 'weekNumber', type: 'number', value: 0 }],
    content: `# Weekly Review

## Wins This Week

-

## Challenges Faced

-

## Lessons Learned

-

## Next Week's Focus

1.
2.
3.

## Energy & Wellbeing Check

How do I feel about this week overall?

`
  }
]

/**
 * Ids reserved by built-ins. Derived once here so the CRUD guard, the legacy
 * import and the sync handler cannot drift apart on what counts as built-in.
 */
export const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_TEMPLATES.map((t) => t.id))
