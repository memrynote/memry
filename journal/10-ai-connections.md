# Memry Journal — AI Connections Panel

## Overview

Build the AI Connections panel for the right sidebar. This component displays real-time semantic matches to related past journal entries and notes based on what the user is currently writing. It helps surface relevant context and creates serendipitous discovery moments.

## Panel Placement
```
┌───────────────────────────────────────┐
│                                       │
│           RIGHT SIDEBAR               │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      📅 Calendar Heatmap      │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │                               │   │
│   │      ⚡ AI Connections        │   │  ← This component
│   │                               │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      📝 Today's Notes         │   │
│   └───────────────────────────────┘   │
│                                       │
└───────────────────────────────────────┘
```

## Panel States

### Loading State (Initial/Analyzing)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                                │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                    ◠ ◡ ◠                            │
│                                                     │
│              Analyzing your entry...                │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

Elements:
- Animated spinner or pulsing dots
- "Analyzing your entry..." text
- Subtle, non-intrusive
```

### Empty State (No Matches)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                                │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                      🔮                             │
│                                                     │
│            No connections found yet                 │
│                                                     │
│         Keep writing to discover related           │
│              entries and notes                      │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

Elements:
- Decorative icon (🔮, 🔗, or custom)
- Primary message: "No connections found yet"
- Secondary hint: "Keep writing to discover..."
- Encouraging, not discouraging
```

### Empty State (New User / No History)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                                │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                      ✨                             │
│                                                     │
│           Your connections will appear             │
│                    here                             │
│                                                     │
│         As you journal more, AI will find          │
│           related entries automatically            │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

For new users with no past entries
Explains the feature purpose
```

### With Connections (Active State)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                          (4)   │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   📓  Nov 15, 2024                           │ │
│   │       "Also discussed Project Alpha          │ │
│   │        timeline with the team..."            │ │
│   │                                     92%  →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   📄  Meeting Notes - Q3 Planning            │ │
│   │       "Key decisions about resource          │ │
│   │        allocation and hiring..."             │ │
│   │                                     87%  →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   📓  Oct 28, 2024                           │ │
│   │       "Feeling optimistic about the          │ │
│   │        project direction..."                 │ │
│   │                                     78%  →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐ │
│   ╎                                               ╎ │
│   ╎   + 1 more connection                         ╎ │
│   ╎                                               ╎ │
│   └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Connection Item Structure

### Journal Entry Connection
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   📓  Nov 15, 2024                                   │
│       "Also discussed Project Alpha                  │
│        timeline with the team..."                    │
│                                             92%  →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Layout breakdown:
┌───────────────────────────────────────────────────────┐
│  [ICON]  [DATE/TITLE]                                │
│          [PREVIEW SNIPPET - 2 lines max]             │
│                                    [SCORE]  [ARROW]  │
└───────────────────────────────────────────────────────┘

Elements:
- Icon: 📓 (journal) or 📔 (notebook emoji)
- Date: "Nov 15, 2024" - formatted date
- Preview: First ~80 chars of matching content
- Score: "92%" - semantic similarity score
- Arrow: → indicates clickable
```

### Note Connection
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   📄  Meeting Notes - Q3 Planning                    │
│       "Key decisions about resource                  │
│        allocation and hiring..."                     │
│                                             87%  →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Layout breakdown:
┌───────────────────────────────────────────────────────┐
│  [ICON]  [NOTE TITLE]                                │
│          [PREVIEW SNIPPET - 2 lines max]             │
│                                    [SCORE]  [ARROW]  │
└───────────────────────────────────────────────────────┘

Elements:
- Icon: 📄 (document/note)
- Title: Note title (truncated if long)
- Preview: First ~80 chars of content
- Score: "87%" - semantic similarity
- Arrow: → indicates clickable
```

### Connection Types
```
TYPE 1: Journal Entry (past days)
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024                                   │
│       "Preview of journal content..."                │
│                                             92%  →   │
└───────────────────────────────────────────────────────┘
Icon: 📓
Identifier: Date


