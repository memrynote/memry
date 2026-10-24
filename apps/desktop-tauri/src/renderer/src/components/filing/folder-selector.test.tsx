import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FolderSelector } from './folder-selector'
import type { Folder } from '@/types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) ?? key
  })
}))

const folder = (id: string, path: string): Folder => ({
  id,
  name: path.split('/').pop() ?? path,
  path
})

describe('FolderSelector', () => {
  it('selects suggested/recent/all folders and creates folders from search', () => {
    const onSelect = vi.fn()
    const folders = [folder('root', 'Notes'), folder('work', 'Work/Plans'), folder('life', 'Life')]

    render(
      <FolderSelector
        folders={folders}
        suggestedFolders={[
          {
            ...folder('suggested', 'Suggested/Launch'),
            aiConfidence: 0.87,
            aiReason: 'Similar launch notes'
          }
        ]}
        recentFolders={[folder('recent', 'Recent/Inbox')]}
        selectedFolder={folder('selected', 'Selected/Current')}
        onSelect={onSelect}
      />
    )

    expect(screen.getByText('Selected/Current')).toBeInTheDocument()
    expect(screen.getByText('87%')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Suggested/Launch'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'suggested' }))

    fireEvent.keyDown(screen.getByText('Recent/Inbox'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'recent' }))

    fireEvent.click(screen.getByRole('button', { name: /allFolders/ }))
    fireEvent.keyDown(screen.getByText('Work/Plans'), { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'work' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'searchFolders2' }), {
      target: { value: 'Life' }
    })
    expect(screen.getAllByText('Life').length).toBeGreaterThanOrEqual(2)

    fireEvent.change(screen.getByRole('textbox', { name: 'searchFolders2' }), {
      target: { value: 'New/Folder' }
    })
    fireEvent.click(screen.getByText('New/Folder'))
    expect(onSelect).toHaveBeenCalledWith({
      id: 'New/Folder',
      name: 'Folder',
      path: 'New/Folder'
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'searchFolders2' }), {
      target: { value: 'Keyboard/Folder' }
    })
    fireEvent.keyDown(screen.getByText('Keyboard/Folder'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({
      id: 'Keyboard/Folder',
      name: 'Folder',
      path: 'Keyboard/Folder'
    })
  })

  it('renders empty sections and supports a selected search-created folder', () => {
    const onSelect = vi.fn()
    render(
      <FolderSelector
        folders={[]}
        suggestedFolders={[]}
        recentFolders={[]}
        selectedFolder={folder('Custom', 'Custom')}
        onSelect={onSelect}
      />
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'searchFolders2' }), {
      target: { value: 'Custom' }
    })
    expect(screen.getAllByText('Custom').length).toBeGreaterThanOrEqual(2)
  })
})
