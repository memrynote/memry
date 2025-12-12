import { useState, useCallback } from 'react'
import { NoteLayout, HeadingItem, ContentArea, HeadingInfo, Block } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, Property, NewProperty } from '@/components/note/info-section'
import { BacklinksSection, Backlink } from '@/components/note/backlinks'

interface NotePageProps {
  noteId?: string
}

// Initial content for the editor (HTML string - will be parsed by BlockNote)
const initialContent = `
<h1>Introduction</h1>
<p>This is a sample note demonstrating the note editor layout. The layout follows a clean, three-zone design inspired by Capacities and other modern PKM applications.</p>
<p>The main content area is centered with a comfortable max-width of 720px, providing optimal reading width while maintaining a clean, paper-like aesthetic.</p>

<h2>Background</h2>
<p>The design philosophy emphasizes progressive disclosure, with advanced features hidden until needed. The warm color palette creates a comfortable reading environment.</p>

<h2>Key Concepts</h2>
<p>The layout is built with three distinct zones, each serving a specific purpose in the note-taking workflow.</p>

<h3>Concept A</h3>
<p>The main content zone provides a distraction-free writing environment with generous padding and a warm background color.</p>

<h3>Concept B</h3>
<p>The outline edge allows quick navigation through document structure, while the right sidebar provides access to AI features and related notes.</p>

<h1>Implementation</h1>
<p>The layout is implemented using modern React patterns with TypeScript, following the existing architectural conventions in the Memry application.</p>

<h2>Setup</h2>
<p>Components are organized in a modular fashion, with clear separation of concerns between layout logic and content rendering.</p>

<h2>Configuration</h2>
<p>The layout supports responsive breakpoints, adapting seamlessly from desktop to tablet and mobile viewports while maintaining usability.</p>

<h1>Conclusion</h1>
<p>This layout shell provides a solid foundation for building a comprehensive note editor with all the features specified in the design document.</p>
`

// Mock tag data for demonstration
const mockAvailableTags: Tag[] = [
  { id: '1', name: 'Important', color: 'red' },
  { id: '2', name: 'Work', color: 'blue' },
  { id: '3', name: 'Personal', color: 'green' },
  { id: '4', name: 'Project', color: 'purple' },
  { id: '5', name: 'Research', color: 'amber' },
  { id: '6', name: 'Ideas', color: 'yellow' },
  { id: '7', name: 'Meeting', color: 'cyan' },
  { id: '8', name: 'Review', color: 'pink' },
  { id: '9', name: 'Urgent', color: 'coral' },
  { id: '10', name: 'Archive', color: 'stone' }
]

const mockRecentTags: Tag[] = [
  { id: '1', name: 'Important', color: 'red' },
  { id: '2', name: 'Work', color: 'blue' },
  { id: '4', name: 'Project', color: 'purple' },
  { id: '5', name: 'Research', color: 'amber' }
]

// Mock backlinks data for demonstration
const mockBacklinks: Backlink[] = [
  {
    id: 'bl-1',
    noteId: 'note-123',
    noteTitle: 'Film Analysis Project',
    folder: 'Projects',
    date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-1',
        snippet:
          "...studying the cinematography of [[The Godfather]] reveals Coppola's masterful use of low-key lighting...",
        linkStart: 32,
        linkEnd: 48
      }
    ]
  },
  {
    id: 'bl-2',
    noteId: 'note-456',
    noteTitle: 'Team Meeting Dec 5',
    folder: 'Meetings',
    date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-2',
        snippet:
          '...decided to use [[The Godfather]] as our case study for the presentation next week...',
        linkStart: 19,
        linkEnd: 35
      }
    ]
  },
  {
    id: 'bl-3',
    noteId: 'note-789',
    noteTitle: 'Classic Cinema Notes',
    folder: 'Research',
    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-3',
        snippet:
          '...alongside Citizen Kane, [[The Godfather]] represents a turning point in American filmmaking...',
        linkStart: 27,
        linkEnd: 43
      },
      {
        id: 'm-4',
        snippet:
          "...the baptism scene in [[The Godfather]] is often cited as one of cinema's greatest...",
        linkStart: 23,
        linkEnd: 39
      }
    ]
  }
]

// Mock properties for demonstration
const mockProperties: Property[] = [
  { id: 'p1', name: 'Director', type: 'text', value: 'Francis Ford Coppola', isCustom: false },
  { id: 'p2', name: 'Year', type: 'number', value: 1972, isCustom: false },
  { id: 'p3', name: 'Rating', type: 'rating', value: 5, isCustom: false },
  { id: 'p4', name: 'Watched', type: 'checkbox', value: true, isCustom: false },
  { id: 'p5', name: 'Status', type: 'select', value: 'Completed', isCustom: false, options: ['Draft', 'In Progress', 'Completed', 'Archived'] },
  { id: 'p6', name: 'IMDB', type: 'url', value: 'https://imdb.com/title/tt0068646', isCustom: true },
  { id: 'p7', name: 'Notes', type: 'longText', value: '', isCustom: true }
]