TYPE 2: Note
┌───────────────────────────────────────────────────────┐
│   📄  Meeting Notes - Q3 Planning                    │
│       "Preview of note content..."                   │
│                                             87%  →   │
└───────────────────────────────────────────────────────┘
Icon: 📄
Identifier: Note title


TYPE 3: Wiki-linked Page (if exists as feature)
┌───────────────────────────────────────────────────────┐
│   📑  Project Alpha                                  │
│       "Main project page with details               │
│        about timeline and goals..."                  │
│                                             85%  →   │
└───────────────────────────────────────────────────────┘
Icon: 📑 or 🔗
Identifier: Page title
```

## Similarity Score Display

### Score Badge Options
```
Option A: Percentage
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024                                   │
│       "Preview text..."                              │
│                                             92%  →   │
└───────────────────────────────────────────────────────┘

Simple, clear, quantitative


Option B: Visual bar
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024                                   │
│       "Preview text..."                              │
│                                    ████████░░    →   │
└───────────────────────────────────────────────────────┘

Visual representation of strength


Option C: Dots/circles
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024                                   │
│       "Preview text..."                              │
│                                       ●●●●○      →   │
└───────────────────────────────────────────────────────┘

5-dot scale (4/5 filled = 80%+)


Option D: Color intensity (no number)
┌───────────────────────────────────────────────────────┐
│  ┃  📓  Nov 15, 2024                                 │
│  ┃      "Preview text..."                            │
│  ┃                                               →   │
└───────────────────────────────────────────────────────┘
   ↑
   Left border color intensity indicates strength

Recommendation: Option A (percentage) or Option D (color)
Percentage is clearest; color is subtlest
```

### Score Thresholds
```
Score Range     │  Display    │  Color
────────────────┼─────────────┼────────────
90% - 100%      │  Strong     │  Deep accent color
75% - 89%       │  Good       │  Medium accent
60% - 74%       │  Related    │  Light accent
Below 60%       │  (hidden)   │  Don't show

Only show connections above 60% threshold
Ordered by score (highest first)
```

## Interaction States

### Normal State
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   📓  Nov 15, 2024                                   │
│       "Also discussed Project Alpha..."              │
│                                             92%  →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Properties:
- Background: Transparent or subtle card bg
- Border: Subtle or none
- Cursor: Pointer
```

### Hover State
```
┌───────────────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒                                                     ▒│
│▒  📓  Nov 15, 2024                                   ▒│
│▒      "Also discussed Project Alpha..."              ▒│
│▒                                            92%  →   ▒│
│▒                                                     ▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└───────────────────────────────────────────────────────┘

Properties:
- Background: Subtle highlight
- Arrow: More prominent
- Transition: 150ms ease
```

### Click Behavior
```
Click on Journal Entry connection:
→ Scrolls main area to that date's journal entry
→ If different month, loads that month
→ Highlights the connected entry briefly

Click on Note connection:
→ Opens note in split view panel (see Prompt 06)
→ Panel slides in from right
→ Note content displayed for reading/editing
```

## Real-Time Updates

### Trigger Conditions
```
When to analyze/update connections:

1. INITIAL LOAD
   - When day card becomes active
   - Fetch connections for existing content

2. TYPING (Debounced)
   - After 2 seconds of no typing
   - Don't analyze on every keystroke
   - Show loading indicator briefly

3. SIGNIFICANT CHANGE
   - When content length changes by >50 chars
   - When new paragraph added
   - When [[wiki-link]] or #tag added

4. MANUAL REFRESH
   - Optional: Refresh button in panel header
   - User can force re-analysis
```

### Update Animation
```
When connections update:

STEP 1: Current items fade slightly
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024              (fading 50%)         │
│       "Also discussed..."                            │
│                                             92%  →   │
└───────────────────────────────────────────────────────┘

STEP 2: New/changed items animate in
┌───────────────────────────────────────────────────────┐
│   📓  Nov 15, 2024              (sliding in)         │
│       "Also discussed..."                            │
│                                             94%  →   │  ← Score updated
└───────────────────────────────────────────────────────┘

Animation:
- Existing items: crossfade (200ms)
- New items: slide in from top (200ms)
- Removed items: slide out, collapse (200ms)
- Score changes: number transition
```

