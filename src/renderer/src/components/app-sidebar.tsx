'use client'

import * as React from 'react'
import { useMemo, useState, useCallback } from 'react'
import { BookOpen, Home, Inbox, ListTodo, Plus, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { VaultSwitcher } from '@/components/vault-switcher'
import { TrafficLights } from '@/components/traffic-lights'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar
} from '@/components/ui/sidebar'
import { SidebarSection } from '@/components/sidebar-section'
import { NotesTree } from '@/components/notes-tree'
import { SidebarTagList } from '@/components/sidebar/sidebar-tag-list'
import { SidebarBookmarkList } from '@/components/sidebar/sidebar-bookmark-list'
import { SidebarDrillDownContainer } from '@/components/sidebar/sidebar-drill-down-container'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useTabs } from '@/contexts/tabs'
import { notesService } from '@/services/notes-service'
import { SidebarDrillDownProvider, useSidebarDrillDown } from '@/contexts/sidebar-drill-down'
import { useInboxList } from '@/hooks/use-inbox'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'
import type { AppPage } from '@/App'
import type { BookmarkWithItem } from '@/hooks/use-bookmarks'
import { BookmarkItemTypes } from '@shared/contracts/bookmarks-api'

// Quick actions data with soft utility colors
const quickActions = [
  {
    title: 'Search',
    icon: Search,
    kbd: '⌘ P',
    iconColor: 'text-soft-slate',
    action: 'search' as const
  },
  {
    title: 'New',
    icon: Plus,
    kbd: '⌘ N',
    iconColor: 'text-soft-sage',
    action: 'new' as const
  }
]

// Main navigation data - now includes Tasks
const mainNav: {
  title: string
  page: AppPage
  icon: typeof Inbox
  iconColor: string
}[] = [
  {
    title: 'Inbox',
    page: 'inbox',
    icon: Inbox,
    iconColor: 'text-accent-cyan'
  },
  {
    title: 'Home',
    page: 'home',
    icon: Home,
    iconColor: 'text-accent-green'
  },
  {
    title: 'Journal',
    page: 'journal',
    icon: BookOpen,
    iconColor: 'text-accent-purple'
  },
  {
    title: 'Tasks',
    page: 'tasks',
    icon: ListTodo,
    iconColor: 'text-accent-orange'
  }
]

function SidebarHeaderContent() {
  const { state } = useSidebar()
  const isCollapsed = state === 'collapsed'

  return (
    <SidebarHeader>
      {/* Drag region + Traffic lights for macOS */}
      <div
        className={cn(
          'drag-region flex items-center h-8 shrink-0 transition-all duration-200',
          isCollapsed ? 'justify-center px-0' : 'justify-start px-2'
        )}
      >
        <TrafficLights compact={isCollapsed} />
      </div>
      <VaultSwitcher />
    </SidebarHeader>
  )
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  currentPage: AppPage
  viewCounts: Record<string, number>
  onOpenSearch?: () => void
}

export function AppSidebar({ currentPage, viewCounts, onOpenSearch, ...props }: AppSidebarProps) {
  return (
    <SidebarDrillDownProvider>
      <AppSidebarInner
        currentPage={currentPage}
        viewCounts={viewCounts}
        onOpenSearch={onOpenSearch}
        {...props}
      />
    </SidebarDrillDownProvider>
  )
}

/**
 * Inner sidebar component that has access to the drill-down context.
 */
