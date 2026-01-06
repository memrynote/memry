"use client";

import { ChevronRight, File, Folder, FolderOpen, Palette } from "lucide-react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconPicker, getIconByName } from "@/components/icon-picker";

type NodeInfo = {
  nodeId: string;
  parentId: string | null;
  hasChildren: boolean;
  customIcon?: string;
  inheritedIcon?: string;
};

export type DropPosition = "before" | "after" | "inside";

export type DragState = {
  draggedId: string | null;
  dropTargetId: string | null;
  dropPosition: DropPosition | null;
};

export type MoveOperation = {
  draggedId: string;
  targetId: string;
  position: DropPosition;
};

export type IconChangeOperation = {
  nodeId: string;
  iconName: string | null;
  hasChildren: boolean;
};

type TreeContextType = {
  expandedIds: Set<string>;
  selectedIds: string[];
  focusedId: string | null;
  dragState: DragState;
  toggleExpanded: (nodeId: string) => void;
  handleSelection: (nodeId: string, ctrlKey: boolean, shiftKey?: boolean) => void;
  setFocusedId: (nodeId: string | null) => void;
  registerNode: (nodeId: string, parentId: string | null, hasChildren: boolean, customIcon?: string, inheritedIcon?: string) => void;
  unregisterNode: (nodeId: string) => void;
  getVisibleNodes: () => string[];
  getNodeInfo: (nodeId: string) => NodeInfo | undefined;
  expandNode: (nodeId: string) => void;
  collapseNode: (nodeId: string) => void;
  setDragState: (state: Partial<DragState>) => void;
  handleDrop: () => void;
  setNodeIcon: (nodeId: string, iconName: string | null) => void;
  getEffectiveIcon: (nodeId: string) => string | undefined;
  draggable?: boolean;
  onMove?: (operation: MoveOperation) => void;
  onIconChange?: (operation: IconChangeOperation) => void;
  showLines?: boolean;
  showIcons?: boolean;
  selectable?: boolean;
  multiSelect?: boolean;
  indent?: number;
  animateExpand?: boolean;
};

const TreeContext = createContext<TreeContextType | undefined>(undefined);