### Loading Indicator (During Update)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                      ◠◡◠  (4)  │
│                                           ↑         │
│   ─────────────────────────────────────────────────│
│                                           │         │
│   [Existing connections still visible]    │         │
│                                           │         │
└───────────────────────────────────────────┴─────────┘
                                            │
                                Small loading spinner
                                while analyzing

Don't replace content with loading state
Show spinner in header instead
Keep existing connections visible
```

## Panel Header

### Standard Header
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                          (4)   │
│                                                     │
└─────────────────────────────────────────────────────┘

Elements:
- Icon: ⚡ (lightning) or 🔮 (crystal ball) or 🧠 (brain)
- Title: "AI Connections"
- Count badge: (4) - number of connections shown
```

### Header with Refresh
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                     ↻    (4)   │
│                                         ↑           │
└─────────────────────────────────────────┴───────────┘
                                          │
                                    Refresh button
                                    (optional)

Refresh button:
- Click to force re-analysis
- Rotates while loading
- Tooltip: "Refresh connections"
```

### Header States
```
NORMAL:
┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                          (4)   │
└─────────────────────────────────────────────────────┘

LOADING:
┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                      ◠◡◠  (4)  │
└─────────────────────────────────────────────────────┘

ERROR:
┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                      ⚠️        │
└─────────────────────────────────────────────────────┘
Click ⚠️ to retry or see error message
```

## Expanded Connection View (Hover/Focus)

### Tooltip/Popover on Hover
```
                                    ┌─────────────────────────────────────┐
                                    │                                     │
                                    │  📓 November 15, 2024               │
┌─────────────────────────────────┐ │  ─────────────────────────────────  │
│   📓  Nov 15, 2024              │ │                                     │
│       "Also discussed..."       │─┤  "Also discussed Project Alpha     │
│                         92%  →  │ │   timeline with the team today.    │
└─────────────────────────────────┘ │   Sarah mentioned concerns about   │
                                    │   Q2 deadlines that we need to     │
                                    │   address in the next sprint..."   │
                                    │                                     │
                                    │  ─────────────────────────────────  │
                                    │  Matched: "Project Alpha", "team",  │
                                    │           "timeline"                │
                                    │                                     │
                                    │  [Open Entry]                       │
                                    │                                     │
                                    └─────────────────────────────────────┘

Popover content:
- Full date
- Longer preview (3-4 lines)
- Matched keywords highlighted
- Action button to open
- Shows after 500ms hover delay
```

## Highlighted Keywords

### In Preview Text
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   📓  Nov 15, 2024                                   │
│       "Also discussed [Project Alpha]                │
│        [timeline] with the [team]..."                │
│                                             92%  →   │
│                                                       │
└───────────────────────────────────────────────────────┘

[bracketed] = highlighted/bold keywords
Keywords that matched with current entry
Helps user understand why it's connected
```

### Highlight Styling
```
Normal text: "Also discussed"
Highlighted: "Project Alpha"  ← Bold or background highlight

Options:
A. Bold text: "Also discussed **Project Alpha**..."
B. Background: "Also discussed [Project Alpha]..."
C. Underline: "Also discussed Project Alpha..."
              └─────────────────────────────┘

Recommendation: Bold (option A) - clearest
```

## Overflow Handling

### Max Visible Items
```
Show maximum 3-4 connections by default:

┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                          (6)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Connection 1 - 92%]                              │
│                                                     │
│   [Connection 2 - 87%]                              │
│                                                     │
│   [Connection 3 - 78%]                              │
│                                                     │
│   ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐ │
│   ╎                                               ╎ │
│   ╎   + 3 more connections                        ╎ │
│   ╎                                               ╎ │
│   └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘ │
│                                                     │
└─────────────────────────────────────────────────────┘

"+ X more connections" button
Click to expand and show all
```