function AppSidebarInner({ currentPage, viewCounts, onOpenSearch, ...props }: AppSidebarProps) {
  // State to hold action buttons from NotesTree
  const [notesActions, setNotesActions] = useState<React.ReactNode>(null)

  // Calculate today's tasks count for Tasks badge in sidebar
  const todayTasksCount = useMemo(() => {
    return viewCounts['today'] || 0
  }, [viewCounts])

  // Get inbox items count (unfiled items + unviewed reminders)
  const { items: inboxItems } = useInboxList({ includeSnoozed: false })
  const inboxCount = useMemo(() => {
    if (!inboxItems) return 0
    // Count all items (unfiled by default) but for reminders, only count unviewed ones
    return inboxItems.filter((item) => item.type !== 'reminder' || !item.viewedAt).length
  }, [inboxItems])

  // Tab navigation hook
  const { openSidebarItem, isActiveItem } = useSidebarNavigation()

  // Tab context for opening new notes
  const { openTab } = useTabs()

  // Drill-down context for tag navigation
  const { openTag } = useSidebarDrillDown()

  // Handle creating a new note
  const handleNewNote = useCallback(async () => {
    try {
      const result = await notesService.create({
        title: 'Untitled Note',
        content: ''
      })

      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title || 'Untitled Note',
          icon: 'file-text',
          path: `/note/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    } catch (error) {
      console.error('Failed to create new note:', error)
    }
  }, [openTab])

  const handleNavClick = (page: AppPage) => (e: React.MouseEvent) => {
    e.preventDefault()

    // Map page to tab type and title
    const pageToTabType: Record<AppPage, TabType> = {
      inbox: 'inbox',
      home: 'home',
      journal: 'journal',
      tasks: 'tasks'
    }
    const pageToTitle: Record<AppPage, string> = {
      inbox: 'Inbox',
      home: 'Home',
      journal: 'Journal',
      tasks: 'Tasks'
    }

    // Open as tab in active pane
    const item: SidebarItem = {
      type: pageToTabType[page],
      title: pageToTitle[page],
      path: `/${page}`
    }
    openSidebarItem(item)
  }

  // Handle tag click - open tag drill-down view
  const handleTagClick = useCallback(
    (tag: string, color: string) => {
      openTag(tag, color)
    },
    [openTag]
  )

  // Handle bookmark click - navigate to bookmarked item
  const handleBookmarkClick = useCallback(
    (bookmark: BookmarkWithItem) => {
      // Map bookmark item type to tab type
      const itemTypeToTabType: Record<string, TabType> = {
        [BookmarkItemTypes.NOTE]: 'note',
        [BookmarkItemTypes.JOURNAL]: 'journal',
        [BookmarkItemTypes.TASK]: 'tasks'
      }

      const tabType = itemTypeToTabType[bookmark.itemType] || 'note'

      // Open the bookmarked item in a tab
      const item: SidebarItem = {
        type: tabType,
        title: bookmark.itemTitle || 'Untitled',
        path: bookmark.itemMeta?.path || `/${bookmark.itemType}/${bookmark.itemId}`,
        entityId: bookmark.itemId
      }
      openSidebarItem(item)
    },
    [openSidebarItem]
  )

  // Main sidebar content (shown when not drilling down)
  const mainContent = (
    <>
      {/* FIXED SECTION - Quick Actions & Main Nav (doesn't scroll) */}
      <div className="flex-shrink-0">
        {/* Quick Actions: Search & New */}
        <SidebarGroup>
          <SidebarMenu>
            {quickActions.map((action) => (
              <SidebarMenuItem key={action.title}>
                <SidebarMenuButton
                  tooltip={action.title}
                  onClick={
                    action.action === 'search'
                      ? onOpenSearch
                      : action.action === 'new'
                        ? handleNewNote
                        : undefined
                  }
                >
                  <action.icon className={cn('size-4', action.iconColor)} />
                  <span>{action.title}</span>
                  <KbdGroup className="ml-auto">
                    <Kbd>{action.kbd}</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator className="w-auto!" />

        {/* Main Navigation: Inbox, Home, Journal, Tasks */}
        <SidebarGroup>
          <SidebarMenu>
            {mainNav.map((item) => {
              // Create SidebarItem to check active state from tab system
              const sidebarItem: SidebarItem = {
                type: item.page as TabType,
                title: item.title,
                path: `/${item.page}`
              }
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={isActiveItem(sidebarItem)}
                    onClick={handleNavClick(item.page)}
                  >
                    <item.icon className={cn('size-4', item.iconColor)} />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {/* Show inbox count badge for Inbox */}
                  {item.page === 'inbox' && inboxCount > 0 && (
                    <SidebarMenuBadge>{inboxCount}</SidebarMenuBadge>
                  )}
                  {/* Show today's task count badge for Tasks */}
                  {item.page === 'tasks' && todayTasksCount > 0 && (
                    <SidebarMenuBadge>{todayTasksCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator className="w-auto!" />
      </div>

      {/* SCROLLABLE SECTION - Collections, Bookmarks, Tags */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* COLLECTIONS Section - Collapsible with actions */}
        <SidebarSection
          id="collections"
          label="Collections"
          defaultExpanded={false}
          actions={notesActions}
        >
          <NotesTree onActionsReady={setNotesActions} />
        </SidebarSection>

        {/* BOOKMARKS Section - Collapsible */}
        <SidebarSection id="bookmarks" label="Bookmarks" defaultExpanded={false}>
          <SidebarBookmarkList maxVisible={6} onBookmarkClick={handleBookmarkClick} />
        </SidebarSection>

        {/* TAGS Section - Collapsible */}
        <SidebarSection id="tags" label="Tags" defaultExpanded={false}>
          <SidebarTagList maxVisible={6} onTagClick={handleTagClick} />
        </SidebarSection>
      </div>
    </>
  )

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeaderContent />
      <SidebarContent className="flex flex-col overflow-hidden">
        <SidebarDrillDownContainer>{mainContent}</SidebarDrillDownContainer>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