export const useTree = () => {
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
  customIcon?: string;
  inheritedIcon?: string;
  setCustomIcon: (iconName: string | undefined) => void;
  setInheritedIcon: (iconName: string | undefined) => void;
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
  draggable?: boolean;
  onMove?: (operation: MoveOperation) => void;
  onIconChange?: (operation: IconChangeOperation) => void;
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
  draggable = false,
  onMove,
  onIconChange,
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
  const [anchorId, setAnchorId] = useState<string | null>(null); // For shift+click range selection
  const [dragState, setDragStateInternal] = useState<DragState>({
    draggedId: null,
    dropTargetId: null,
    dropPosition: null,
  });
  const nodesRef = useRef<Map<string, NodeInfo>>(new Map());
  const nodeOrderRef = useRef<string[]>([]);
  // İkon state'i için re-render tetiklemek için
  const [iconVersion, setIconVersion] = useState(0);

  const isControlled =
    selectedIds !== undefined && onSelectionChange !== undefined;
  const currentSelectedIds = isControlled ? selectedIds : internalSelectedIds;

  const setDragState = useCallback((state: Partial<DragState>) => {
    setDragStateInternal((prev) => ({ ...prev, ...state }));
  }, []);

  const handleDrop = useCallback(() => {
    const { draggedId, dropTargetId, dropPosition } = dragState;

    if (draggedId && dropTargetId && dropPosition && onMove) {
      onMove({
        draggedId,
        targetId: dropTargetId,
        position: dropPosition,
      });
    }

    setDragStateInternal({
      draggedId: null,
      dropTargetId: null,
      dropPosition: null,
    });
  }, [dragState, onMove]);

  const registerNode = useCallback((nodeId: string, parentId: string | null, hasChildren: boolean, customIcon?: string, inheritedIcon?: string) => {
    nodesRef.current.set(nodeId, { nodeId, parentId, hasChildren, customIcon, inheritedIcon });
    if (!nodeOrderRef.current.includes(nodeId)) {
      nodeOrderRef.current.push(nodeId);
    }
  }, []);

  const unregisterNode = useCallback((nodeId: string) => {
    nodesRef.current.delete(nodeId);
    nodeOrderRef.current = nodeOrderRef.current.filter(id => id !== nodeId);
  }, []);

  // Node'a ikon atama ve child'lara inheritance
  const setNodeIcon = useCallback((nodeId: string, iconName: string | null) => {
    const nodeInfo = nodesRef.current.get(nodeId);
    if (!nodeInfo) return;

    // Node'un kendi ikonunu güncelle
    nodeInfo.customIcon = iconName || undefined;
    nodesRef.current.set(nodeId, nodeInfo);

    // Eğer bu bir klasörse, tüm child'lara inheritedIcon olarak yay
    if (nodeInfo.hasChildren) {
      const updateChildrenInheritedIcon = (parentId: string, inheritedIcon: string | undefined) => {
        for (const [childId, childInfo] of nodesRef.current.entries()) {
          if (childInfo.parentId === parentId) {
            // Child'ın kendi customIcon'u yoksa inherited'ı güncelle
            childInfo.inheritedIcon = inheritedIcon;
            nodesRef.current.set(childId, childInfo);
            // Recursive olarak alt child'ları da güncelle
            if (childInfo.hasChildren) {
              // Child'ın kendi customIcon'u varsa, onun child'larına kendi ikonunu yay
              // Yoksa parent'tan gelen inherited'ı yay
              const iconToPass = childInfo.customIcon || inheritedIcon;
              updateChildrenInheritedIcon(childId, iconToPass);
            }
          }
        }
      };
      updateChildrenInheritedIcon(nodeId, iconName || undefined);
    }

    // Re-render tetikle
    setIconVersion(v => v + 1);

    // Callback'i çağır
    if (onIconChange) {
      onIconChange({
        nodeId,
        iconName,
        hasChildren: nodeInfo.hasChildren,
      });
    }
  }, [onIconChange]);

  // Bir node için efektif ikonu al (customIcon > inheritedIcon > undefined)
  const getEffectiveIcon = useCallback((nodeId: string): string | undefined => {
    const nodeInfo = nodesRef.current.get(nodeId);
    if (!nodeInfo) return undefined;
    return nodeInfo.customIcon || nodeInfo.inheritedIcon;
  }, [iconVersion]); // iconVersion dependency ile güncel kalır

  const getNodeInfo = useCallback((nodeId: string) => {
    return nodesRef.current.get(nodeId);
  }, []);

  const getVisibleNodes = useCallback(() => {
    // Query DOM for nodes in visual order instead of registration order
    // This ensures shift+click selection works correctly for both folders and files
    const treeElement = document.querySelector('[data-tree-view]');
    if (!treeElement) return [];

    const nodeElements = treeElement.querySelectorAll('[data-tree-node-id]');
    const visibleNodes: string[] = [];

    for (const el of nodeElements) {
      const nodeId = el.getAttribute('data-tree-node-id');
      if (nodeId) {
        visibleNodes.push(nodeId);
      }
    }

    return visibleNodes;
  }, []);

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
    (nodeId: string, ctrlKey = false, shiftKey = false) => {
      if (!selectable) {
        return;
      }

      let newSelection: string[];

      if (multiSelect && shiftKey && anchorId) {
        // Shift+click: select range from anchor to clicked item
        const visibleNodes = getVisibleNodes();
        const anchorIndex = visibleNodes.indexOf(anchorId);
        const clickedIndex = visibleNodes.indexOf(nodeId);

        if (anchorIndex !== -1 && clickedIndex !== -1) {
          const start = Math.min(anchorIndex, clickedIndex);
          const end = Math.max(anchorIndex, clickedIndex);
          newSelection = visibleNodes.slice(start, end + 1);
        } else {
          newSelection = [nodeId];
        }
        // Don't update anchor on shift+click
      } else if (multiSelect && ctrlKey) {
        // Cmd/Ctrl+click: toggle individual item
        newSelection = currentSelectedIds.includes(nodeId)
          ? currentSelectedIds.filter((id) => id !== nodeId)
          : [...currentSelectedIds, nodeId];
        // Update anchor to last clicked item
        setAnchorId(nodeId);
      } else {
        // Regular click: select only this item
        newSelection = [nodeId];
        // Update anchor
        setAnchorId(nodeId);
      }

      if (isControlled) {
        onSelectionChange?.(newSelection);
      } else {
        setInternalSelectedIds(newSelection);
        // Always call onSelectionChange callback if provided
        onSelectionChange?.(newSelection);
      }
    },
    [
      selectable,
      multiSelect,
      currentSelectedIds,
      isControlled,
      onSelectionChange,
      anchorId,
      getVisibleNodes,
    ]
  );

  return (
    <TreeContext.Provider
      value={{
        expandedIds,
        selectedIds: currentSelectedIds,
        focusedId,
        dragState,
        toggleExpanded,
        handleSelection,
        setFocusedId,
        registerNode,
        unregisterNode,
        getVisibleNodes,
        getNodeInfo,
        expandNode,
        collapseNode,
        setDragState,
        handleDrop,
        setNodeIcon,
        getEffectiveIcon,
        draggable,
        onMove,
        onIconChange,
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
  <div className={cn("py-2 h-full", className)} data-tree-view {...props}>
    {children}
  </div>
);

export type TreeNodeProps = HTMLAttributes<HTMLDivElement> & {
  nodeId?: string;
  level?: number;
  isLast?: boolean;
  parentPath?: boolean[];
  children?: ReactNode;
  customIcon?: string;
  inheritedIcon?: string;
};

export const TreeNode = ({
  nodeId: providedNodeId,
  level = 0,
  isLast = false,
  parentPath = [],
  children,
  className,
  onClick,
  customIcon: initialCustomIcon,
  inheritedIcon: initialInheritedIcon,
  ...props
}: TreeNodeProps) => {
  const generatedId = useId();
  const nodeId = providedNodeId ?? generatedId;
  const { registerNode, unregisterNode } = useTree();
  const parentContext = useContext(TreeNodeContext);
  const parentId = parentContext?.nodeId ?? null;
  const [hasChildren, setHasChildren] = useState(false);
  const [customIcon, setCustomIcon] = useState<string | undefined>(initialCustomIcon);
  const [inheritedIcon, setInheritedIcon] = useState<string | undefined>(initialInheritedIcon);

  // Parent'tan inherited icon'u al
  useEffect(() => {
    if (parentContext?.customIcon) {
      setInheritedIcon(parentContext.customIcon);
    } else if (parentContext?.inheritedIcon) {
      setInheritedIcon(parentContext.inheritedIcon);
    }
  }, [parentContext?.customIcon, parentContext?.inheritedIcon]);

  // Register this node with the tree
  useEffect(() => {
    registerNode(nodeId, parentId, hasChildren, customIcon, inheritedIcon);
    return () => unregisterNode(nodeId);
  }, [nodeId, parentId, hasChildren, customIcon, inheritedIcon, registerNode, unregisterNode]);

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
        customIcon,
        inheritedIcon,
        setCustomIcon,
        setInheritedIcon,
      }}
    >
      <div className={cn("select-none", className)} {...props}>
        {children}
      </div>
    </TreeNodeContext.Provider>
  );
};

