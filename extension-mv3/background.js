/**
 * MV3 service worker for the Synth Workspace bridge.
 *
 * Two things happen here:
 *
 * 1. Model egress. The page validates the pairing token, then the request is
 *    relayed to the offscreen document, which owns the fetch and the response
 *    stream. An MV3 worker can be terminated mid-stream, so the stream lives
 *    offscreen. The worker itself never stores request data.
 *
 * 2. Browser control. The page asks the extension to list, read, open, click,
 *    type, screenshot or navigate in the user's own tabs. Actions use the
 *    Chrome DevTools Protocol through `chrome.debugger`, which mirrors the
 *    server browser tools: same element lookup, same password refusal, same
 *    screenshot semantics. The debugger is attached only for the duration of
 *    one action, so no tab stays under control while idle.
 *
 * There is deliberately no "run this script" action. Every expression the
 * worker evaluates is a constant in this file, so nothing the page sends can
 * execute arbitrary code. That keeps the extension within the Web Store's
 * remote-code rules and keeps review focused on the fixed action set.
 *
 * Both ports require the token stored by the options page *and* an origin the
 * user approved when pairing. `externally_connectable` lets any https page ask
 * to pair, but only an approved origin receives the token, and the token only
 * works from an approved origin. The pairing prompt is the gate; the token is
 * what the approved page uses on every later connection.
 */

const MODEL_PORT_NAME = 'synth-workspace-model'
const BROWSER_PORT_NAME = 'synth-workspace-browser'
const MAIL_PORT_NAME = 'synth-workspace-mail'
/** Registered by the native helper installer; see services/mail-helper. */
const MAIL_HOST_NAME = 'online.synthfit.workspace_mail'
const MAIL_ACTIONS = new Set(['load-contact-mail', 'search', 'read'])
const DEBUG_PROTOCOL_VERSION = '1.3'

const PAIR_PROTOCOL_VERSION = 1
const PAIR_REQUESTS_KEY = 'pairRequests'
const PAIR_NOTIFICATION_PREFIX = 'synth-pair:'
/** How long an unanswered Allow/Deny prompt stays valid. */
const PAIR_REQUEST_TTL_MS = 2 * 60_000
/** A page cannot stack unbounded prompts while the user ignores them. */
const MAX_PENDING_PAIRS = 5

/** id -> port, so model stream events can find the page that asked. */
const jobs = new Map()

/** Tabs currently attached by this worker. */
const attached = new Set()

class BrowserError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

function errorText(error) {
  if (!error) return 'the browser refused the action'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

function proxyable(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    )
  } catch {
    return false
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Stream provider responses back to the Synth Workspace page.',
  })
}

function fail(port, id, code, message) {
  port.postMessage({ type: 'error', id, code, message })
}

function post(port, message) {
  try {
    port.postMessage(message)
  } catch {
    // The page went away.
  }
}

/* --------------------------------------------------------------------------
 * Pairing
 *
 * One token per install, plus the list of origins the user approved. A web
 * page announces itself through `bridge-announce.js`, sends `pair.request`, and
 * receives the token only after the user clicks Allow on a Chrome notification.
 * Every port connection is checked against both the token and the origin list.
 *
 * All pending state lives in session storage, because the worker is torn down
 * while the notification sits unanswered; the button click revives a fresh
 * worker with no in-memory state.
 * ------------------------------------------------------------------------ */

async function pairingToken() {
  const { pairingToken } = await chrome.storage.local.get('pairingToken')
  return typeof pairingToken === 'string' ? pairingToken : undefined
}

async function ensurePairingToken() {
  const current = await pairingToken()
  if (current) return current
  const token = crypto.randomUUID() + crypto.randomUUID()
  await chrome.storage.local.set({ pairingToken: token })
  return token
}

async function readPairedOrigins() {
  const { pairedOrigins } = await chrome.storage.local.get('pairedOrigins')
  return Array.isArray(pairedOrigins)
    ? pairedOrigins.filter((origin) => typeof origin === 'string')
    : undefined
}

/** Serializes read-modify-write of the origin list and pending requests. */
let pairQueue = Promise.resolve()
function withPairStore(task) {
  const run = pairQueue.then(task, task)
  pairQueue = run.catch(() => undefined)
  return run
}

