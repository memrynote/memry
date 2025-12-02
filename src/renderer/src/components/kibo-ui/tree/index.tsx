"use client";

import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type NodeInfo = {
  nodeId: string;
  parentId: string | null;
  hasChildren: boolean;
};

type TreeContextType = {
  expandedIds: Set<string>;
  selectedIds: string[];
  focusedId: string | null;
  toggleExpanded: (nodeId: string) => void;
  handleSelection: (nodeId: string, ctrlKey: boolean) => void;
  setFocusedId: (nodeId: string | null) => void;
  registerNode: (nodeId: string, parentId: string | null, hasChildren: boolean) => void;
  unregisterNode: (nodeId: string) => void;
  getVisibleNodes: () => string[];
  getNodeInfo: (nodeId: string) => NodeInfo | undefined;
  expandNode: (nodeId: string) => void;
  collapseNode: (nodeId: string) => void;
  showLines?: boolean;
  showIcons?: boolean;
  selectable?: boolean;
  multiSelect?: boolean;
  indent?: number;
  animateExpand?: boolean;
};

const TreeContext = createContext<TreeContextType | undefined>(undefined);

const useTree = () => {
  const context = useContext(TreeContext);
  if (!context) {
    throw new Error("Tree components must be used within a TreeProvider");
  }
  return context;
};

type TreeNodeContextType = {
  nodeId: string;
  parentId: string | null;
  level: number;
  isLast: boolean;
  parentPath: boolean[];
  hasChildren: boolean;
  setHasChildren: (value: boolean) => void;
};

const TreeNodeContext = createContext<TreeNodeContextType | undefined>(
  undefined
);

const useTreeNode = () => {
  const context = useContext(TreeNodeContext);
  if (!context) {
    throw new Error("TreeNode components must be used within a TreeNode");
  }
  return context;
};

export type TreeProviderProps = {
  children: ReactNode;
  defaultExpandedIds?: string[];
  showLines?: boolean;
  showIcons?: boolean;
  selectable?: boolean;
  multiSelect?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  indent?: number;
  animateExpand?: boolean;
  className?: string;
};

export const TreeProvider = ({
  children,
  defaultExpandedIds = [],
  showLines = true,
  showIcons = true,
  selectable = true,
  multiSelect = false,
  selectedIds,
  onSelectionChange,
  indent = 20,
  animateExpand = true,
  className,
}: TreeProviderProps) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    new Set(defaultExpandedIds)
  );
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>(
    selectedIds ?? []
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const nodesRef = useRef<Map<string, NodeInfo>>(new Map());
  const nodeOrderRef = useRef<string[]>([]);

  const isControlled =
    selectedIds !== undefined && onSelectionChange !== undefined;
  const currentSelectedIds = isControlled ? selectedIds : internalSelectedIds;

  const registerNode = useCallback((nodeId: string, parentId: string | null, hasChildren: boolean) => {
    nodesRef.current.set(nodeId, { nodeId, parentId, hasChildren });
    if (!nodeOrderRef.current.includes(nodeId)) {
      nodeOrderRef.current.push(nodeId);
    }
  }, []);

  const unregisterNode = useCallback((nodeId: string) => {
    nodesRef.current.delete(nodeId);
    nodeOrderRef.current = nodeOrderRef.current.filter(id => id !== nodeId);
  }, []);

  const getNodeInfo = useCallback((nodeId: string) => {
    return nodesRef.current.get(nodeId);
  }, []);

  const getVisibleNodes = useCallback(() => {
    const visibleNodes: string[] = [];
    const traverse = (parentId: string | null) => {
      for (const nodeId of nodeOrderRef.current) {
        const info = nodesRef.current.get(nodeId);
        if (info && info.parentId === parentId) {
          visibleNodes.push(nodeId);
          if (info.hasChildren && expandedIds.has(nodeId)) {
            traverse(nodeId);
          }
        }
      }
    };
    traverse(null);
    return visibleNodes;
  }, [expandedIds]);

  const expandNode = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const newSet = new Set(prev);
      newSet.add(nodeId);
      return newSet;
    });
  }, []);

  const collapseNode = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const newSet = new Set(prev);
      newSet.delete(nodeId);
      return newSet;
    });
  }, []);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });
  }, []);

  const handleSelection = useCallback(
    (nodeId: string, ctrlKey = false) => {
      if (!selectable) {
        return;
      }

      let newSelection: string[];

      if (multiSelect && ctrlKey) {
        newSelection = currentSelectedIds.includes(nodeId)
          ? currentSelectedIds.filter((id) => id !== nodeId)
          : [...currentSelectedIds, nodeId];
      } else {
        newSelection = currentSelectedIds.includes(nodeId) ? [] : [nodeId];
      }

      if (isControlled) {
        onSelectionChange?.(newSelection);
      } else {
        setInternalSelectedIds(newSelection);
      }
    },
    [
      selectable,
      multiSelect,
      currentSelectedIds,
      isControlled,
      onSelectionChange,
    ]
  );

  return (
    <TreeContext.Provider
      value={{
        expandedIds,
        selectedIds: currentSelectedIds,
        focusedId,
        toggleExpanded,
        handleSelection,
        setFocusedId,
        registerNode,
        unregisterNode,
        getVisibleNodes,
        getNodeInfo,
        expandNode,
        collapseNode,
        showLines,
        showIcons,
        selectable,
        multiSelect,
        indent,
        animateExpand,
      }}
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={cn("w-full", className)}
        initial={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </TreeContext.Provider>
  );
};

