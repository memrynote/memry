# Memry Architecture Diagrams

This document provides visual diagrams of the Memry application architecture using Mermaid.

---

## 1. Electron Process Architecture

This shows the three-layer Electron architecture with IPC communication:

```mermaid
flowchart TB
    subgraph Main["Main Process (Node.js)"]
        App[app lifecycle]
        BW[BrowserWindow]
        IPC[ipcMain handlers]
        Shell[shell.openExternal]
    end

    subgraph Preload["Preload Script (Bridge)"]
        CB[contextBridge]
        API["window.api<br/>• windowMinimize<br/>• windowMaximize<br/>• windowClose"]
        Electron["window.electron<br/>(electronAPI)"]
    end

    subgraph Renderer["Renderer Process (React)"]
        React[React 19 App]
        Pages["Pages<br/>• inbox<br/>• tasks<br/>• journal<br/>• note"]
        Contexts[Context Providers]
    end

    Main -->|"exposes APIs via"| Preload
    Preload -->|"window.api / window.electron"| Renderer
    Renderer -.->|"ipcRenderer.send()"| Main

    IPC -->|"window-minimize<br/>window-maximize<br/>window-close"| BW
```

---

## 2. React Provider Hierarchy

This shows how Context providers wrap the application:

```mermaid
flowchart TB
    subgraph Root["App Root"]
        Theme[ThemeProvider]
        Theme --> Sidebar[SidebarProvider]
        Sidebar --> Drag[DragProvider]
        Drag --> Tasks[TasksProvider]
        Tasks --> AI[AIAgentProvider]
        AI --> Tabs[TabProvider]
        Tabs --> TabDrag[TabDragProvider]
        TabDrag --> Content[AppContent]
    end

    subgraph Content["App Content"]
        Header[Header + TabBar]
        Main[Main Content Area]
        AIPanel[GlobalAIPanel]
    end

    Header --> Main
    Main --> AIPanel
```

---

## 3. Tab System State Architecture

Shows the VS Code-style tab system with split view support:

```mermaid
stateDiagram-v2
    [*] --> SinglePane: App Start

    SinglePane --> SplitView: SPLIT_VIEW action
    SplitView --> SinglePane: CLOSE_SPLIT action

    state SinglePane {
        [*] --> TabGroup1
        TabGroup1: Active Tab Group
        TabGroup1: • tabs[]
        TabGroup1: • activeTabId
    }

    state SplitView {
        [*] --> Layout
        Layout: SplitLayout Tree
        Layout --> Left: first (50%)
        Layout --> Right: second (50%)
        Left: TabGroup A
        Right: TabGroup B
    }

    state TabActions {
        OPEN_TAB
        CLOSE_TAB
        SET_ACTIVE_TAB
        PIN_TAB
        MOVE_TAB
        REORDER_TABS
    }
```

---

## 4. Tab Types & Content Routing

Shows how different tab types route to pages:

```mermaid
flowchart LR
    subgraph TabTypes["Tab Types"]
        inbox[inbox]
        tasks[tasks]
        journal[journal]
        note[note]
        project[project]
        allTasks[all-tasks]
        today[today]
        upcoming[upcoming]
        completed[completed]
    end

    subgraph Singleton["Singleton Tabs<br/>(only one instance)"]
        S1[inbox ✓]
        S2[journal ✓]
        S3[tasks ✓]
        S4[today ✓]
        S5[upcoming ✓]
        S6[completed ✓]
    end

    subgraph Pages["Page Components"]
        InboxPage[InboxPage]
        TasksPage[TasksPage]
        JournalPage[JournalPage]
        NotePage["NotePage<br/>(entityId)"]
    end

    inbox --> InboxPage
    tasks --> TasksPage
    allTasks --> TasksPage
    today --> TasksPage
    upcoming --> TasksPage
    completed --> TasksPage
    project --> TasksPage
    journal --> JournalPage
    note --> NotePage
```

---

## 5. Component Architecture

High-level view of the component structure:

```mermaid
flowchart TB
    subgraph Layout["App Layout"]
        AS[AppSidebar]
        SI[SidebarInset]
    end

    subgraph SidebarInset["SidebarInset"]
        Header["Header<br/>TabBar + Actions"]
        MainContent[Main Content]
    end

    subgraph Header
        Trigger[SidebarTrigger]
        TabBar[TabBarWithDrag]
        Shortcuts["? Shortcuts"]
    end

    subgraph MainContent["Content Area"]
        direction TB
        Single[Single Pane Mode]
        Split[Split View Mode]
    end

    Single --> TCR[TabContentRenderer]
    Split --> SVC[SplitViewContainer]
    SVC --> SP1[SplitPane 1]
    SVC --> SP2[SplitPane 2]

    subgraph Sidebar["AppSidebar Components"]
        TS[TeamSwitcher]
        NM[NavMain]
        NP[NavProjects]
        NU[NavUser]
    end

    AS --> Sidebar
```

---

## 6. Drag & Drop System

Shows the unified drag-drop architecture:

```mermaid
flowchart TB
    subgraph DragContext["DragProvider Context"]
        DS[DragState]
        DS --> isDragging
        DS --> activeType
        DS --> selectedIds
    end

    subgraph DragSources["Drag Sources"]
        TaskItem[Task Items]
        TabItem[Tab Items]
        ProjectItem[Project Items]
    end

    subgraph DropTargets["Drop Targets"]
        TaskList[Task List<br/>reorder]
        ProjectFolder[Project Folder<br/>move task]
        TabBar[Tab Bar<br/>reorder tabs]
        SplitZone[Split Drop Zone<br/>create split]
    end

    subgraph Handlers["useDragHandlers Hook"]
        H1[handleReorder]
        H2[handleMoveToProject]
        H3[handleTabMove]
    end

    TaskItem --> TaskList
    TaskItem --> ProjectFolder
    TabItem --> TabBar
    TabItem --> SplitZone
    ProjectItem -->|sidebar| ProjectFolder

    TaskList --> H1
    ProjectFolder --> H2
    TabBar --> H3
```

---

## 7. Data Flow Architecture

Shows how task data flows through the application:

```mermaid
flowchart TB
    subgraph State["App State (App.tsx)"]
        tasks["tasks: Task[]"]
        projects["projects: Project[]"]
        selectedIds["selectedTaskIds: Set"]
    end

    subgraph Providers["Context Providers"]
        TasksProvider
        TabProvider
        DragProvider
    end

    subgraph Callbacks["State Handlers"]
        handleTasksChange
        handleProjectsChange
        handleUpdateTask
        handleDeleteTask
    end

    State --> Providers
    Providers --> Pages

    subgraph Pages["Page Components"]
        TasksPage
        InboxPage
    end

    Pages -->|"onTasksChange"| handleTasksChange
    Pages -->|"user actions"| handleUpdateTask
    handleUpdateTask --> tasks
    handleTasksChange --> tasks

    tasks -->|"useMemo"| viewCounts
    tasks -->|"useMemo"| projectsWithCounts
```

---

## Summary

| Diagram | What it Shows |
|---------|---------------|
| **#1 Electron Architecture** | Three-process model with IPC communication |
| **#2 Provider Hierarchy** | React Context nesting order |
| **#3 Tab System State** | VS Code-style tab management with split views |
| **#4 Tab Routing** | How tab types map to page components |
| **#5 Component Architecture** | Layout structure and component relationships |
| **#6 Drag & Drop** | Unified drag-drop system with sources/targets |
| **#7 Data Flow** | Task state management and callbacks |
