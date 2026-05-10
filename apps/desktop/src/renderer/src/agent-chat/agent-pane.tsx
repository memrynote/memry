export function AgentPane(): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col bg-sidebar" aria-label="Agent chat">
      <div className="border-b border-sidebar-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Agent chat</h2>
      </div>
      <div className="min-h-0 flex-1" />
    </section>
  )
}

export default AgentPane