export type TreeViewProps = HTMLAttributes<HTMLDivElement>;

export const TreeView = ({ className, children, ...props }: TreeViewProps) => (
  <div className={cn("py-2 h-full", className)} {...props}>
    {children}
  </div>
);

export type TreeNodeProps = HTMLAttributes<HTMLDivElement> & {
  nodeId?: string;
  level?: number;
  isLast?: boolean;
  parentPath?: boolean[];
  children?: ReactNode;
};

export const TreeNode = ({
  nodeId: providedNodeId,
  level = 0,
  isLast = false,
  parentPath = [],
  children,
  className,
  onClick,
  ...props
}: TreeNodeProps) => {
  const generatedId = useId();
  const nodeId = providedNodeId ?? generatedId;
  const { registerNode, unregisterNode } = useTree();
  const parentContext = useContext(TreeNodeContext);
  const parentId = parentContext?.nodeId ?? null;
  const [hasChildren, setHasChildren] = useState(false);

  // Register this node with the tree
  useEffect(() => {
    registerNode(nodeId, parentId, hasChildren);
    return () => unregisterNode(nodeId);
  }, [nodeId, parentId, hasChildren, registerNode, unregisterNode]);

  // Build the parent path - mark positions where the parent was the last child
  const currentPath = level === 0 ? [] : [...parentPath];
  if (level > 0 && parentPath.length < level - 1) {
    // Fill in missing levels with false (not last)
    while (currentPath.length < level - 1) {
      currentPath.push(false);
    }
  }
  if (level > 0) {
    currentPath[level - 1] = isLast;
  }

  return (
    <TreeNodeContext.Provider
      value={{
        nodeId,
        parentId,
        level,
        isLast,
        parentPath: currentPath,
        hasChildren,
        setHasChildren,
      }}
    >
      <div className={cn("select-none", className)} {...props}>
        {children}
      </div>
    </TreeNodeContext.Provider>
  );
};

export type TreeNodeTriggerProps = ComponentProps<typeof motion.div>;

