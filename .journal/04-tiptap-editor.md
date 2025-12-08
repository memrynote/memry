# 04 - Tiptap Rich Text Editor Integration

## Context

We now have:
- DayCard component with textarea placeholder
- JournalTimeline with fade-to-focus scroll effect
- Storage utilities for saving entries

Now we replace the basic textarea with a **Tiptap rich text editor** that supports:
- Basic formatting (bold, italic, underline, strikethrough)
- Links
- Bullet and numbered lists
- Task lists (checkboxes)
- Placeholder text
- Auto-save functionality
- Timestamps for individual notes within a day

## Objective

Create a `JournalEditor` component using Tiptap that provides a beautiful, functional rich text editing experience. This editor will be used in the DayCard for today's entry, and in read-only mode for viewing past entries.

## Requirements

### Component File

Create `src/renderer/src/components/journal/JournalEditor.tsx`

### Dependencies (Already Installed)

These should already be installed from prompt 01:
- `@tiptap/react`
- `@tiptap/starter-kit`
- `@tiptap/extension-placeholder`
- `@tiptap/extension-link`
- `@tiptap/extension-task-list`
- `@tiptap/extension-task-item`

### Props Interface

```typescript
interface JournalEditorProps {
  date: string; // ISO date (YYYY-MM-DD)
  initialContent?: string; // Initial HTML or JSON content
  editable?: boolean; // False for past days (read-only)
  placeholder?: string;
  onSave?: (content: string) => void;
  onUpdate?: (content: string) => void; // Called on every change
  className?: string;
}
```

### Tiptap Extensions to Use

```typescript
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';

const extensions = [
  StarterKit.configure({
    heading: {
      levels: [1, 2, 3]
    },
    bulletList: {
      keepMarks: true,
      keepAttributes: false
    },
    orderedList: {
      keepMarks: true,
      keepAttributes: false
    }
  }),
  Placeholder.configure({
    placeholder: 'Start writing...'
  }),
  Link.configure({
    openOnClick: false,
    HTMLAttributes: {
      class: 'text-primary underline cursor-pointer'
    }
  }),
  TaskList,
  TaskItem.configure({
    nested: true
  })
];
```

### Auto-Save Functionality

Implement auto-save with debouncing:

```typescript
import { useEffect, useRef } from 'react';
import { Editor } from '@tiptap/react';

const AUTO_SAVE_DELAY = 1500; // 1.5 seconds after typing stops

function useAutoSave(editor: Editor | null, onSave: (content: string) => void) {
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!editor) return;

    const handleUpdate = () => {
      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Set new timeout
      timeoutRef.current = setTimeout(() => {
        const html = editor.getHTML();
        onSave(html);
      }, AUTO_SAVE_DELAY);
    };

    editor.on('update', handleUpdate);

    return () => {
      editor.off('update', handleUpdate);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [editor, onSave]);
}
```

### Formatting Toolbar

Create a minimal, elegant toolbar with common formatting options:

```typescript
interface EditorToolbarProps {
  editor: Editor | null;
}

function EditorToolbar({ editor }: EditorToolbarProps) {
  if (!editor) return null;

  return (
    <div className="flex flex-wrap gap-1 rounded-t-lg border border-b-0 border-border bg-muted/30 p-2">
      {/* Bold */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="Bold (Cmd+B)"
      >
        <BoldIcon />
      </ToolbarButton>

      {/* Italic */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="Italic (Cmd+I)"
      >
        <ItalicIcon />
      </ToolbarButton>

      {/* Strikethrough */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="Strikethrough"
      >
        <StrikethroughIcon />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" /> {/* Separator */}

      {/* Bullet List */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="Bullet List"
      >
        <ListIcon />
      </ToolbarButton>

      {/* Numbered List */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="Numbered List"
      >
        <OrderedListIcon />
      </ToolbarButton>

      {/* Task List */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive('taskList')}
        title="Task List"
      >
        <CheckSquareIcon />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" /> {/* Separator */}

      {/* Link */}
      <ToolbarButton
        onClick={() => {
          const url = window.prompt('Enter URL:');
          if (url) {
            editor.chain().focus().setLink({ href: url }).run();
          }
        }}
        active={editor.isActive('link')}
        title="Add Link"
      >
        <LinkIcon />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  onClick,
  active,
  title,
  children
}: {
  onClick: () => void;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'rounded p-2 transition-colors hover:bg-accent',
        active && 'bg-accent text-accent-foreground'
      )}
      type="button"
    >
      {children}
    </button>
  );
}
```