/**
 * Only exact https origins and loopback http origins may pair. `sender.origin`
 * is browser-supplied, but normalize anyway so a trailing slash or a case
 * difference cannot bypass the stored list.
 */
function normalizeOrigin(raw) {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return url.origin
    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    ) {
      return url.origin
    }
    return undefined
  } catch {
    return undefined
  }
}

function pairError(code, message) {
  return { ok: false, status: 'error', code, message }
}

async function readPairRequests() {
  try {
    const { pairRequests } = await chrome.storage.session.get(PAIR_REQUESTS_KEY)
    return pairRequests && typeof pairRequests === 'object' ? pairRequests : {}
  } catch {
    return {}
  }
}

/** Drops requests older than the TTL; an approved entry only has to outlive the page's poll. */
async function writePairRequests(requests) {
  const now = Date.now()
  const kept = {}
  for (const [id, request] of Object.entries(requests)) {
    if (!request || typeof request.createdAt !== 'number') continue
    if (now - request.createdAt < PAIR_REQUEST_TTL_MS) kept[id] = request
  }
  try {
    await chrome.storage.session.set({ [PAIR_REQUESTS_KEY]: kept })
  } catch {
    // Without session storage the request is simply unanswerable and expires.
  }
  return kept
}

async function originApproved(origin) {
  if (!origin) return false
  const origins = await readPairedOrigins()
  return Array.isArray(origins) && origins.includes(origin)
}

/**
 * Ports accept a connection when the token matches and the origin was approved
 * (or, for a pre-0.4.0 pairing that has a token but no origin list, on first
 * use — the origin is then recorded, so later connections are checked).
 */
async function portAllowed(origin, token) {
  const stored = await pairingToken()
  if (!stored || token !== stored) return false
  const origins = await readPairedOrigins()
  if (origins === undefined) {
    if (!origin) return false
    await chrome.storage.local.set({ pairedOrigins: [origin], originsMigrated: true })
    return true
  }
  return Boolean(origin) && origins.includes(origin)
}

async function showPairPrompt(request) {
  try {
    await chrome.notifications.create(request.notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Pair Synth Workspace?',
      // Only the origin, never text from the page.
      message: `${request.origin} wants to send model requests and control tabs through this extension.`,
      contextMessage: 'Only approve a workspace you opened yourself.',
      buttons: [{ title: 'Allow' }, { title: 'Deny' }],
      requireInteraction: true,
    })
  } catch {
    // Notifications can be disabled by the OS or by Chrome policy. Fall back to
    // the Options page, which needs no extra permission.
    try {
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL('options.html')}#pair=${encodeURIComponent(request.requestId)}`,
      })
    } catch {
      // Nothing else to try; the page reports that no prompt appeared.
    }
  }
}

async function handlePairRequest(origin) {
  if (!origin) return pairError('invalid_origin', 'Pairing must start from an https workspace.')
  const existingToken = await pairingToken()
  if (existingToken && (await originApproved(origin))) {
    return { ok: true, status: 'approved', token: existingToken }
  }
  return withPairStore(async () => {
    const requests = await readPairRequests()
    const now = Date.now()
    const sameOrigin = Object.entries(requests).find(
      ([, request]) =>
        request.origin === origin &&
        request.status === 'pending' &&
        now - request.createdAt < PAIR_REQUEST_TTL_MS,
    )
    if (sameOrigin) return { ok: true, status: 'pending', requestId: sameOrigin[0] }

    const live = Object.values(requests).filter(
      (request) => request.status === 'pending' && now - request.createdAt < PAIR_REQUEST_TTL_MS,
    ).length
    if (live >= MAX_PENDING_PAIRS) {
      return pairError('pairing_busy', 'Too many pairing prompts are waiting in Chrome.')
    }

    const requestId = crypto.randomUUID()
    const request = {
      requestId,
      origin,
      createdAt: now,
      status: 'pending',
      notificationId: PAIR_NOTIFICATION_PREFIX + requestId,
    }
    requests[requestId] = request
    await writePairRequests(requests)
    await showPairPrompt(request)
    return { ok: true, status: 'pending', requestId }
  })
}

