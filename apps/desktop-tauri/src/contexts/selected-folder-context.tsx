import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'

interface SelectedFolderContextValue {
  selectedFolder: string
  setSelectedFolder: (folder: string) => void
}

const SelectedFolderContext = createContext<SelectedFolderContextValue | null>(null)

export function useSelectedFolder(): SelectedFolderContextValue {
  const context = useContext(SelectedFolderContext)
  if (!context) {
    throw new Error('useSelectedFolder must be used within SelectedFolderProvider')
  }
  return context
}

export function SelectedFolderProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [selectedFolder, setSelectedFolderState] = useState('')

  const setSelectedFolder = useCallback((folder: string) => {
    setSelectedFolderState(folder)
  }, [])

  const value = useMemo<SelectedFolderContextValue>(
    () => ({ selectedFolder, setSelectedFolder }),
    [selectedFolder, setSelectedFolder]
  )

  return <SelectedFolderContext.Provider value={value}>{children}</SelectedFolderContext.Provider>
}