### Expanded View
```
After clicking "+ 3 more connections":

┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                          (6)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Connection 1 - 92%]                              │
│                                                     │
│   [Connection 2 - 87%]                              │
│                                                     │
│   [Connection 3 - 78%]                              │
│                                                     │
│   [Connection 4 - 72%]                              │
│                                                     │
│   [Connection 5 - 68%]                              │
│                                                     │
│   [Connection 6 - 65%]                              │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   Show less ⌃                                       │
│                                                     │
└─────────────────────────────────────────────────────┘

"Show less" collapses back to 3 items
```

## Scrollable Content (Alternative)
```
Instead of expand/collapse, make panel scrollable:

┌─────────────────────────────────────────────────────┐
│   ⚡  AI Connections                          (6)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  [Connection 1 - 92%]                         │ │
│   │                                               │ │
│   │  [Connection 2 - 87%]                         │ │
│   │                                               │▲│
│   │  [Connection 3 - 78%]                         │█│
│   │                                               │█│
│   │  [Connection 4 - 72%]                         │▼│
│   └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘

Max-height: 300px
Overflow-y: auto
Subtle scrollbar
```

## Data Structure
```typescript
interface AIConnection {
  id: string;
  type: 'journal' | 'note' | 'page';

  // For journal entries
  date?: string;              // "2024-11-15"

  // For notes/pages
  title?: string;             // "Meeting Notes - Q3 Planning"

  // Common
  preview: string;            // First ~100 chars
  score: number;              // 0.0 - 1.0 (displayed as percentage)
  matchedKeywords: string[];  // ["Project Alpha", "timeline", "team"]

  // Navigation
  targetId: string;           // ID to navigate to
  targetType: 'scroll' | 'panel';  // How to open
}

interface AIConnectionsState {
  connections: AIConnection[];
  isLoading: boolean;
  error: string | null;
  lastAnalyzedContent: string;  // To detect changes
  isExpanded: boolean;          // Show all vs show 3
}
```

## API Integration

### Request Structure
```typescript
// Debounced function called on content change
async function analyzeConnections(content: string): Promise {
  // Don't analyze if content too short
  if (content.length < 50) return [];

  const response = await fetch('/api/ai/connections', {
    method: 'POST',
    body: JSON.stringify({
      content: content,
      currentDate: '2024-12-09',
      limit: 10,
      minScore: 0.6
    })
  });

  return response.json();
}

// Debounce wrapper
const debouncedAnalyze = debounce(analyzeConnections, 2000);
```

### Response Structure
```typescript
// API Response
{
  connections: [
    {
      id: "journal-2024-11-15",
      type: "journal",
      date: "2024-11-15",
      preview: "Also discussed Project Alpha timeline with the team...",
      score: 0.92,
      matchedKeywords: ["Project Alpha", "timeline", "team"]
    },
    {
      id: "note-abc123",
      type: "note",
      title: "Meeting Notes - Q3 Planning",
      preview: "Key decisions about resource allocation and hiring...",
      score: 0.87,
      matchedKeywords: ["decisions", "hiring", "Q3"]
    }
  ],
  analyzedAt: "2024-12-09T14:32:00Z"
}
```

## Component Structure
```
AIConnectionsPanel
├── PanelHeader
│   ├── Icon (⚡)
│   ├── Title ("AI Connections")
│   ├── LoadingSpinner (conditional)
│   ├── RefreshButton (optional)
│   └── CountBadge
│
├── Separator
│
├── ConnectionsList (if connections.length > 0)
│   ├── ConnectionItem (×n, max 3 initially)
│   │   ├── TypeIcon (📓 or 📄)
│   │   ├── DateOrTitle
│   │   ├── Preview (with highlights)
│   │   ├── ScoreBadge
│   │   └── Arrow
│   │
│   └── ExpandButton (if more than 3)
│       └── "+ X more connections"
│
├── EmptyState (if connections.length === 0 && !isLoading)
│   ├── Icon
│   ├── Message
│   └── Hint
│
└── LoadingState (if isLoading && connections.length === 0)
    ├── Spinner
    └── Message
```

