"use client"

import * as React from "react"
import { FolderOpen, Sparkles, FileText, Clock, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useVault, useVaultList } from "@/hooks/use-vault"

export function VaultOnboarding() {
  const { selectVault, isLoading, error, switchVault } = useVault()
  const { vaults } = useVaultList()

  const handleSelectVault = async () => {
    await selectVault()
  }

  const handleOpenRecentVault = async (path: string) => {
    await switchVault(path)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="w-full max-w-lg mx-4">
        {/* Logo and welcome */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-500 text-white mb-4 shadow-lg shadow-indigo-500/30">
            <Sparkles className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Welcome to Memry
          </h1>
          <p className="text-gray-600">
            Your personal knowledge management system.
            <br />
            Select a folder to store your notes and tasks.
          </p>
        </div>

        {/* Main action card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200/50 p-6 mb-4">
          <Button
            onClick={handleSelectVault}
            disabled={isLoading}
            className="w-full h-14 text-base bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-500/25 transition-all hover:shadow-xl hover:shadow-indigo-500/30"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Opening...
              </>
            ) : (
              <>
                <FolderOpen className="w-5 h-5 mr-2" />
                Select Vault Folder
              </>
            )}
          </Button>

          {error && (
            <p className="mt-3 text-sm text-red-500 text-center">{error}</p>
          )}

          {/* Features */}
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
              <FileText className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-gray-900">Plain Markdown</p>
                <p className="text-xs text-gray-500">Your notes stay portable</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
              <Clock className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-gray-900">Sync Anywhere</p>
                <p className="text-xs text-gray-500">Use Dropbox, iCloud, Git</p>
              </div>
            </div>
          </div>
        </div>

        {/* Recent vaults */}
        {vaults.length > 0 && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-200/50 p-4">
            <h3 className="text-sm font-medium text-gray-500 mb-3 px-2">
              Recent Vaults
            </h3>
            <div className="space-y-1">
              {vaults.slice(0, 3).map((vault) => (
                <button
                  key={vault.path}
                  onClick={() => handleOpenRecentVault(vault.path)}
                  disabled={isLoading}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left group"
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 group-hover:bg-indigo-100 transition-colors">
                    <FolderOpen className="w-5 h-5 text-gray-500 group-hover:text-indigo-500 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">
                      {vault.name}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {vault.noteCount} notes · Last opened{" "}
                      {formatRelativeTime(vault.lastOpened)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString()
}
