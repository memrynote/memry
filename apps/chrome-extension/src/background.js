import {
  MEMRY_NATIVE_HOST,
  createClipCapture,
  createEnvelope,
  createLinkCapture,
  createPageCapture,
  filenameFromUrl,
  isProbablyFileUrl,
  mimeTypeFromUrl,
  responseToFileCapture
} from './capture.js'

const MENU_IDS = {
  page: 'memry-capture-page',
  selection: 'memry-capture-selection',
  link: 'memry-capture-link',
  linkedFile: 'memry-capture-linked-file',
  image: 'memry-capture-image',
  audio: 'memry-capture-audio',
  video: 'memry-capture-video'
}

function setBadge(text) {
  chrome.action.setBadgeText({ text })
  if (text) {
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1600)
  }
}

function sendToMemry(capture) {
  return chrome.runtime.sendNativeMessage(MEMRY_NATIVE_HOST, createEnvelope(capture))
}

async function executeInTab(tabId, func) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func
  })
  return result?.result ?? null
}

async function selectedHtml(tabId) {
  return executeInTab(tabId, () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null

    const container = document.createElement('div')
    for (let index = 0; index < selection.rangeCount; index += 1) {
      container.append(selection.getRangeAt(index).cloneContents())
    }

    return {
      html: container.innerHTML,
      text: selection.toString(),
      sourceUrl: window.location.href,
      sourceTitle: document.title
    }
  })
}

async function pageContent(tabId) {
  return executeInTab(tabId, () => ({
    html: document.documentElement.outerHTML,
    text: document.body?.innerText || document.title || window.location.href,
    sourceUrl: window.location.href,
    sourceTitle: document.title
  }))
}

async function fileCaptureFromUrl(url, sourceTitle) {
  const response = await fetch(url, { credentials: 'include', cache: 'force-cache' })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return responseToFileCapture(response, { sourceUrl: url, sourceTitle })
}

async function captureSelection(info, tab) {
  const selected = tab?.id ? await selectedHtml(tab.id).catch(() => null) : null
  const text = selected?.text || info.selectionText || ''
  if (!text.trim()) throw new Error('No selected text to capture')

  return sendToMemry(
    createClipCapture({
      html: selected?.html || text,
      text,
      sourceUrl: selected?.sourceUrl || info.pageUrl || tab?.url || '',
      sourceTitle: selected?.sourceTitle || tab?.title || ''
    })
  )
}

async function capturePage(tab) {
  if (!tab?.url) throw new Error('No page URL to capture')

  if (isProbablyFileUrl(tab.url)) {
    return sendToMemry(await fileCaptureFromUrl(tab.url, tab.title || filenameFromUrl(tab.url)))
  }

  if (!tab.id) throw new Error('No active tab to capture')
  const page = await pageContent(tab.id)
  if (!page) throw new Error('Page content unavailable')
  return sendToMemry(createPageCapture(page))
}

async function captureLinkedFile(info, tab) {
  const url = info.linkUrl
  if (!url) throw new Error('No linked file URL to capture')
  return sendToMemry(await fileCaptureFromUrl(url, tab?.title || filenameFromUrl(url)))
}

async function captureMediaUrl(url, tab) {
  if (!url) throw new Error('No media URL to capture')
  const capture = await fileCaptureFromUrl(url, tab?.title || filenameFromUrl(url))
  if (capture.mimeType === 'application/octet-stream') {
    capture.mimeType = mimeTypeFromUrl(url)
  }
  return sendToMemry(capture)
}

async function handleMenuClick(info, tab) {
  switch (info.menuItemId) {
    case MENU_IDS.selection:
      return captureSelection(info, tab)
    case MENU_IDS.link:
      return sendToMemry(
        createLinkCapture({
          url: info.linkUrl,
          sourceTitle: tab?.title
        })
      )
    case MENU_IDS.linkedFile:
      return captureLinkedFile(info, tab)
    case MENU_IDS.image:
      return captureMediaUrl(info.srcUrl, tab)
    case MENU_IDS.audio:
      return captureMediaUrl(info.srcUrl, tab)
    case MENU_IDS.video:
      return captureMediaUrl(info.srcUrl, tab)
    case MENU_IDS.page:
    default:
      return capturePage(tab)
  }
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IDS.page,
      title: 'Capture page to Memry',
      contexts: ['page']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.selection,
      title: 'Send quote to Memry',
      contexts: ['selection']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.link,
      title: 'Send link to Memry',
      contexts: ['link']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.linkedFile,
      title: 'Capture linked file to Memry',
      contexts: ['link']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.image,
      title: 'Capture image to Memry',
      contexts: ['image']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.audio,
      title: 'Capture audio to Memry',
      contexts: ['audio']
    })
    chrome.contextMenus.create({
      id: MENU_IDS.video,
      title: 'Capture video to Memry',
      contexts: ['video']
    })
  })
}

chrome.runtime.onInstalled.addListener(createContextMenus)
chrome.runtime.onStartup.addListener(createContextMenus)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab)
    .then(() => setBadge('OK'))
    .catch((error) => {
      console.warn('Memry capture failed', error)
      setBadge('!')
    })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'capture-current-page') return false

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    capturePage(tab)
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
  })

  return true
})