async function handlePairStatus(requestId, origin) {
  if (!origin) return pairError('invalid_origin', 'Pairing must start from an https workspace.')
  return withPairStore(async () => {
    const requests = await readPairRequests()
    const request = typeof requestId === 'string' ? requests[requestId] : undefined
    // Binding the request to the asking origin means a leaked id cannot fetch
    // another deployment's token.
    if (!request || request.origin !== origin) {
      return pairError('unknown_request', 'No pairing request for this origin.')
    }
    if (request.status === 'approved') {
      const token = await pairingToken()
      if (!token) return { ok: true, status: 'expired' }
      if (!(await originApproved(origin))) return { ok: true, status: 'revoked' }
      return { ok: true, status: 'approved', token }
    }
    if (request.status === 'denied') return { ok: true, status: 'denied' }
    if (Date.now() - request.createdAt >= PAIR_REQUEST_TTL_MS) {
      request.status = 'expired'
      await writePairRequests(requests)
      return { ok: true, status: 'expired' }
    }
    return { ok: true, status: 'pending', requestId: request.requestId }
  })
}

async function handlePairClaim(token, origin) {
  if (!origin) return pairError('invalid_origin', 'Pairing must start from an https workspace.')
  const stored = await pairingToken()
  if (!stored || token !== stored) {
    return pairError('not_paired', 'The pairing token does not match this extension.')
  }
  return withPairStore(async () => {
    const origins = (await readPairedOrigins()) || []
    if (!origins.includes(origin)) {
      origins.push(origin)
      await chrome.storage.local.set({ pairedOrigins: origins })
    }
    return { ok: true, status: 'claimed' }
  })
}

async function handlePairRevoke(origin) {
  if (!origin) return pairError('invalid_origin', 'Pairing must start from an https workspace.')
  return withPairStore(async () => {
    const origins = (await readPairedOrigins()) || []
    await chrome.storage.local.set({ pairedOrigins: origins.filter((item) => item !== origin) })
    return { ok: true, status: 'revoked' }
  })
}

/**
 * Applies an Allow/Deny decision. The token is created here — never on a bare
 * request — so no page can mint a token without consent. Token and origin list
 * are written before the request is marked approved, so a worker that dies
 * halfway never reports success.
 */
async function applyPairDecision(requestId, allow) {
  return withPairStore(async () => {
    const requests = await readPairRequests()
    const request = typeof requestId === 'string' ? requests[requestId] : undefined
    if (!request) return pairError('unknown_request', 'That pairing prompt is no longer valid.')
    if (request.status !== 'pending') {
      return { ok: true, status: request.status }
    }
    if (Date.now() - request.createdAt >= PAIR_REQUEST_TTL_MS) {
      request.status = 'expired'
      await writePairRequests(requests)
      return { ok: true, status: 'expired' }
    }
    if (!allow) {
      request.status = 'denied'
      await writePairRequests(requests)
      return { ok: true, status: 'denied' }
    }
    const token = await ensurePairingToken()
    const origins = (await readPairedOrigins()) || []
    if (!origins.includes(request.origin)) origins.push(request.origin)
    await chrome.storage.local.set({ pairingToken: token, pairedOrigins: origins })
    request.status = 'approved'
    await writePairRequests(requests)
    return { ok: true, status: 'approved' }
  })
}

/** A dismissed prompt is a denial, but only while it is still pending. */
async function settleClosedPrompt(requestId) {
  return withPairStore(async () => {
    const requests = await readPairRequests()
    const request = typeof requestId === 'string' ? requests[requestId] : undefined
    if (!request || request.status !== 'pending') return
    request.status = 'denied'
    await writePairRequests(requests)
  })
}

/* --------------------------------------------------------------------------
 * Browser control: target resolution
 * ------------------------------------------------------------------------ */

function isWebUrl(url) {
  return /^https?:/i.test(url || '')
}

/** Session storage forgets a target when Chrome closes, which is what we want. */
async function storedTarget() {
  try {
    const { browserTarget } = await chrome.storage.session.get('browserTarget')
    return typeof browserTarget === 'number' ? browserTarget : undefined
  } catch {
    return undefined
  }
}

async function rememberTarget(tabId) {
  try {
    await chrome.storage.session.set({ browserTarget: tabId })
  } catch {
    // Session storage is best effort; the active tab remains the fallback.
  }
}