### Icon Components (Simple SVGs)

```typescript
function BoldIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z" />
    </svg>
  );
}

function ItalicIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 4h4m-4 16h4M12 4l-4 16" />
    </svg>
  );
}

// Add similar icons for: Strikethrough, List, OrderedList, CheckSquare, Link
```

### Main Editor Component

```typescript
import React, { useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { cn } from '@/lib/utils';

export function JournalEditor({
  date,
  initialContent,
  editable = true,
  placeholder = 'Start writing...',
  onSave,
  onUpdate,
  className
}: JournalEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline cursor-pointer hover:text-primary/80'
        }
      }),
      TaskList,
      TaskItem.configure({ nested: true })
    ],
    content: initialContent || '',
    editable,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm max-w-none focus:outline-none',
          'prose-headings:font-semibold',
          'prose-p:text-foreground',
          'prose-a:text-primary',
          'prose-strong:text-foreground',
          'prose-ul:text-foreground',
          'prose-ol:text-foreground',
          'min-h-[200px] px-4 py-3'
        )
      }
    }
  });

  // Auto-save hook
  useAutoSave(editor, useCallback((content: string) => {
    if (onSave) {
      onSave(content);
    }
  }, [onSave]));

  if (!editor) {
    return <div className="animate-pulse rounded-lg bg-muted p-8">Loading editor...</div>;
  }

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-background', className)}>
      {editable && <EditorToolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className={cn(
          editable ? 'border-t-0' : '',
          !editable && 'cursor-default'
        )}
      />
    </div>
  );
}
```

### Integration with Storage

Create a hook to manage saving editor content:

Create `src/renderer/src/lib/hooks/useJournalEntry.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { getEntryByDate, saveEntry } from '@/lib/journal/storage';
import { toISODate } from '@/lib/journal/date-utils';
import type { JournalEntry, JournalNote } from '@/lib/journal/types';
import { v4 as uuidv4 } from 'uuid'; // Install: pnpm add uuid @types/uuid

export function useJournalEntry(date: Date) {
  const dateStr = toISODate(date);
  const [entry, setEntry] = useState<JournalEntry | null>(() => getEntryByDate(dateStr));

  const handleSave = useCallback((content: string) => {
    const now = new Date();

    if (!entry) {
      // Create new entry
      const newNote: JournalNote = {
        id: uuidv4(),
        timestamp: now,
        content,
        preview: content.replace(/<[^>]*>/g, '').slice(0, 100) // Strip HTML for preview
      };

      const newEntry: JournalEntry = {
        id: uuidv4(),
        date: dateStr,
        notes: [newNote],
        wordCount: content.split(/\s+/).length,
        createdAt: now,
        lastModifiedAt: now
      };

      saveEntry(newEntry);
      setEntry(newEntry);
    } else {
      // Update existing entry
      const updatedNote: JournalNote = {
        id: entry.notes[0]?.id || uuidv4(),
        timestamp: entry.notes[0]?.timestamp || now,
        content,
        preview: content.replace(/<[^>]*>/g, '').slice(0, 100)
      };

      const updatedEntry: JournalEntry = {
        ...entry,
        notes: [updatedNote],
        wordCount: content.split(/\s+/).length,
        lastModifiedAt: now
      };

      saveEntry(updatedEntry);
      setEntry(updatedEntry);
    }
  }, [entry, dateStr]);

  return { entry, handleSave };
}
```

