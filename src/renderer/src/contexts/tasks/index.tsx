/**
 * Tasks Context
 * Provides task and project state across the application
 * Enables split view panes to access shared task data
 */

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Task } from '@/data/sample-tasks';
import type { Project } from '@/data/tasks-data';
import type { TaskSelectionType } from '@/App';

// =============================================================================
// TYPES
// =============================================================================

interface TasksContextValue {
    // Data
    tasks: Task[];
    projects: Project[];

    // Selection state
    taskSelectedId: string;
    taskSelectedType: TaskSelectionType;
    selectedTaskIds: Set<string>;

    // Actions
    setTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
    setProjects: (projects: Project[] | ((prev: Project[]) => Project[])) => void;
    setSelection: (id: string, type: TaskSelectionType) => void;
    setSelectedTaskIds: (ids: Set<string>) => void;

    // Task operations
    addTask: (task: Task) => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    deleteTask: (taskId: string) => void;

    // Project operations
    addProject: (project: Project) => void;
    updateProject: (projectId: string, updates: Partial<Project>) => void;
    deleteProject: (projectId: string) => void;
}

interface TasksProviderProps {
    children: ReactNode;
    initialTasks: Task[];
    initialProjects: Project[];
    onTasksChange?: (tasks: Task[]) => void;
    onProjectsChange?: (projects: Project[]) => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

const TasksContext = createContext<TasksContextValue | null>(null);

// =============================================================================
// HOOK
// =============================================================================

export const useTasksContext = (): TasksContextValue => {
    const context = useContext(TasksContext);
    if (!context) {
        throw new Error('useTasksContext must be used within a TasksProvider');
    }
    return context;
};

/**
 * Optional hook that returns null if used outside provider
 * Useful for components that can work with or without TasksContext
 */
export const useTasksOptional = (): TasksContextValue | null => {
    return useContext(TasksContext);
};

// =============================================================================
// PROVIDER
// =============================================================================

export const TasksProvider = ({
    children,
    initialTasks,
    initialProjects,
    onTasksChange,
    onProjectsChange,
}: TasksProviderProps): React.JSX.Element => {
    // Core state
    const [tasks, setTasksState] = useState<Task[]>(initialTasks);
    const [projects, setProjectsState] = useState<Project[]>(initialProjects);

    // Selection state
    const [taskSelectedId, setTaskSelectedId] = useState<string>('all');
    const [taskSelectedType, setTaskSelectedType] = useState<TaskSelectionType>('view');
    const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());

    // Wrapped setters that also call external handlers
    const setTasks = useCallback((updater: Task[] | ((prev: Task[]) => Task[])) => {
        setTasksState((prev) => {
            const newTasks = typeof updater === 'function' ? updater(prev) : updater;
            onTasksChange?.(newTasks);
            return newTasks;
        });
    }, [onTasksChange]);

    const setProjects = useCallback((updater: Project[] | ((prev: Project[]) => Project[])) => {
        setProjectsState((prev) => {
            const newProjects = typeof updater === 'function' ? updater(prev) : updater;
            onProjectsChange?.(newProjects);
            return newProjects;
        });
    }, [onProjectsChange]);

    const setSelection = useCallback((id: string, type: TaskSelectionType) => {
        setTaskSelectedId(id);
        setTaskSelectedType(type);
    }, []);

    // Task operations
    const addTask = useCallback((task: Task) => {
        setTasks((prev) => [...prev, task]);
    }, [setTasks]);

    const updateTask = useCallback((taskId: string, updates: Partial<Task>) => {
        setTasks((prev) =>
            prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task))
        );
    }, [setTasks]);

    const deleteTask = useCallback((taskId: string) => {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
    }, [setTasks]);

    // Project operations
    const addProject = useCallback((project: Project) => {
        setProjects((prev) => [...prev, project]);
    }, [setProjects]);

    const updateProject = useCallback((projectId: string, updates: Partial<Project>) => {
        setProjects((prev) =>
            prev.map((project) => (project.id === projectId ? { ...project, ...updates } : project))
        );
    }, [setProjects]);

    const deleteProject = useCallback((projectId: string) => {
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
    }, [setProjects]);

    // Memoized context value
    const value = useMemo<TasksContextValue>(() => ({
        tasks,
        projects,
        taskSelectedId,
        taskSelectedType,
        selectedTaskIds,
        setTasks,
        setProjects,
        setSelection,
        setSelectedTaskIds,
        addTask,
        updateTask,
        deleteTask,
        addProject,
        updateProject,
        deleteProject,
    }), [
        tasks,
        projects,
        taskSelectedId,
        taskSelectedType,
        selectedTaskIds,
        setTasks,
        setProjects,
        setSelection,
        addTask,
        updateTask,
        deleteTask,
        addProject,
        updateProject,
        deleteProject,
    ]);

    return (
        <TasksContext.Provider value={value}>
            {children}
        </TasksContext.Provider>
    );
};

export default TasksProvider;