export function NotePage({ noteId: _noteId }: NotePageProps) {
  // noteId will be used in the future to load specific note data
  const [emoji, setEmoji] = useState<string | null>('📝')
  const [title, setTitle] = useState('Sample Note Title')
  const [tags, setTags] = useState<Tag[]>([
    { id: '1', name: 'Important', color: 'red' },
    { id: '4', name: 'Project', color: 'purple' }
  ])
  const [availableTags, setAvailableTags] = useState<Tag[]>(mockAvailableTags)
  const [properties, setProperties] = useState<Property[]>(mockProperties)
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)

  // Content state for the editor (BlockNote blocks)
  const [_blocks, setBlocks] = useState<Block[]>([])
  const [headings, setHeadings] = useState<HeadingItem[]>([])

  const handleHeadingClick = useCallback((headingId: string) => {
    console.log('Heading clicked:', headingId)
    // Scroll to the heading element - BlockNote uses data-id attribute
    const element = document.querySelector(`[data-id="${headingId}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  const handleContentChange = useCallback((newBlocks: Block[]) => {
    setBlocks(newBlocks)
    // You can also convert to HTML if needed:
    // const html = await editor.blocksToHTMLLossy(newBlocks)
  }, [])

  const handleHeadingsChange = useCallback((newHeadings: HeadingInfo[]) => {
    // Transform HeadingInfo to HeadingItem for NoteLayout
    setHeadings(
      newHeadings.map((h) => ({
        id: h.id,
        level: h.level,
        text: h.text,
        position: h.position
      }))
    )
  }, [])

  const handleInternalLinkClick = useCallback((noteId: string) => {
    console.log('Internal link clicked, navigate to note:', noteId)
    // TODO: Implement navigation to linked note
  }, [])

  const handleLinkClick = useCallback((href: string) => {
    console.log('External link clicked:', href)
    // Open in default browser
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleEmojiChange = (newEmoji: string | null) => {
    setEmoji(newEmoji)
    console.log('Emoji changed:', newEmoji)
  }

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle)
    console.log('Title changed:', newTitle)
  }

  const handleAddTag = useCallback(
    (tagId: string) => {
      const tagToAdd = availableTags.find((t) => t.id === tagId)
      if (tagToAdd && !tags.some((t) => t.id === tagId)) {
        setTags((prev) => [...prev, tagToAdd])
        console.log('Tag added:', tagToAdd.name)
      }
    },
    [availableTags, tags]
  )

  const handleCreateTag = useCallback((name: string, color: string) => {
    const newTag: Tag = {
      id: `new-${Date.now()}`,
      name,
      color
    }
    setAvailableTags((prev) => [...prev, newTag])
    setTags((prev) => [...prev, newTag])
    console.log('Tag created:', name, color)
  }, [])

  const handleRemoveTag = useCallback((tagId: string) => {
    setTags((prev) => prev.filter((t) => t.id !== tagId))
    console.log('Tag removed:', tagId)
  }, [])

  const handlePropertyChange = useCallback((propertyId: string, value: unknown) => {
    setProperties((prev) =>
      prev.map((p) => (p.id === propertyId ? { ...p, value } : p))
    )
    console.log('Property changed:', propertyId, value)
  }, [])

  const handleAddProperty = useCallback((newProp: NewProperty) => {
    const property: Property = {
      id: `custom-${Date.now()}`,
      name: newProp.name,
      type: newProp.type,
      value: null,
      isCustom: true
    }
    setProperties((prev) => [...prev, property])
    console.log('Property added:', newProp.name, newProp.type)
  }, [])

  const handleDeleteProperty = useCallback((propertyId: string) => {
    setProperties((prev) => prev.filter((p) => p.id !== propertyId))
    console.log('Property deleted:', propertyId)
  }, [])

  const handleBacklinkClick = useCallback((noteId: string) => {
    console.log('Backlink clicked, navigate to note:', noteId)
    // TODO: Implement navigation to linked note
  }, [])

  return (
    <NoteLayout headings={headings} onHeadingClick={handleHeadingClick}>
      {/* Note content */}
      <div className="space-y-6">
        <div style={{ paddingInline: "54px" }}>
          {/* Title section */}
          <div className="space-y-3">
            <NoteTitle
              emoji={emoji}
              title={title}
              onEmojiChange={handleEmojiChange}
              onTitleChange={handleTitleChange}
              placeholder="Untitled"
            />
          </div>

          {/* Tags section */}
          <TagsRow
            tags={tags}
            availableTags={availableTags}
            recentTags={mockRecentTags}
            onAddTag={handleAddTag}
            onCreateTag={handleCreateTag}
            onRemoveTag={handleRemoveTag}
          />

          {/* Info Section (Collapsible Properties) */}
          <InfoSection
            properties={properties}
            isExpanded={isInfoExpanded}
            onToggleExpand={() => setIsInfoExpanded(!isInfoExpanded)}
            onPropertyChange={handlePropertyChange}
            onAddProperty={handleAddProperty}
            onDeleteProperty={handleDeleteProperty}
          />
        </div>
        {/* Main content - BlockNote Editor */}
        <div
          className="editor-click-area min-h-[400px]"
          onMouseDown={(e) => {
            const target = e.target as HTMLElement
            // If clicking directly on editable text, let it work normally
            if (target.closest('[contenteditable="true"]')?.contains(target) &&
                target.closest('.bn-block-content')) {
              return
            }
            // If clicking on buttons or links, let it work normally
            if (target.closest('button, a, input')) {
              return
            }
            // Focus editor for all other clicks (empty areas)
            const editor = (e.currentTarget as HTMLElement).querySelector('.bn-editor [contenteditable="true"]') as HTMLElement
            if (editor) {
              e.preventDefault()
              editor.focus()
            }
          }}
        >
          <ContentArea
            initialContent={initialContent}
            placeholder="Start writing, or press '/' for commands..."
            onContentChange={handleContentChange}
            onHeadingsChange={handleHeadingsChange}
            onLinkClick={handleLinkClick}
            onInternalLinkClick={handleInternalLinkClick}
          />
        </div>

        {/* Backlinks section */}
        <BacklinksSection
          backlinks={mockBacklinks}
          isLoading={false}
          initialCount={5}
          collapsible={true}
          onBacklinkClick={handleBacklinkClick}
        />
      </div>
    </NoteLayout >
  )
}
