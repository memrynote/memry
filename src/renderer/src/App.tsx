import { useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { InboxPage } from "@/pages/inbox"
import { TasksPage } from "@/pages/tasks"

export type AppPage = "inbox" | "home" | "today" | "tasks"

const pageTitles: Record<AppPage, string> = {
  inbox: "Inbox",
  home: "Home",
  today: "Today",
  tasks: "Tasks",
}

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<AppPage>("inbox")

  const handleNavigate = (page: AppPage): void => {
    setCurrentPage(page)
  }

  const renderPage = (): React.JSX.Element => {
    switch (currentPage) {
      case "tasks":
        return <TasksPage />
      case "inbox":
      default:
        return <InboxPage />
    }
  }

  // Tasks page has its own header, so we render it differently
  const isTasksPage = currentPage === "tasks"

  return (
    <>
      <SidebarProvider>
        <AppSidebar currentPage={currentPage} onNavigate={handleNavigate} />
        <SidebarInset>
          {!isTasksPage && (
            <header className="drag-region flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex items-center gap-2 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-[orientation=vertical]:h-4"
                />
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink href="#">
                        Building Your Application
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{pageTitles[currentPage]}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
          )}
          <div className={isTasksPage ? "flex flex-1 flex-col" : "flex flex-1 flex-col gap-4 p-4 pt-0"}>
            {renderPage()}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </>
  )
}

export default App
