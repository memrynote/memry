const button = document.getElementById('capture-page')
const status = document.getElementById('status')

button.addEventListener('click', () => {
  status.textContent = ''
  button.disabled = true

  chrome.runtime.sendMessage({ type: 'capture-current-page' }, (response) => {
    button.disabled = false

    if (response?.ok) {
      status.textContent = 'Captured'
      return
    }

    status.textContent = response?.error || 'Capture failed'
  })
})
