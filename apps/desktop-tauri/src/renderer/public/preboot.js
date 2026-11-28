// The migration view of preboot.html (`src-tauri/src/migration`). The shell fills the button
// labels, then calls `memryMigration.start()`, which asks `migration_status` for the state; later
// states arrive through `memryMigration.update(status)`. Every string lands in `textContent`. The
// startup-error window loads this file too and never calls `start()`, so it invokes nothing.
;(() => {
  const root = document.documentElement
  const slot = (name) => document.querySelector(`.migration [data-slot='${name}']`)
  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command)
  let shownSeq = 0
  let shownState = 'idle'

  function setText(name, value) {
    const element = slot(name)
    element.textContent = value || ''
    element.hidden = !value
  }

  function setBusy(busy) {
    slot('retry').disabled = busy
    slot('show-details').disabled = busy
  }

  // An answer older than an update already shown is dropped, so the bar never moves back.
  function update(status) {
    if (!status || status.seq <= shownSeq) return
    shownSeq = status.seq
    const previous = shownState
    shownState = status.state
    root.dataset.state = status.state
    setText('title', status.title)
    setText('phase', status.state === 'running' ? status.phase : null)
    setText('body', status.body)
    setText('note', status.note)
    setText('check-line', status.checkLine)
    setText('details', status.details)
    const bar = document.querySelector('.migration .bar')
    bar.setAttribute('aria-valuenow', String(status.percent))
    bar.querySelector('.fill').style.inlineSize = `${status.percent}%`
    setBusy(status.state !== 'failed')
    if (status.state !== 'failed') slot('report-missing').hidden = true
    if (status.state === 'failed' && previous !== 'failed') slot('retry').focus()
  }

  function start() {
    invoke('migration_status').then(update, (error) =>
      console.warn('[migration] status not read:', error)
    )
  }

  function retry() {
    setBusy(true)
    invoke('migration_retry').catch((error) => {
      console.warn('[migration] not retried:', error)
      setBusy(shownState !== 'failed')
    })
  }

  function openReport() {
    slot('report-missing').hidden = true
    invoke('migration_open_report').catch(() => {
      slot('report-missing').hidden = false
    })
  }

  slot('retry').addEventListener('click', retry)
  slot('show-details').addEventListener('click', openReport)
  window.memryMigration = { start, update }
})()