## Spacing Specifications
```
Panel Container:
├── Padding: 16px
├── Background: Subtle card background
├── Border-radius: 12px
├── Margin-top: 16px (gap from calendar)
│
├── Header
│   ├── Margin-bottom: 12px
│   ├── Icon size: 18px
│   ├── Title font: 14px, 500 weight
│   ├── Count badge: 13px, secondary
│   └── Loading spinner: 14px
│
├── Separator
│   ├── Height: 1px
│   └── Margin-bottom: 12px
│
├── Connection Items
│   ├── Padding: 12px
│   ├── Margin-bottom: 8px
│   ├── Border-radius: 8px
│   │
│   ├── Icon size: 16px
│   ├── Date/Title font: 13px, 500 weight
│   ├── Preview font: 12px, secondary
│   ├── Score font: 11px, accent color
│   └── Arrow: 14px
│
└── Expand Button
    ├── Padding: 8px 12px
    ├── Font: 13px
    └── Color: Accent/link color
```

## Accessibility
```
Panel:
- role="region"
- aria-label="AI Connections"
- aria-live="polite" (announce updates)

Connection items:
- role="button" (clickable)
- aria-label="Connection to November 15, 2024 journal entry, 92% match"
- Keyboard navigable (Tab, Enter to activate)

Loading state:
- aria-busy="true"
- Screen reader: "Analyzing connections"

Empty state:
- Informative text readable by screen reader

Count updates:
- Announce: "4 connections found"
```

## Error Handling
```
ERROR STATE:
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⚡  AI Connections                          ⚠️    │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                      ⚠️                             │
│                                                     │
│           Couldn't load connections                 │
│                                                     │
│               [Try Again]                           │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

Error scenarios:
- Network failure
- API timeout
- Server error

Behavior:
- Show error message
- Provide retry button
- Don't block other functionality
```

## Performance Considerations
```
OPTIMIZATION STRATEGIES:

1. Debounce analysis
   - Wait 2 seconds after typing stops
   - Don't analyze on every keystroke

2. Cache results
   - Store connections in component state
   - Only re-fetch on significant changes

3. Detect meaningful changes
   - Compare content length
   - Check for new wiki-links/tags
   - Don't re-analyze for typo fixes

4. Limit API calls
   - Max 1 request per 5 seconds
   - Queue requests if needed

5. Background processing
   - Don't block UI while analyzing
   - Show existing connections during update

6. Lazy loading
   - Only load if panel is visible
   - Defer initial load slightly
```

## Integration with Editor
```typescript
// In JournalEditor component
const [connections, setConnections] = useState([]);
const [isAnalyzing, setIsAnalyzing] = useState(false);

// Debounced analysis
const analyzeContent = useDebouncedCallback(
  async (content: string) => {
    if (content.length < 50) {
      setConnections([]);
      return;
    }

    setIsAnalyzing(true);
    try {
      const results = await fetchConnections(content);
      setConnections(results);
    } catch (error) {
      console.error('Connection analysis failed:', error);
    } finally {
      setIsAnalyzing(false);
    }
  },
  2000  // 2 second debounce
);

// Trigger on content change
useEffect(() => {
  analyzeContent(editorContent);
}, [editorContent]);

// Pass to sidebar

```

## Expected Output

After implementing this prompt:
1. Panel displays in sidebar below calendar
2. Shows loading state during analysis
3. Shows empty state when no matches
4. Displays connection items with score
5. Differentiates journal entries vs notes
6. Highlights matched keywords in preview
7. Click navigates to connected content
8. Updates in real-time as user types (debounced)
9. Handles overflow with expand/collapse
10. Shows error state with retry option
11. Proper loading indicators
12. Accessible with keyboard and screen reader

## Do Not Include Yet

- Actual AI/embedding implementation (backend)
- Graph view of connections
- Connection filtering by type
- "Why connected" detailed explanation

Focus on UI component and mock data flow.

Implementation Notes
TechniqueWhyDebouncePrevent excessive API callsOptimistic UIKeep showing old results while loadingaria-liveAnnounce connection updatesIntersection ObserverOnly analyze when visibleContent hashingDetect meaningful changes
Expected Outcome
After implementing this prompt, you should have:

Working AI connections panel UI
Loading, empty, and populated states
Clickable connection items
Real-time updates (debounced)
Smooth animations for updates
Expand/collapse for overflow
Error handling with retry