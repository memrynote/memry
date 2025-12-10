import { useState, useCallback } from 'react'
import { NoteLayout, HeadingItem } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, Property, NewProperty } from '@/components/note/info-section'

interface NotePageProps {
  noteId?: string
}

// Mock heading data for demonstration
const mockHeadings: HeadingItem[] = [
  { id: 'h1', level: 1, text: 'Introduction', position: 10 },
  { id: 'h2', level: 2, text: 'Background', position: 25 },
  { id: 'h3', level: 2, text: 'Key Concepts', position: 40 },
  { id: 'h4', level: 3, text: 'Concept A', position: 45 },
  { id: 'h5', level: 3, text: 'Concept B', position: 52 },
  { id: 'h6', level: 1, text: 'Implementation', position: 65 },
  { id: 'h7', level: 2, text: 'Setup', position: 70 },
  { id: 'h8', level: 2, text: 'Configuration', position: 80 },
  { id: 'h9', level: 1, text: 'Conclusion', position: 90 }
]

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
  const [isInfoExpanded, setIsInfoExpanded] = useState(true)

  const handleHeadingClick = (headingId: string) => {
    console.log('Heading clicked:', headingId)
    // In a real implementation, this would scroll to the heading
  }

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

  return (
    <NoteLayout headings={mockHeadings} onHeadingClick={handleHeadingClick}>
      {/* Note content - this is placeholder content */}
      <div className="space-y-6">
        {/* Title section */}
        <div className="space-y-3">
          <NoteTitle
            emoji={emoji}
            title={title}
            onEmojiChange={handleEmojiChange}
            onTitleChange={handleTitleChange}
            placeholder="Untitled"
          />
          <p className="text-sm text-stone-600">
            A brief description of what this note is about
          </p>
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

        {/* Main content */}
        <div className="prose prose-stone max-w-none">
          <h2 id="h1">Introduction</h2>
          <p>
            This is a sample note demonstrating the note editor layout. The layout follows a
            clean, three-zone design inspired by Capacities and other modern PKM applications.
          </p>
          <p>
            The main content area is centered with a comfortable max-width of 720px, providing
            optimal reading width while maintaining a clean, paper-like aesthetic.
          </p>

          <h3 id="h2">Background</h3>
          <p>
            The design philosophy emphasizes progressive disclosure, with advanced features hidden
            until needed. The warm color palette creates a comfortable reading environment.
          </p>

          <h3 id="h3">Key Concepts</h3>
          <p>
            The layout is built with three distinct zones, each serving a specific purpose in the
            note-taking workflow.
          </p>

          <h4 id="h4">Concept A</h4>
          <p>
            The main content zone provides a distraction-free writing environment with generous
            padding and a warm background color.
          </p>

          <h4 id="h5">Concept B</h4>
          <p>
            The outline edge allows quick navigation through document structure, while the right
            sidebar provides access to AI features and related notes.
          </p>

          <h2 id="h6">Implementation</h2>
          <p>
            The layout is implemented using modern React patterns with TypeScript, following the
            existing architectural conventions in the Memry application.
          </p>

          <h3 id="h7">Setup</h3>
          <p>
            Components are organized in a modular fashion, with clear separation of concerns
            between layout logic and content rendering.
          </p>

          <h3 id="h8">Configuration</h3>
          <p>
            The layout supports responsive breakpoints, adapting seamlessly from desktop to tablet
            and mobile viewports while maintaining usability.
          </p>

          <h2 id="h9">Conclusion</h2>
          <p>
            This layout shell provides a solid foundation for building a comprehensive note editor
            with all the features specified in the design document.
          </p>

          {/* Additional content for scrolling demonstration */}
          <p>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
            incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
            exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
          </p>
          <p>
            Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat
            nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui
            officia deserunt mollit anim id est laborum.
          </p>
        </div>

        {/* Backlinks section */}
        <div className="border-t border-stone-200 pt-6 mt-8">
          <h3 className="text-sm font-medium text-stone-900 mb-3">Backlinks</h3>
          <p className="text-sm text-stone-500">
            Notes that link to this one will appear here.
          </p>
        </div>
      </div>
    </NoteLayout>
  )
}