export type TreeNodeTriggerProps = ComponentProps<typeof motion.div> & {
  /** Custom context menu content to render instead of the default "Set Icon" menu */
  contextMenuContent?: ReactNode;
  /** Whether to show the default icon context menu (default: true) */
  showIconMenu?: boolean;
};

export const TreeNodeTrigger = ({
  children,
  className,
  onClick,
  contextMenuContent,
  showIconMenu = true,
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
    draggable,
    dragState,
    setDragState,
    handleDrop,
    setNodeIcon,
    getEffectiveIcon,
  } = useTree();
  const { nodeId, level, hasChildren, parentId, customIcon } = useTreeNode();
  const isSelected = selectedIds.includes(nodeId);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Icon Picker state
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false);
  const [iconPickerPosition, setIconPickerPosition] = useState<{ x: number; y: number } | undefined>();

  const isDragging = dragState.draggedId === nodeId;
  const isDropTarget = dragState.dropTargetId === nodeId;
  const dropPosition = isDropTarget ? dragState.dropPosition : null;

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

  // Drag event handlers
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!draggable) return;

    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", nodeId);
    setDragState({ draggedId: nodeId });
  }, [draggable, nodeId, setDragState]);

  const handleDragEnd = useCallback(() => {
    setDragState({ draggedId: null, dropTargetId: null, dropPosition: null });
  }, [setDragState]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!draggable || dragState.draggedId === nodeId) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const y = e.clientY - rect.top;
    const height = rect.height;
    const threshold = height / 3;

    let position: DropPosition;
    if (y < threshold) {
      position = "before";
    } else if (y > height - threshold) {
      position = "after";
    } else {
      position = hasChildren ? "inside" : "after";
    }

    setDragState({ dropTargetId: nodeId, dropPosition: position });
  }, [draggable, dragState.draggedId, nodeId, hasChildren, setDragState]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!triggerRef.current?.contains(relatedTarget)) {
      setDragState({ dropTargetId: null, dropPosition: null });
    }
  }, [setDragState]);

  const handleDropEvent = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleDrop();
  }, [handleDrop]);

  // Icon picker handlers
  const handleSetIconClick = useCallback((e: React.MouseEvent) => {
    // Context menu'nun kapanmasını bekle, sonra icon picker'ı aç
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setIconPickerPosition({ x: rect.right + 8, y: rect.top });
    } else {
      setIconPickerPosition({ x: e.clientX, y: e.clientY });
    }
    // Kısa bir gecikme ile aç (context menu kapanması için)
    setTimeout(() => {
      setIsIconPickerOpen(true);
    }, 100);
  }, []);

  const handleIconSelect = useCallback((iconName: string) => {
    setNodeIcon(nodeId, iconName || null);
    setIsIconPickerOpen(false);
  }, [nodeId, setNodeIcon]);

  const handleIconPickerClose = useCallback(() => {
    setIsIconPickerOpen(false);
  }, []);

  const effectiveIcon = getEffectiveIcon(nodeId);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <motion.div
            ref={triggerRef}
            tabIndex={0}
            data-tree-node-id={nodeId}
            draggable={draggable}
            className={cn(
              "group relative flex cursor-pointer items-center rounded-md px-3 py-1 outline-none",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              "focus:bg-sidebar-accent focus:text-sidebar-accent-foreground",
              isSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
              isDragging && "opacity-50",
              draggable && "cursor-default",
              className
            )}
            onClick={(e) => {
              setFocusedId(nodeId);
              toggleExpanded(nodeId);
              handleSelection(nodeId, e.ctrlKey || e.metaKey, e.shiftKey);
              onClick?.(e);
            }}
            onFocus={() => setFocusedId(nodeId)}
            onKeyDown={handleKeyDown}
            onDragStartCapture={handleDragStart as unknown as React.DragEventHandler}
            onDragEndCapture={handleDragEnd}
            onDragOverCapture={handleDragOver as unknown as React.DragEventHandler}
            onDragLeaveCapture={handleDragLeave as unknown as React.DragEventHandler}
            onDropCapture={handleDropEvent as unknown as React.DragEventHandler}
            style={{ paddingLeft: level * (indent ?? 0) + 8 }}

            {...props}
          >
            {/* Drop indicator - before */}
            {isDropTarget && dropPosition === "before" && (
              <div
                className="absolute left-2 right-2 -top-0.5 h-0.5 rounded-full bg-primary"
                aria-hidden="true"
              />
            )}

            {/* Drop indicator - after */}
            {isDropTarget && dropPosition === "after" && (
              <div
                className="absolute left-2 right-2 -bottom-0.5 h-0.5 rounded-full bg-primary"
                aria-hidden="true"
              />
            )}

            {/* Drop indicator - inside (for folders) */}
            {isDropTarget && dropPosition === "inside" && (
              <div
                className="absolute inset-0 rounded-md border-2 border-primary border-dashed bg-primary/10"
                aria-hidden="true"
              />
            )}

            <TreeLines />
            {children as ReactNode}
          </motion.div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {contextMenuContent ? (
            // Use custom context menu content
            contextMenuContent
          ) : showIconMenu ? (
            // Default icon menu
            <>
              <ContextMenuItem onClick={handleSetIconClick}>
                <Palette className="mr-2 h-4 w-4" />
                Set Icon
              </ContextMenuItem>
              {effectiveIcon && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => setNodeIcon(nodeId, null)}
                    className="text-destructive focus:text-destructive"
                  >
                    Clear Icon
                  </ContextMenuItem>
                </>
              )}
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Icon Picker Popover */}
      <IconPicker
        isOpen={isIconPickerOpen}
        onClose={handleIconPickerClose}
        onSelect={handleIconSelect}
        position={iconPickerPosition}
        currentIcon={customIcon}
      />
    </>
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
            className="absolute top-0 bottom-0 border-border border-l"
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
        className="absolute top-1/2 border-border border-t"
        style={{
          left: (level - 1) * (indent ?? 0) + 12,
          width: (indent ?? 0) - 4,
          transform: "translateY(-1px)",
        }}
      />

      {/* Vertical line to midpoint for last items */}
      {isLast && (
        <div
          className="absolute top-0 border-border border-l"
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
            duration: animateExpand ? 0.1 : 0,
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
  iconName?: string;
};

export const TreeIcon = ({
  icon,
  hasChildren = false,
  iconName,
  className,
  ...props
}: TreeIconProps) => {
  const { showIcons, expandedIds, getEffectiveIcon } = useTree();
  const { nodeId, customIcon, inheritedIcon } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  if (!showIcons) {
    return null;
  }

  // Öncelik: prop olarak verilen iconName > customIcon > inheritedIcon > getEffectiveIcon > default
  const effectiveIconName = iconName || customIcon || inheritedIcon || getEffectiveIcon(nodeId);

  const getIconComponent = () => {
    // Eğer bir ikon adı varsa, lucide'dan al
    if (effectiveIconName) {
      const IconComponent = getIconByName(effectiveIconName);
      if (IconComponent) {
        return <IconComponent className="h-4 w-4" />;
      }
    }

    // Prop olarak verilen icon varsa onu kullan
    if (icon) {
      return icon;
    }

    // Default ikonlar
    return hasChildren ? (
      isExpanded ? (
        <FolderOpen className="h-4 w-4" />
      ) : (
        <Folder className="h-4 w-4" />
      )
    ) : (
      <File className="h-4 w-4" />
    );
  };

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
      {getIconComponent()}
    </motion.div>
  );
};

export type TreeLabelProps = HTMLAttributes<HTMLSpanElement>;

export const TreeLabel = ({ className, ...props }: TreeLabelProps) => (
  <span className={cn("font flex-1 truncate text-sm", className)} {...props} />
);
