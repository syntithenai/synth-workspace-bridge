# Synth Workspace Bridge (Chrome MV3)

Gives Synth Workspace control of your own browser and makes the extension the
PWA's primary network egress for BYO model calls.

- **Browser control.** The workspace can list, read, open, click, type,
  screenshot and navigate your tabs through Chrome's debugger protocol — the
  same mechanism DevTools uses. Actions run in the tab you are already signed
  in to, and no tab is controlled until an action is requested. There is no
  "run this script" action: every expression the worker evaluates is a constant
  in its own bundle.
- **Model egress.** Provider requests leave through your own Chrome, need no
  CORS headers, and the API key is only ever in the in-memory headers of one
  request — never in `chrome.storage`, IndexedDB, localStorage, the Worker, or a
  log.

**Canonical source:** <https://github.com/syntithenai/synth-workspace-bridge>.
This folder is the working copy; publish changes there with
`npm run extension:package` and a new release tag.

## Install (dev, unpacked)

1. Download
   [synth-workspace-bridge.zip](https://github.com/syntithenai/synth-workspace-bridge/releases/latest/download/synth-workspace-bridge.zip)
   and unzip it to a folder you will keep.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder. (Working from a
   clone? Select this `extension-mv3/` directory instead.)
4. Open the extension's **Options** page and choose **Test browser control**.
   The first test attaches the debugger to an http(s) tab for a moment; Chrome
   shows a "started debugging this browser" banner and removes it afterwards.
   DevTools open on that tab blocks the test — close it and retry.
5. **Grant network access** (Chrome asks once for the host permission).
6. Open Synth Workspace, then **Settings → Browser extension**. The page detects
   the extension and offers **Pair extension**. Click it, then **Allow** in the
   Chrome notification. There is no id or token to copy.
7. Use **Test browser control** in the workspace to confirm the pairing.

A Chrome Web Store listing is planned; the manual install stays available as
the fallback after it ships. See
[`docs/extension-publishing.md`](../docs/extension-publishing.md).

`externally_connectable` allows any https origin to *ask* to pair, so a
self-hosted deployment can work. Approval is per origin: the extension shows an
Allow/Deny prompt naming the exact origin, and only an approved origin receives
the token. The token alone is not enough — the model and browser ports also
check that the connecting origin was approved. A self-hosted origin the content
script does not run on pairs by pasting its id and token under **Pair manually**.

`bridge-announce.js` is a content script on `https://suite.synthfit.online` and
localhost / 127.0.0.1 (http or https) only. It announces this install's id and
version to the page and reads nothing from it.

## What is sent where

### Browser control

- The page opens
  `chrome.runtime.connect(extensionId, { name: 'synth-workspace-browser' })`
  and sends one `browser` frame:
  `{ action, params: { target?, url?, query?, text?, submit?, expected? } }`.
- The service worker checks the pairing token and the approved origin, resolves
  the tab (explicit id, then the tab it last used, then the focused web tab),
  attaches `chrome.debugger` for that one action, runs it, and detaches.
- Actions are a fixed set: element lookup by selector or visible label,
  password-field refusal, `Input.insertText` typing with an optional Enter,
  `Page.captureScreenshot`, and `Runtime.evaluate` of expressions compiled into
  the worker. The page cannot supply a script.
- Page text is returned to the workspace marked untrusted. Password and
  credential fields are never read or filled. A click may carry the text and
  href the user approved; if the page changed underneath, it returns `changed`
  instead of clicking something else.
- Chrome refuses debugger access to `chrome://`, the Web Store and other
  extension pages; the extension reports `browser_unavailable` for those.
- A tab with DevTools open cannot be driven at the same time; the extension
  reports `browser_busy` rather than fighting for the session.

### Model calls

- The page sends one `http` frame per provider call over
  `chrome.runtime.connect(extensionId, { name: 'synth-workspace-model' })`.
- The service worker checks the pairing token and the approved origin, then
  hands the request to an offscreen document, which owns the fetch and the
  response stream (an MV3 worker may be terminated mid-stream).
- Provider responses stream back as base64 chunks; the page rebuilds the SSE
  body. The provider key is never written anywhere.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The pairing token and the list of approved origins, kept in `chrome.storage.local`. |
| `notifications` | Shows the Allow/Deny prompt when a workspace asks to pair. No other notifications. |
| `offscreen` | Keeps a provider response stream alive when the worker is suspended. |
| `debugger` | Runs browser actions through the DevTools Protocol, and supplies tab URLs/titles through `getTargets()` so the `tabs` permission is not needed. |
| Optional provider origins | Provider fetches, granted on the Options page. The list is the model APIs in `manifest.json`; there is no wildcard. Browser control does not use it. |
| `bridge-announce.js` content script | Runs only on the workspace origins above and announces the extension id/version. No host permission beyond those three origins. |

The deliberate omissions matter for review: no `tabs` (no browsing-history
warning), no `<all_urls>`, no `scripting`, no `webRequest`, and no
page-supplied code path.

## Revoking

Options → **Revoke all** deletes the token and every approved origin; open pages
are refused from then on. **Rotate token** issues a new token and clears the
approved origins, so every deployment pairs again. An individual origin can be
removed from the **Paired deployments** list. Unpairing in the workspace also
asks the extension to drop that origin.

## Limits

- Chromium browsers only (Chrome/Edge/Brave). No Firefox/Safari.
- No provider call or browser action happens while Chrome is closed.
- Browser control acts only in normal http(s) tabs, never in browser-internal
  pages.
- The Worker `/api/model/*` proxy is the fallback when the extension is not
  paired; it forwards the key per request and stores nothing.