/**
 * URL and title for each debuggable tab, keyed by tab id.
 *
 * `chrome.tabs.query` supplies ids and window state without the `tabs`
 * permission; its url and title fields stay empty on purpose. `getTargets`
 * supplies the page metadata instead, which is part of the `debugger`
 * permission the extension already needs. That is why the manifest asks for no
 * browsing-history access at install.
 */
async function pageTargets() {
  const byTab = new Map()
  let targets
  try {
    targets = await chrome.debugger.getTargets()
  } catch {
    return byTab
  }
  for (const target of targets || []) {
    if (!target || target.type !== 'page') continue
    if (typeof target.tabId !== 'number' || target.tabId <= 0) continue
    byTab.set(target.tabId, target)
  }
  return byTab
}

function tabInfo(tab, target) {
  const url = (target && target.url) || tab.url || ''
  const title = (target && target.title) || tab.title || ''
  return {
    targetId: String(tab.id),
    url,
    title,
    active: Boolean(tab.active),
    windowId: typeof tab.windowId === 'number' ? tab.windowId : -1,
    restricted: !isWebUrl(url),
  }
}

async function usableTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return undefined
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

/**
 * The tab an action addresses. An explicit id wins; then the tab this
 * extension last used; then the focused web tab; then any web tab. Extension
 * and chrome:// pages are skipped because Chrome refuses to debug them.
 */
async function resolveTarget(input) {
  const byTab = await pageTargets()
  const explicit = typeof input === 'number' ? input : Number(input)
  const chosen = await usableTab(explicit)
  if (chosen) {
    await rememberTarget(chosen.id)
    return { tab: chosen, target: byTab.get(chosen.id) }
  }
  const remembered = await usableTab(Number(await storedTarget()))
  if (remembered) return { tab: remembered, target: byTab.get(remembered.id) }

  const tabs = (await chrome.tabs.query({})).filter((tab) => typeof tab.id === 'number')
  const web = tabs.filter((tab) => isWebUrl((byTab.get(tab.id) || {}).url))
  const found = web.find((tab) => tab.active) || web[0] || tabs.find((tab) => tab.active)
  if (!found) throw new BrowserError('no_page', 'The browser has no open page.')
  await rememberTarget(found.id)
  return { tab: found, target: byTab.get(found.id) }
}

function assertOpenableUrl(raw) {
  const value = String(raw || '').trim()
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new BrowserError('blocked_url', 'Enter a full http(s) URL.')
  }
  const host = parsed.hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (parsed.protocol === 'https:') return parsed.toString()
  if (parsed.protocol === 'http:' && local) return parsed.toString()
  throw new BrowserError('blocked_url', 'Only https pages and localhost may be opened.')
}

const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 250

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for a new tab to leave about:blank and finish loading. `tabs.create`
 * returns before the requested navigation commits, so readyState alone would
 * report the blank document as complete.
 */
async function waitForTab(tabId, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const target = (await pageTargets()).get(tabId)
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete' && target && target.url && target.url !== 'about:blank') {
        return { tab, target }
      }
    } catch {
      return undefined
    }
    await sleep(READY_POLL_MS)
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab) return undefined
  return { tab, target: (await pageTargets()).get(tabId) }
}

/* --------------------------------------------------------------------------
 * Browser control: CDP
 * ------------------------------------------------------------------------ */

async function attach(tabId) {
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, DEBUG_PROTOCOL_VERSION)
    attached.add(tabId)
  } catch (error) {
    const message = errorText(error)
    if (/already attached/i.test(message)) {
      // It may be our own session from before a worker restart. A no-op
      // command tells an extension session apart from DevTools.
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
        )
        attached.add(tabId)
        return
      } catch {
        throw new BrowserError(
          'browser_busy',
          'Another debugger is using this tab. Close DevTools for it and try again.',
        )
      }
    }
    if (/cannot access|not allowed|chrome:|extension/i.test(message)) {
      throw new BrowserError(
        'browser_unavailable',
        'Chrome does not allow the extension to control this tab. Open a normal http(s) page.',
      )
    }
    throw new BrowserError('browser_unavailable', message)
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // The tab or the session is already gone.
  }
}

