"use client";

import {
    TreeExpander,
    TreeIcon,
    TreeLabel,
    TreeNode,
    TreeNodeContent,
    TreeNodeTrigger,
    TreeProvider,
    TreeView,
    type MoveOperation,
    type IconChangeOperation,
} from "@/components/kibo-ui/tree";
import { useTabs } from "@/contexts/tabs";
import { FileText, BookOpen, Lightbulb, Code, Coffee, Rocket, Target } from "lucide-react";

export default function FileTree() {
    const { openTab } = useTabs();

    const handleMove = (operation: MoveOperation) => {
        console.log("Move operation:", {
            draggedId: operation.draggedId,
            targetId: operation.targetId,
            position: operation.position,
        });
    };

    const handleIconChange = (operation: IconChangeOperation) => {
        console.log("Icon change:", {
            nodeId: operation.nodeId,
            iconName: operation.iconName,
            hasChildren: operation.hasChildren,
        });
    };

    // Navigate to note page when a note item is selected
    const handleSelectionChange = (ids: string[]) => {
        console.log("Selected:", ids);
        if (ids.length > 0) {
            const selectedId = ids[0];
            // Open the note in a tab
            openTab({
                type: 'note',
                title: selectedId,
                icon: 'file-text',
                path: `/notes/${selectedId}`,
                entityId: selectedId,
                isPinned: false,
                isModified: false,
                isPreview: true,
                isDeleted: false,
            });
        }
    };

    return (
        <TreeProvider
            onSelectionChange={handleSelectionChange}
            onMove={handleMove}
            onIconChange={handleIconChange}
            draggable={true}
            animateExpand={true}
            multiSelect={false}
            indent={16}
        >
            <TreeView>
                {/* Projects Folder */}
                <TreeNode nodeId="projects">
                    <TreeNodeTrigger>
                        <TreeExpander hasChildren />
                        <TreeIcon hasChildren />
                        <TreeLabel>Projects</TreeLabel>
                    </TreeNodeTrigger>
                    <TreeNodeContent hasChildren>
                        <TreeNode level={1} nodeId="memry-app">
                            <TreeNodeTrigger>
                                <TreeExpander hasChildren />
                                <TreeIcon hasChildren />
                                <TreeLabel>Memry App</TreeLabel>
                            </TreeNodeTrigger>
                            <TreeNodeContent hasChildren>
                                <TreeNode level={2} nodeId="Architecture Overview">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<Code className="h-4 w-4" />} />
                                        <TreeLabel>Architecture Overview</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode level={2} nodeId="Feature Roadmap">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<Rocket className="h-4 w-4" />} />
                                        <TreeLabel>Feature Roadmap</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode isLast level={2} nodeId="Tech Stack Notes">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<FileText className="h-4 w-4" />} />
                                        <TreeLabel>Tech Stack Notes</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                            </TreeNodeContent>
                        </TreeNode>
                        <TreeNode isLast level={1} nodeId="side-projects">
                            <TreeNodeTrigger>
                                <TreeExpander hasChildren />
                                <TreeIcon hasChildren />
                                <TreeLabel>Side Projects</TreeLabel>
                            </TreeNodeTrigger>
                            <TreeNodeContent hasChildren>
                                <TreeNode level={2} nodeId="CLI Tool Ideas">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<Lightbulb className="h-4 w-4" />} />
                                        <TreeLabel>CLI Tool Ideas</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode isLast level={2} nodeId="Learning Goals 2024">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<Target className="h-4 w-4" />} />
                                        <TreeLabel>Learning Goals 2024</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                            </TreeNodeContent>
                        </TreeNode>
                    </TreeNodeContent>
                </TreeNode>

                {/* Notes Folder */}
                <TreeNode nodeId="notes">
                    <TreeNodeTrigger>
                        <TreeExpander hasChildren />
                        <TreeIcon hasChildren />
                        <TreeLabel>Notes</TreeLabel>
                    </TreeNodeTrigger>
                    <TreeNodeContent hasChildren>
                        <TreeNode level={1} nodeId="daily">
                            <TreeNodeTrigger>
                                <TreeExpander hasChildren />
                                <TreeIcon hasChildren />
                                <TreeLabel>Daily</TreeLabel>
                            </TreeNodeTrigger>
                            <TreeNodeContent hasChildren>
                                <TreeNode level={2} nodeId="2024-12-10">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<BookOpen className="h-4 w-4" />} />
                                        <TreeLabel>2024-12-10</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode level={2} nodeId="2024-12-09">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<BookOpen className="h-4 w-4" />} />
                                        <TreeLabel>2024-12-09</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode isLast level={2} nodeId="2024-12-08">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<BookOpen className="h-4 w-4" />} />
                                        <TreeLabel>2024-12-08</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                            </TreeNodeContent>
                        </TreeNode>
                        <TreeNode isLast level={1} nodeId="ideas">
                            <TreeNodeTrigger>
                                <TreeExpander hasChildren />
                                <TreeIcon hasChildren />
                                <TreeLabel>Ideas</TreeLabel>
                            </TreeNodeTrigger>
                            <TreeNodeContent hasChildren>
                                <TreeNode level={2} nodeId="Product Ideas">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<Lightbulb className="h-4 w-4" />} />
                                        <TreeLabel>Product Ideas</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                                <TreeNode isLast level={2} nodeId="Blog Post Drafts">
                                    <TreeNodeTrigger>
                                        <TreeExpander />
                                        <TreeIcon icon={<FileText className="h-4 w-4" />} />
                                        <TreeLabel>Blog Post Drafts</TreeLabel>
                                    </TreeNodeTrigger>
                                </TreeNode>
                            </TreeNodeContent>
                        </TreeNode>
                    </TreeNodeContent>
                </TreeNode>

                {/* Quick Notes */}
                <TreeNode nodeId="quick-notes">
                    <TreeNodeTrigger>
                        <TreeExpander hasChildren />
                        <TreeIcon hasChildren />
                        <TreeLabel>Quick Notes</TreeLabel>
                    </TreeNodeTrigger>
                    <TreeNodeContent hasChildren>
                        <TreeNode level={1} nodeId="Meeting Notes">
                            <TreeNodeTrigger>
                                <TreeExpander />
                                <TreeIcon icon={<Coffee className="h-4 w-4" />} />
                                <TreeLabel>Meeting Notes</TreeLabel>
                            </TreeNodeTrigger>
                        </TreeNode>
                        <TreeNode isLast level={1} nodeId="Todo List">
                            <TreeNodeTrigger>
                                <TreeExpander />
                                <TreeIcon icon={<Target className="h-4 w-4" />} />
                                <TreeLabel>Todo List</TreeLabel>
                            </TreeNodeTrigger>
                        </TreeNode>
                    </TreeNodeContent>
                </TreeNode>
            </TreeView>
        </TreeProvider>
    );
}
