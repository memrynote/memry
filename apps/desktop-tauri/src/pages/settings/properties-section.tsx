import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Search, MoreHorizontal, Pencil, Trash2, ChevronDown, ChevronUp, Plus } from '@/lib/icons'
import { toast } from 'sonner'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  getTagColors,
  withAlpha,
  COLOR_ROWS,
  TAG_COLORS,
  COLOR_NAMES
} from '@/components/note/tags-row/tag-colors'
import { cn } from '@/lib/utils'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { PROPERTY_TYPE_CONFIG } from '@/components/note/info-section/types'
import type {
  SelectOption,
  StatusCategories,
  StatusCategoryKey
} from '@memry/contracts/property-types'

const STATUS_CATEGORY_ORDER: StatusCategoryKey[] = ['todo', 'in_progress', 'done']

function parseOptions(optionsJson: string | null): SelectOption[] {
  if (!optionsJson) return []
  try {
    const parsed = JSON.parse(optionsJson)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

function parseCategories(optionsJson: string | null): StatusCategories | null {
  if (!optionsJson) return null
  try {
    const parsed = JSON.parse(optionsJson)
    if (parsed?.categories) return parsed.categories
    return null
  } catch {
    return null
  }
}

export function PropertiesSettings() {
  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Properties" subtitle="Manage property definitions across all notes" />
      <PropertyManager />
    </div>
  )
}

function PropertyManager() {
  const { definitions, isLoading, error, refresh } = usePropertyDefinitions()
  const [search, setSearch] = useState('')
  const [expandedDef, setExpandedDef] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [colorEdit, setColorEdit] = useState<{
    propertyName: string
    optionValue: string
  } | null>(null)
  const [editingOption, setEditingOption] = useState<{
    propertyName: string
    oldValue: string
  } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [addingOption, setAddingOption] = useState<string | null>(null)
  const [newOptionName, setNewOptionName] = useState('')
  const [addingStatusOption, setAddingStatusOption] = useState<{
    propertyName: string
    categoryKey: StatusCategoryKey
  } | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingOption && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingOption])

  useEffect(() => {
    if ((addingOption || addingStatusOption) && addInputRef.current) {
      addInputRef.current.focus()
    }
  }, [addingOption, addingStatusOption])

  const selectDefs = useMemo(
    () =>
      definitions.filter(
        (d) =>
          (d.type === 'status' || d.type === 'select' || d.type === 'multiselect') &&
          d.name.toLowerCase().includes(search.toLowerCase())
      ),
    [definitions, search]
  )

  const handleRenameOption = useCallback(
    async (propertyName: string, oldValue: string, newValue: string) => {
      if (!newValue.trim() || newValue.trim() === oldValue) {
        setEditingOption(null)
        return
      }
      try {
        await notesService.renamePropertyOption(propertyName, oldValue, newValue.trim())
        toast.success(`Renamed "${oldValue}" to "${newValue.trim()}"`)
        await refresh()
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to rename option'))
      }
      setEditingOption(null)
    },
    [refresh]
  )

  const handleRemoveOption = useCallback(
    async (propertyName: string, optionValue: string) => {
      try {
        await notesService.removePropertyOption(propertyName, optionValue)
        toast.success(`Removed "${optionValue}"`)
        await refresh()
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to remove option'))
      }
    },
    [refresh]
  )

  const handleColorChange = useCallback(
    async (colorName: string) => {
      if (!colorEdit) return
      try {
        await notesService.updateOptionColor(
          colorEdit.propertyName,
          colorEdit.optionValue,
          colorName
        )
        await refresh()
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to update color'))
      }
      setColorEdit(null)
    },
    [colorEdit, refresh]
  )

  const handleDeleteDefinition = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await notesService.deletePropertyDefinition(deleteTarget)
      toast.success(`Deleted property "${deleteTarget}"`)
      await refresh()
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to delete property'))
    }
    setDeleteTarget(null)
  }, [deleteTarget, refresh])

  const handleAddOption = useCallback(
    async (propertyName: string) => {
      if (!newOptionName.trim()) return
      const color = COLOR_NAMES[((selectDefs.length + Math.random() * 10) % COLOR_NAMES.length) | 0]
      try {
        await notesService.addPropertyOption(propertyName, {
          value: newOptionName.trim(),
          color
        })
        await refresh()
        setNewOptionName('')
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to add option'))
      }
      setAddingOption(null)
    },
    [newOptionName, selectDefs.length, refresh]
  )

  const handleAddStatusOption = useCallback(
    async (propertyName: string, categoryKey: StatusCategoryKey) => {
      if (!newOptionName.trim()) return
      const color = COLOR_NAMES[((selectDefs.length + Math.random() * 10) % COLOR_NAMES.length) | 0]
      try {
        await notesService.addStatusOption(propertyName, categoryKey, {
          value: newOptionName.trim(),
          color
        })
        await refresh()
        setNewOptionName('')
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to add option'))
      }
      setAddingStatusOption(null)
    },
    [newOptionName, selectDefs.length, refresh]
  )

  if (isLoading) {
    return <p className="text-xs/4 text-muted-foreground">Loading properties...</p>
  }

  if (error) {
    return <p className="text-xs/4 text-destructive">{error}</p>
  }

  if (definitions.length === 0) {
    return (
      <p className="text-xs/4 text-muted-foreground">
        No property definitions yet. Add a Status, Select, or Multiselect property to any note to
        get started.
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="relative pb-6">
        <Search className="absolute left-3 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter properties..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-8 text-xs/4 rounded-lg border-border bg-transparent"
        />
      </div>

      <div className="flex flex-col rounded-lg overflow-y-auto max-h-[60vh] border border-border">
        {selectDefs.length === 0 && (
          <p className="text-xs/4 text-muted-foreground py-4 text-center">
            No properties matching &ldquo;{search}&rdquo;
          </p>
        )}
        {selectDefs.map((def, i) => {
          const isExpanded = expandedDef === def.name
          const config = PROPERTY_TYPE_CONFIG[def.type as keyof typeof PROPERTY_TYPE_CONFIG]
          const options = parseOptions(def.options)
          const categories = def.type === 'status' ? parseCategories(def.options) : null
          const optionCount = categories
            ? STATUS_CATEGORY_ORDER.reduce(
                (sum, key) => sum + (categories[key]?.options.length ?? 0),
                0
              )
            : options.length

          return (
            <div key={def.name}>
              {i > 0 && <div className="h-px bg-border" />}
              <div
                className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => setExpandedDef(isExpanded ? null : def.name)}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {isExpanded ? (
                    <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-medium text-[13px]/4 text-foreground truncate">
                    {def.name}
                  </span>
                  <span className="text-[10px]/3 font-medium text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0">
                    {config?.label ?? def.type}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-4">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {optionCount} option{optionCount !== 1 ? 's' : ''}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget(def.name)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete property
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-3">
                  {def.type === 'status' && categories
                    ? STATUS_CATEGORY_ORDER.map((catKey) => {
                        const cat = categories[catKey]
                        if (!cat) return null
                        return (
                          <div key={catKey} className="mb-2">
                            <div className="flex items-center justify-between py-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {cat.label}
                              </span>
                              <button
                                onClick={() => {
                                  setAddingStatusOption({
                                    propertyName: def.name,
                                    categoryKey: catKey
                                  })
                                  setNewOptionName('')
                                }}
                                className="text-muted-foreground/50 hover:text-muted-foreground"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                            {cat.options.map((opt) => (
                              <OptionRow
                                key={opt.value}
                                option={opt}
                                propertyName={def.name}
                                isEditing={
                                  editingOption?.propertyName === def.name &&
                                  editingOption?.oldValue === opt.value
                                }
                                editValue={editValue}
                                editInputRef={editInputRef}
                                onStartEdit={() => {
                                  setEditingOption({
                                    propertyName: def.name,
                                    oldValue: opt.value
                                  })
                                  setEditValue(opt.value)
                                }}
                                onEditChange={setEditValue}
                                onConfirmEdit={() =>
                                  handleRenameOption(def.name, opt.value, editValue)
                                }
                                onCancelEdit={() => setEditingOption(null)}
                                onRemove={() => handleRemoveOption(def.name, opt.value)}
                                onColorClick={() =>
                                  setColorEdit({
                                    propertyName: def.name,
                                    optionValue: opt.value
                                  })
                                }
                              />
                            ))}
                            {addingStatusOption?.propertyName === def.name &&
                              addingStatusOption.categoryKey === catKey && (
                                <div className="flex items-center gap-2 pl-5 py-1">
                                  <Input
                                    ref={addInputRef}
                                    value={newOptionName}
                                    onChange={(e) => setNewOptionName(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter')
                                        void handleAddStatusOption(def.name, catKey)
                                      if (e.key === 'Escape') setAddingStatusOption(null)
                                    }}
                                    onBlur={() => {
                                      if (!newOptionName.trim()) setAddingStatusOption(null)
                                    }}
                                    placeholder="Option name"
                                    className="h-6 text-[13px]/4 px-1.5 flex-1"
                                  />
                                </div>
                              )}
                          </div>
                        )
                      })
                    : options.map((opt) => (
                        <OptionRow
                          key={opt.value}
                          option={opt}
                          propertyName={def.name}
                          isEditing={
                            editingOption?.propertyName === def.name &&
                            editingOption?.oldValue === opt.value
                          }
                          editValue={editValue}
                          editInputRef={editInputRef}
                          onStartEdit={() => {
                            setEditingOption({ propertyName: def.name, oldValue: opt.value })
                            setEditValue(opt.value)
                          }}
                          onEditChange={setEditValue}
                          onConfirmEdit={() => handleRenameOption(def.name, opt.value, editValue)}
                          onCancelEdit={() => setEditingOption(null)}
                          onRemove={() => handleRemoveOption(def.name, opt.value)}
                          onColorClick={() =>
                            setColorEdit({ propertyName: def.name, optionValue: opt.value })
                          }
                        />
                      ))}
                  {def.type !== 'status' && (
                    <>
                      {addingOption === def.name ? (
                        <div className="flex items-center gap-2 pl-5 py-1">
                          <Input
                            ref={addInputRef}
                            value={newOptionName}
                            onChange={(e) => setNewOptionName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleAddOption(def.name)
                              if (e.key === 'Escape') setAddingOption(null)
                            }}
                            onBlur={() => {
                              if (!newOptionName.trim()) setAddingOption(null)
                            }}
                            placeholder="Option name"
                            className="h-6 text-[13px]/4 px-1.5 flex-1"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setAddingOption(def.name)
                            setNewOptionName('')
                          }}
                          className="flex items-center gap-1.5 pl-5 py-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
                        >
                          <Plus className="w-3 h-3" />
                          Add option
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-xs/4 text-muted-foreground pt-3">
        {selectDefs.length} property definition{selectDefs.length !== 1 ? 's' : ''}
      </p>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete property</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the &ldquo;{deleteTarget}&rdquo; property definition? Notes using this property
              will keep their values as plain text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteDefinition()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!colorEdit} onOpenChange={(open) => !open && setColorEdit(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Change color for &ldquo;{colorEdit?.optionValue}&rdquo;</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {COLOR_ROWS.map((row, rowIndex) => (
              <div key={rowIndex} className="flex gap-2 justify-center">
                {row.map((colorName) => {
                  const clrs = TAG_COLORS[colorName]
                  return (
                    <button
                      key={colorName}
                      type="button"
                      onClick={() => void handleColorChange(colorName)}
                      className={cn(
                        'w-7 h-7 rounded-full transition-all hover:scale-110',
                        'focus:outline-none'
                      )}
                      style={{ backgroundColor: clrs.background }}
                      title={colorName}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function OptionRow({
  option,
  propertyName,
  isEditing,
  editValue,
  editInputRef,
  onStartEdit,
  onEditChange,
  onConfirmEdit,
  onCancelEdit,
  onRemove,
  onColorClick
}: {
  option: SelectOption
  propertyName: string
  isEditing: boolean
  editValue: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  onStartEdit: () => void
  onEditChange: (value: string) => void
  onConfirmEdit: () => void
  onCancelEdit: () => void
  onRemove: () => void
  onColorClick: () => void
}) {
  const colors = getTagColors(option.color)

  return (
    <div className="flex items-center gap-2 pl-5 py-1 group/option">
      <button
        type="button"
        onClick={onColorClick}
        className="w-2.5 h-2.5 rounded-full shrink-0 hover:scale-125 transition-transform"
        style={{ backgroundColor: colors.text }}
        title="Change color"
      />
      {isEditing ? (
        <Input
          ref={editInputRef}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onConfirmEdit()
            if (e.key === 'Escape') onCancelEdit()
          }}
          onBlur={() => void onConfirmEdit()}
          className="h-6 text-[13px]/4 px-1.5 flex-1"
        />
      ) : (
        <span
          className="text-[13px]/4 text-foreground flex-1 truncate rounded-[10px] px-2 py-0.5"
          style={{
            backgroundColor: withAlpha(colors.text, 0.12),
            color: colors.text
          }}
        >
          {option.value}
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover/option:opacity-100 transition-opacity">
        <button
          onClick={onStartEdit}
          className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground"
          title="Rename"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          onClick={onRemove}
          className="p-0.5 rounded text-muted-foreground/50 hover:text-destructive"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