async function withDebugger(tabId, task) {
  await attach(tabId)
  try {
    return await task()
  } finally {
    await detach(tabId)
  }
}

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {})
}

async function evaluate(tabId, expression) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result && result.exceptionDetails) {
    throw new BrowserError(
      'cdp_evaluate',
      result.exceptionDetails.text || 'the page script failed',
    )
  }
  return result && result.result ? result.result.value : undefined
}

async function waitForReady(tabId) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(tabId, 'document.readyState')
      if (state === 'complete' || state === 'interactive') return
    } catch {
      // The document is between navigations; keep polling.
    }
    await sleep(READY_POLL_MS)
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === 'number') attached.delete(source.tabId)
})

/* --------------------------------------------------------------------------
 * Browser control: page scripts (mirrors server/services/browser/pages.ts)
 * ------------------------------------------------------------------------ */

const MAX_TEXT = 20_000
const MAX_LINKS = 100
const MAX_FIELDS = 60

const SNAPSHOT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, ${MAX_LINKS}).map((a) => ({
    text: (a.innerText || '').trim().slice(0, 200),
    href: a.href,
  }));
  const fields = Array.from(document.querySelectorAll('input,textarea,select')).slice(0, ${MAX_FIELDS}).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    name: el.name || '',
    id: el.id || '',
    placeholder: el.placeholder || '',
    label: (el.labels && el.labels[0] && el.labels[0].innerText ? el.labels[0].innerText : '').trim().slice(0, 120),
  }));
  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, ${MAX_TEXT}),
    links,
    fields,
  };
})()`

function describeExpression(query, action, expected) {
  const literal = JSON.stringify(String(query || ''))
  const expectedJson = JSON.stringify(expected || null)
  const click = action === 'click'
  return `(() => {
  const query = ${literal};
  const expected = ${expectedJson};
  let el = null;
  try { el = document.querySelector(query); } catch (error) { el = null; }
  if (!el) {
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary'));
    const textOf = (node) => ((node.innerText || node.value || '') + '').trim();
    el = candidates.find((node) => textOf(node) === query) ||
      candidates.find((node) => textOf(node).toLowerCase().includes(query.toLowerCase()));
  }
  if (!el) return { ok: false, reason: 'not_found' };
  if (expected) {
    const nowText = ((el.innerText || el.value || '') + '').trim().slice(0, 300);
    const nowHref = el.href || null;
    if (expected.text !== undefined && nowText !== expected.text) {
      return { ok: false, reason: 'changed' };
    }
    if (expected.href !== undefined && nowHref !== expected.href) {
      return { ok: false, reason: 'changed' };
    }
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  const description = {
    ok: true,
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    text: ((el.innerText || el.value || '') + '').trim().slice(0, 300),
    href: el.href || null,
    name: el.name || '',
    id: el.id || '',
  };
  ${click ? 'el.click();' : ''}
  return description;
})()`
}

function focusExpression(query) {
  return `(() => {
  const query = ${JSON.stringify(String(query || ''))};
  let el = null;
  try { el = document.querySelector(query); } catch (error) { el = null; }
  if (!el) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  try {
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } catch (error) { /* not a text field */ }
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    text: ((el.innerText || el.value || '') + '').trim().slice(0, 300),
    href: el.href || null,
    name: el.name || '',
    id: el.id || '',
  };
})()`
}

const KEY_ENTER = {
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
}

const KEY_ENTER_UP = { ...KEY_ENTER, type: 'keyUp' }

/* --------------------------------------------------------------------------
 * Browser control: actions
 * ------------------------------------------------------------------------ */

function numberParam(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function actionTabs() {
  const byTab = await pageTargets()
  const tabs = (await chrome.tabs.query({})).filter((tab) => typeof tab.id === 'number')
  const remembered = await usableTab(Number(await storedTarget()))
  const target =
    remembered ||
    tabs.find((tab) => tab.active && isWebUrl((byTab.get(tab.id) || {}).url)) ||
    tabs.find((tab) => isWebUrl((byTab.get(tab.id) || {}).url)) ||
    tabs.find((tab) => tab.active)
  return {
    tabs: tabs.map((tab) => tabInfo(tab, byTab.get(tab.id))),
    activeTargetId: target ? String(target.id) : null,
  }
}

async function actionOpen(params) {
  const url = assertOpenableUrl(params.url)
  const created = await chrome.tabs.create({ url, active: true })
  if (typeof created.id !== 'number') {
    throw new BrowserError('browser_unavailable', 'Chrome did not open the page.')
  }
  const ready = await waitForTab(created.id)
  await rememberTarget(created.id)
  if (ready) return tabInfo(ready.tab, ready.target)
  return tabInfo(created, (await pageTargets()).get(created.id))
}

async function actionRead(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  const snapshot = await withDebugger(tab.id, () => evaluate(tab.id, SNAPSHOT))
  return { ...(snapshot || {}), targetId: String(tab.id), untrusted: true }
}

async function actionDescribe(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  const description = await withDebugger(tab.id, () =>
    evaluate(tab.id, describeExpression(params.query, 'describe')),
  )
  return { ...(description || { ok: false, reason: 'not_found' }), targetId: String(tab.id) }
}

async function actionClick(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  if (!String(params.query || '').trim()) {
    throw new BrowserError('invalid_action', 'A click needs a selector or visible label.')
  }
  const expected =
    params.expected && typeof params.expected === 'object' ? params.expected : undefined
  const description = await withDebugger(tab.id, async () => {
    const result = await evaluate(tab.id, describeExpression(params.query, 'click', expected))
    if (result && result.ok) await waitForReady(tab.id)
    return result
  })
  return {
    ...(description || { ok: false, reason: 'not_found' }),
    targetId: String(tab.id),
    clicked: Boolean(description && description.ok),
  }
}

async function actionType(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  if (!String(params.query || '').trim()) {
    throw new BrowserError('invalid_action', 'Typing needs a selector or visible label.')
  }
  const text = typeof params.text === 'string' ? params.text : String(params.text ?? '')
  const focused = await withDebugger(tab.id, async () => {
    const result = await evaluate(tab.id, focusExpression(params.query))
    if (!result || !result.ok) return result
    if (result.type === 'password') {
      return { ...result, ok: false, reason: 'password_field' }
    }
    await send(tab.id, 'Page.bringToFront')
    await send(tab.id, 'Input.insertText', { text })
    const submitted = Boolean(params.submit)
    if (submitted) {
      await send(tab.id, 'Input.dispatchKeyEvent', KEY_ENTER)
      await send(tab.id, 'Input.dispatchKeyEvent', KEY_ENTER_UP)
    }
    return { ...result, submitted }
  })
  return {
    ...(focused || { ok: false, reason: 'not_found' }),
    targetId: String(tab.id),
    submitted: Boolean(focused && focused.submitted),
  }
}

async function actionScreenshot(params) {
  const { tab, target } = await resolveTarget(numberParam(params.target))
  const shot = await withDebugger(tab.id, () =>
    send(tab.id, 'Page.captureScreenshot', { format: 'png' }),
  )
  if (!shot || !shot.data) {
    throw new BrowserError('cdp_screenshot', 'The browser returned no image.')
  }
  return {
    ...tabInfo(tab, target),
    data: shot.data,
    dataUrl: `data:image/png;base64,${shot.data}`,
  }
}

async function actionClose(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  await chrome.tabs.remove(tab.id)
  if ((await storedTarget()) === tab.id) {
    await chrome.storage.session.remove('browserTarget').catch(() => undefined)
  }
  return { targetId: String(tab.id), closed: true }
}

async function actionActivate(params) {
  const { tab, target } = await resolveTarget(numberParam(params.target))
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
  await rememberTarget(tab.id)
  return { ...tabInfo(tab, target), active: true }
}

async function runBrowserAction(action, params) {
  const input = params && typeof params === 'object' ? params : {}
  switch (action) {
    case 'tabs':
      return actionTabs()
    case 'open':
      return actionOpen(input)
    case 'read':
      return actionRead(input)
    case 'describe':
      return actionDescribe(input)
    case 'click':
      return actionClick(input)
    case 'type':
      return actionType(input)
    case 'screenshot':
      return actionScreenshot(input)
    case 'close':
      return actionClose(input)
    case 'activate':
      return actionActivate(input)
    default:
      throw new BrowserError('unknown_action', `Unknown browser action: ${String(action)}`)
  }
}

/* --------------------------------------------------------------------------
 * Ports
 * ------------------------------------------------------------------------ */

function modelPort(port, origin) {
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'http' || typeof message.id !== 'string') return
    if (!(await portAllowed(origin, message.token))) {
      fail(port, message.id, 'extension_unavailable', 'This page is not paired.')
      return
    }
    if (!proxyable(message.url)) {
      fail(port, message.id, 'blocked_url', 'Only https and localhost URLs are proxied.')
      return
    }
    jobs.set(message.id, port)
    try {
      await ensureOffscreen()
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'proxy-request',
        request: {
          id: message.id,
          url: message.url,
          method: message.method || 'POST',
          headers: message.headers || {},
          body: message.body || null,
        },
      })
    } catch (error) {
      jobs.delete(message.id)
      fail(port, message.id, 'extension_unavailable', errorText(error))
    }
  })

  port.onDisconnect.addListener(() => {
    for (const [id, owner] of jobs) if (owner === port) jobs.delete(id)
  })
}

// One browser action at a time. Two pages (or two tabs) acting on the same tab
// would otherwise race attach/detach and one of them would lose its session.
let browserQueue = Promise.resolve()

function enqueueBrowser(task) {
  const run = browserQueue.then(task, task)
  browserQueue = run.catch(() => undefined)
  return run
}

function browserPort(port, origin) {
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'browser' || typeof message.id !== 'string') return
    if (!(await portAllowed(origin, message.token))) {
      post(port, {
        type: 'browser-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: 'This page is not paired.',
      })
      return
    }
    try {
      const value = await enqueueBrowser(() => runBrowserAction(message.action, message.params))
      post(port, { type: 'browser-result', id: message.id, ok: true, value })
    } catch (error) {
      post(port, {
        type: 'browser-result',
        id: message.id,
        ok: false,
        code: error && error.code ? error.code : 'tool_failed',
        message: errorText(error),
      })
    }
  })
}

function mailProblem(message) {
  if (!MAIL_ACTIONS.has(message.action)) return 'unknown mail action'
  const params = message.params
  if (!params || typeof params !== 'object') return 'missing mail parameters'
  if (typeof params.email !== 'string' || !params.email.trim()) return 'missing email address'
  if (typeof params.appPassword !== 'string' || !params.appPassword) return 'missing app password'
  return null
}

/**
 * Relays one mail request to the native helper.
 *
 * The app password is passed straight through to the helper and never written
 * to storage, notifications or logs. Only one result is accepted; whichever of
 * result, native disconnect or page disconnect happens first wins.
 */
function mailPort(port, origin) {
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'mail' || typeof message.id !== 'string') return
    if (!(await portAllowed(origin, message.token))) {
      post(port, {
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: 'This page is not paired.',
      })
      return
    }
    const problem = mailProblem(message)
    if (problem) {
      post(port, {
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'invalid_input',
        message: problem,
      })
      return
    }

    let native = null
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        if (native) native.disconnect()
      } catch {
        // Already gone.
      }
      post(port, result)
    }

    try {
      native = chrome.runtime.connectNative(MAIL_HOST_NAME)
    } catch (error) {
      finish({
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: `The mail helper is not installed (${errorText(error)}).`,
      })
      return
    }
    if (!native) {
      finish({
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: 'The mail helper is not installed.',
      })
      return
    }

    native.onMessage.addListener((reply) => {
      if (!reply || reply.type !== 'mail-result' || reply.id !== message.id) return
      if (reply.ok) {
        finish({ type: 'mail-result', id: message.id, ok: true, value: reply.value })
      } else {
        finish({
          type: 'mail-result',
          id: message.id,
          ok: false,
          code: reply.code || 'upstream',
          message: reply.message || 'The mail helper failed.',
        })
      }
    })
    native.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError
      finish({
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message:
          lastError && lastError.message
            ? lastError.message
            : 'The mail helper exited before answering.',
      })
    })
    port.onDisconnect.addListener(() => {
      if (settled) return
      settled = true
      try {
        native.disconnect()
      } catch {
        // Already gone.
      }
    })

    try {
      native.postMessage({
        type: 'mail',
        version: 1,
        id: message.id,
        action: message.action,
        params: message.params,
      })
    } catch (error) {
      finish({
        type: 'mail-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: errorText(error),
      })
    }
  })
}

chrome.runtime.onConnectExternal.addListener((port) => {
  // `sender` is browser-supplied for external ports; never trust the page.
  const origin = normalizeOrigin(port.sender && port.sender.origin)
  if (port.name === MODEL_PORT_NAME) modelPort(port, origin)
  else if (port.name === BROWSER_PORT_NAME) browserPort(port, origin)
  else if (port.name === MAIL_PORT_NAME) mailPort(port, origin)
})

function handleExternalMessage(message, origin) {
  if (!message || message.version !== PAIR_PROTOCOL_VERSION) {
    return pairError('extension_unavailable', 'This page speaks a different pairing protocol.')
  }
  switch (message.type) {
    case 'pair.request':
      return handlePairRequest(origin)
    case 'pair.status':
      return handlePairStatus(message.requestId, origin)
    case 'pair.claim':
      return handlePairClaim(message.token, origin)
    case 'pair.revoke':
      return handlePairRevoke(origin)
    default:
      return pairError('extension_unavailable', 'Unknown pairing message.')
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Pairing must start from the top-level page, not a third-party iframe.
  if (sender && sender.frameId !== undefined && sender.frameId !== 0) {
    sendResponse(pairError('invalid_origin', 'Pairing must start from the top-level page.'))
    return false
  }
  const origin = normalizeOrigin(sender && sender.origin)
  if (!origin) {
    sendResponse(pairError('invalid_origin', 'Pairing must start from an https workspace.'))
    return false
  }
  handleExternalMessage(message, origin).then(
    sendResponse,
    () => sendResponse(pairError('extension_unavailable', 'The extension could not answer.')),
  )
  return true
})

function clearPairNotification(notificationId) {
  try {
    void chrome.notifications.clear(notificationId).catch(() => undefined)
  } catch {
    // Already gone or unsupported in this build.
  }
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (typeof notificationId !== 'string' || !notificationId.startsWith(PAIR_NOTIFICATION_PREFIX)) {
    return
  }
  const requestId = notificationId.slice(PAIR_NOTIFICATION_PREFIX.length)
  void applyPairDecision(requestId, buttonIndex === 0).finally(() => {
    clearPairNotification(notificationId)
  })
})

chrome.notifications.onClosed.addListener((notificationId) => {
  if (typeof notificationId !== 'string' || !notificationId.startsWith(PAIR_NOTIFICATION_PREFIX)) {
    return
  }
  // A dismissed prompt is a denial. Already-decided prompts are ignored.
  void settleClosedPrompt(notificationId.slice(PAIR_NOTIFICATION_PREFIX.length))
})

/** Only this extension's own pages may decide or inspect a pairing prompt. */
function isExtensionPage(sender) {
  return Boolean(
    sender &&
      sender.id === chrome.runtime.id &&
      String(sender.url || '').startsWith(chrome.runtime.getURL('')),
  )
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'background') return
  if (message.type === 'pair.inspect') {
    // Options-page fallback only; never answer a content script with the origin.
    if (!isExtensionPage(sender)) {
      sendResponse({ ok: false })
      return false
    }
    readPairRequests().then((requests) => {
      const request = requests[message.requestId]
      sendResponse(
        request
          ? { ok: true, status: request.status, origin: request.origin }
          : { ok: false },
      )
    })
    return true
  }
  if (message.type === 'pair.decide') {
    // Options-page fallback when OS notifications are unavailable.
    if (!isExtensionPage(sender)) {
      sendResponse(pairError('invalid_origin', 'Only the extension page can decide a pairing.'))
      return false
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : ''
    applyPairDecision(requestId, Boolean(message.allow)).then((result) => {
      clearPairNotification(PAIR_NOTIFICATION_PREFIX + requestId)
      sendResponse(result)
    })
    return true
  }
  if (message.type !== 'proxy-event') return
  const event = message.event
  if (!event || typeof event.id !== 'string') return
  const port = jobs.get(event.id)
  if (!port) return
  post(port, event)
  if (event.type === 'end' || event.type === 'error') jobs.delete(event.id)
})