export const TreeNodeTrigger = ({
  children,
  className,
  onClick,
  ...props
}: TreeNodeTriggerProps) => {
  const {
    selectedIds,
    toggleExpanded,
    handleSelection,
    indent,
    setFocusedId,
    getVisibleNodes,
    getNodeInfo,
    expandNode,
    collapseNode,
    expandedIds,
  } = useTree();
  const { nodeId, level, hasChildren, parentId } = useTreeNode();
  const isSelected = selectedIds.includes(nodeId);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Direct DOM focus - much faster than React state updates
  const focusNode = useCallback((targetNodeId: string) => {
    const element = document.querySelector(`[data-tree-node-id="${targetNodeId}"]`) as HTMLElement;
    if (element) {
      element.focus();
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const visibleNodes = getVisibleNodes();
    const currentIndex = visibleNodes.indexOf(nodeId);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const nextIndex = currentIndex + 1;
        if (nextIndex < visibleNodes.length) {
          const nextNodeId = visibleNodes[nextIndex];
          focusNode(nextNodeId);
          handleSelection(nextNodeId, false);
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prevIndex = currentIndex - 1;
        if (prevIndex >= 0) {
          const prevNodeId = visibleNodes[prevIndex];
          focusNode(prevNodeId);
          handleSelection(prevNodeId, false);
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (hasChildren) {
          if (!expandedIds.has(nodeId)) {
            // Expand the folder
            expandNode(nodeId);
          } else {
            // Already expanded, move to first child
            const nextIndex = currentIndex + 1;
            if (nextIndex < visibleNodes.length) {
              const nextNodeInfo = getNodeInfo(visibleNodes[nextIndex]);
              if (nextNodeInfo?.parentId === nodeId) {
                const nextNodeId = visibleNodes[nextIndex];
                focusNode(nextNodeId);
                handleSelection(nextNodeId, false);
              }
            }
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (hasChildren && expandedIds.has(nodeId)) {
          // Collapse the folder
          collapseNode(nodeId);
        } else if (parentId) {
          // Move to parent and select it
          focusNode(parentId);
          handleSelection(parentId, false);
        }
        break;
      }
    }
  }, [nodeId, hasChildren, parentId, getVisibleNodes, focusNode, expandNode, collapseNode, expandedIds, getNodeInfo, handleSelection]);

  return (
    <motion.div
      ref={triggerRef}
      tabIndex={0}
      data-tree-node-id={nodeId}
      className={cn(
        "group relative flex cursor-pointer items-center rounded-md px-3 py-1 outline-none",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "focus:bg-sidebar-accent focus:text-sidebar-accent-foreground",
        isSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
        className
      )}
      onClick={(e) => {
        setFocusedId(nodeId);
        toggleExpanded(nodeId);
        handleSelection(nodeId, e.ctrlKey || e.metaKey);
        onClick?.(e);
      }}
      onFocus={() => setFocusedId(nodeId)}
      onKeyDown={handleKeyDown}
      style={{ paddingLeft: level * (indent ?? 0) + 8 }}
      whileTap={{ scale: 0.98, transition: { duration: 0.1 } }}
      {...props}
    >
      <TreeLines />
      {children as ReactNode}
    </motion.div>
  );
};

export const TreeLines = () => {
  const { showLines, indent } = useTree();
  const { level, isLast, parentPath } = useTreeNode();

  if (!showLines || level === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute top-0 bottom-0 left-0">
      {/* Render vertical lines for all parent levels */}
      {Array.from({ length: level }, (_, index) => {
        const shouldHideLine = parentPath[index] === true;
        if (shouldHideLine && index === level - 1) {
          return null;
        }

        return (
          <div
            className="absolute top-0 bottom-0 border-border/40 border-l"
            key={index.toString()}
            style={{
              left: index * (indent ?? 0) + 12,
              display: shouldHideLine ? "none" : "block",
            }}
          />
        );
      })}

      {/* Horizontal connector line */}
      <div
        className="absolute top-1/2 border-border/40 border-t"
        style={{
          left: (level - 1) * (indent ?? 0) + 12,
          width: (indent ?? 0) - 4,
          transform: "translateY(-1px)",
        }}
      />

      {/* Vertical line to midpoint for last items */}
      {isLast && (
        <div
          className="absolute top-0 border-border/40 border-l"
          style={{
            left: (level - 1) * (indent ?? 0) + 12,
            height: "50%",
          }}
        />
      )}
    </div>
  );
};

export type TreeNodeContentProps = ComponentProps<typeof motion.div> & {
  hasChildren?: boolean;
};

export const TreeNodeContent = ({
  children,
  hasChildren: hasChildrenProp = false,
  className,
  ...props
}: TreeNodeContentProps) => {
  const { animateExpand, expandedIds } = useTree();
  const { nodeId, setHasChildren } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  // Update parent node's hasChildren state
  useEffect(() => {
    if (hasChildrenProp) {
      setHasChildren(true);
    }
  }, [hasChildrenProp, setHasChildren]);

  return (
    <AnimatePresence>
      {hasChildrenProp && isExpanded && (
        <motion.div
          animate={{ height: "auto", opacity: 1 }}
          className="overflow-hidden"
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          transition={{
            duration: animateExpand ? 0.3 : 0,
            ease: "easeInOut",
          }}
        >
          <motion.div
            animate={{ y: 0 }}
            className={className}
            exit={{ y: -10 }}
            initial={{ y: -10 }}
            transition={{
              duration: animateExpand ? 0.2 : 0,
              delay: animateExpand ? 0.1 : 0,
            }}
            {...props}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export type TreeExpanderProps = ComponentProps<typeof motion.div> & {
  hasChildren?: boolean;
};

export const TreeExpander = ({
  hasChildren: hasChildrenProp = false,
  className,
  onClick,
  ...props
}: TreeExpanderProps) => {
  const { expandedIds, toggleExpanded } = useTree();
  const { nodeId, setHasChildren } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  // Update parent node's hasChildren state
  useEffect(() => {
    if (hasChildrenProp) {
      setHasChildren(true);
    }
  }, [hasChildrenProp, setHasChildren]);

  if (!hasChildrenProp) {
    return <div className="mr-1 h-4 w-4" />;
  }

  return (
    <motion.div
      animate={{ rotate: isExpanded ? 90 : 0 }}
      className={cn(
        "mr-1 flex h-4 w-4 cursor-pointer items-center justify-center",
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        toggleExpanded(nodeId);
        onClick?.(e);
      }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      {...props}
    >
      <ChevronRight className="h-3 w-3 text-muted-foreground" />
    </motion.div>
  );
};

export type TreeIconProps = ComponentProps<typeof motion.div> & {
  icon?: ReactNode;
  hasChildren?: boolean;
};

export const TreeIcon = ({
  icon,
  hasChildren = false,
  className,
  ...props
}: TreeIconProps) => {
  const { showIcons, expandedIds } = useTree();
  const { nodeId } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  if (!showIcons) {
    return null;
  }

  const getDefaultIcon = () =>
    hasChildren ? (
      isExpanded ? (
        <FolderOpen className="h-4 w-4" />
      ) : (
        <Folder className="h-4 w-4" />
      )
    ) : (
      <File className="h-4 w-4" />
    );

  return (
    <motion.div
      className={cn(
        "mr-2 flex h-4 w-4 items-center justify-center text-muted-foreground",
        className
      )}
      transition={{ duration: 0.15 }}
      whileHover={{ scale: 1.1 }}
      {...props}
    >
      {icon || getDefaultIcon()}
    </motion.div>
  );
};

export type TreeLabelProps = HTMLAttributes<HTMLSpanElement>;

export const TreeLabel = ({ className, ...props }: TreeLabelProps) => (
  <span className={cn("font flex-1 truncate text-sm", className)} {...props} />
);