### Update DayCard to Use JournalEditor

Modify `DayCard.tsx` to replace textarea with JournalEditor:

```typescript
import { JournalEditor } from './JournalEditor';
import { useJournalEntry } from '@/lib/hooks/useJournalEntry';

// Inside DayCard component, for Today's card:
const { entry, handleSave } = useJournalEntry(date);

{isToday && (
  <JournalEditor
    date={toISODate(date)}
    initialContent={entry?.notes[0]?.content || ''}
    editable={true}
    placeholder="What's on your mind today?"
    onSave={handleSave}
  />
)}

// For past days in read-only mode:
{isPast && entry && (
  <JournalEditor
    date={toISODate(date)}
    initialContent={entry.notes[0]?.content || ''}
    editable={false}
  />
)}
```

## Technical Constraints

- MUST use Tiptap extensions from `@tiptap/react`
- MUST implement auto-save with 1.5s debounce
- MUST use `prose` class for styling editor content
- DO NOT use `uuid` package - use `crypto.randomUUID()` instead for IDs
- Toolbar MUST be horizontal with icon buttons
- MUST support keyboard shortcuts (Cmd+B, Cmd+I, etc.)
- Read-only mode MUST hide toolbar and disable editing

## Acceptance Criteria

- [ ] JournalEditor component renders without errors
- [ ] Toolbar shows all formatting buttons
- [ ] Bold, italic, strikethrough work correctly
- [ ] Bullet lists, numbered lists, task lists work
- [ ] Link insertion via prompt works
- [ ] Placeholder text shows when editor is empty
- [ ] Auto-save fires 1.5 seconds after typing stops
- [ ] Content persists in localStorage
- [ ] Read-only mode hides toolbar and prevents editing
- [ ] Editor styling matches app theme (prose classes)
- [ ] Keyboard shortcuts work (Cmd+B, Cmd+I)
- [ ] Today's card shows editable editor
- [ ] Past cards show read-only editor

## Styling Notes

### Custom Prose Styles

Add to your Tailwind config or global CSS if needed:

```css
/* Make sure prose styling matches your theme */
.prose {
  color: hsl(var(--foreground));
}

.prose h1, .prose h2, .prose h3 {
  color: hsl(var(--foreground));
}

.prose a {
  color: hsl(var(--primary));
}

.prose strong {
  color: hsl(var(--foreground));
  font-weight: 600;
}

.prose ul[data-type="taskList"] {
  list-style: none;
  padding: 0;
}

.prose ul[data-type="taskList"] li {
  display: flex;
  align-items: flex-start;
}

.prose ul[data-type="taskList"] li > label {
  margin-right: 0.5rem;
}
```

## Visual Reference

```
┌────────────────────────────────────────────────────────┐
│ [B] [I] [S] | [•] [1.] [☐] | [🔗]                     │ ← Toolbar
├────────────────────────────────────────────────────────┤
│                                                        │
│  # Meeting Notes                                       │
│                                                        │
│  Had a great discussion about:                         │
│  • Project timeline                                    │
│  • Budget allocation                                   │
│  • Team assignments                                    │
│                                                        │
│  Tasks:                                                │
│  ☐ Follow up with Sarah                               │
│  ☑ Send meeting summary                               │
│                                                        │
│  Link: https://example.com                             │
│                                                        │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## Testing Instructions

1. Navigate to today's card
2. Click in editor and start typing
3. Verify auto-save after 1.5s
4. Refresh page - content should persist
5. Test all toolbar buttons
6. Try keyboard shortcuts
7. View past day - editor should be read-only

## Performance Considerations

- Debounce auto-save to avoid excessive localStorage writes
- Use `crypto.randomUUID()` for IDs (built-in, no package needed)
- Consider lazy-loading Tiptap extensions if bundle size is an issue

## Next Steps

After completing the editor integration, proceed to `05-calendar-heatmap.md` to build the activity visualization calendar.
