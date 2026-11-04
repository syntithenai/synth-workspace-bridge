# Synth Workspace Bridge

Chrome MV3 extension for [Synth Workspace](https://suite.synthfit.online).

- **Browser control.** The workspace can list, read, open, click, type,
  screenshot and navigate your own tabs through Chrome's debugger protocol.
  No tab is controlled until an action is requested, and the debugger detaches
  when the action finishes. There is no "run this script" action: every
  expression the extension evaluates is a constant in its own bundle.
- **Model egress.** BYOK model calls leave through your own Chrome: no CORS
  proxy, your IP, and the provider key only in the in-memory headers of one
  request. The extension never receives the key, OAuth tokens, chat history or
  file contents beyond the request it is carrying.

Chromium browsers only (Chrome, Edge, Brave and other Chromium forks). Firefox
and Safari are not supported.

## Install (dev / unpacked)

1. Download [synth-workspace-bridge.zip](https://github.com/syntithenai/synth-workspace-bridge/releases/latest/download/synth-workspace-bridge.zip).
2. Unzip it to a folder you will keep (Chrome loads the folder, not the zip).
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. Open the extension's **Options** page and click **Test browser control**.
   Chrome briefly attaches the debugger to an http(s) tab and shows a
   "started debugging this browser" banner; it disappears when the test ends.
   Close DevTools on that tab if the test reports it is busy.
6. Click **Grant network access** (Chrome asks once for the provider host
   permission).
7. Open Synth Workspace, then **Settings → Browser extension**. The page
   detects the extension and offers **Pair extension**. Click it, then
   **Allow** on the Chrome notification that names the exact origin. There is
   no id or token to copy.
8. Click **Test browser control** in the workspace to confirm the pairing.

Chrome asks to display notifications on first install: it uses them only for
the Allow/Deny pairing prompt. A self-hosted origin the content script does not
run on can still pair under **Pair manually** with the extension id and token
from the Options page.

The extension stays installed across restarts. A Chrome Web Store listing is
being prepared; the unpacked and release-zip install stays available as the
manual fallback.

Privacy policy: <https://syntithenai.github.io/synth-workspace-bridge/privacy.html>.

## Install from source

```bash
git clone https://github.com/syntithenai/synth-workspace-bridge.git
cd synth-workspace-bridge
```

Then use `extension-mv3/` as the **Load unpacked** folder from step 4 above.

## What is sent where

### Browser control

- The page opens a port named `synth-workspace-browser` with
  `chrome.runtime.connect(extensionId, …)` and sends one `browser` frame per
  action: tabs, open, read, describe, click, type, screenshot, close or
  activate.
- The service worker checks the pairing token, resolves the tab (explicit id,
  then the tab it last used, then the focused web tab), attaches
  `chrome.debugger` for that action, runs it, and detaches.
- Actions mirror the workspace's server browser tools: element lookup by
  selector or visible label, password-field refusal, text insertion with an
  optional Enter, and PNG screenshots. The page cannot supply a script.
- Chrome refuses debugger access to `chrome://`, the Web Store and other
  extension pages. A tab with DevTools already open cannot be driven at the
  same time.

### Model calls

- The page opens a port named `synth-workspace-model`. The extension declares
  this origin in `externally_connectable`; any other origin is refused.
- The service worker checks the pairing token and the approved origin, then
  hands each request to an offscreen document, which owns the fetch and the
  response stream (an MV3 worker may be terminated mid-stream).
- Responses stream back as base64 chunks and the page rebuilds the body.
- `chrome.storage.local` holds the pairing token and the origins the user
  approved (plus a pending pairing request in `chrome.storage.session`, which
  expires after two minutes). Provider keys are never written there.

### Pairing

`bridge-announce.js` runs on the Workspace origins only and announces the
extension id and version to the page. A page then asks to pair; the extension
shows a notification naming that exact origin and nothing is shared until the
user clicks Allow. Approval is per origin, and both ports also check that the
connecting origin was approved — the token alone is not enough.
`externally_connectable` is `https://*/*` so a self-hosted deployment can ask to
pair; it is a messaging allowlist, not a host permission.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The pairing token and the list of approved origins. |
| `notifications` | Shows the Allow/Deny prompt when a workspace asks to pair. No other notifications. |
| `offscreen` | Keeps a provider response stream alive when the worker is suspended. |
| `debugger` | Runs browser actions through the DevTools Protocol, and supplies tab URLs/titles via `getTargets()` so `tabs` is not needed. |
| Optional provider origins | Provider fetches, granted by the Options button. The manifest names each supported API; there is no wildcard. Browser control does not use it. |
| Content script (`bridge-announce.js`) | Runs only on the Workspace origins and announces the id/version. Reads no page content. |

## Revoking

Options → **Revoke all** deletes the token and every approved origin; open pages
are refused from then on. **Rotate token** issues a new token and clears the
approved origins, so every deployment pairs again. Individual origins can be
removed from the paired-deployments list.

## Development

```bash
bash package.sh
```

This writes `dist/synth-workspace-bridge.zip` with `manifest.json` at the
archive root.

Release:

```bash
# bump "version" in extension-mv3/manifest.json first
git tag v0.4.0
git push origin v0.4.0
gh release create v0.4.0 dist/synth-workspace-bridge.zip \
  --title "Synth Workspace Bridge 0.4.0" \
  --notes "Dev install: download the zip, unzip, then Load unpacked."
```

Keep the asset name `synth-workspace-bridge.zip` on every release: the app links
to `/releases/latest/download/synth-workspace-bridge.zip`, which only resolves
when the latest release carries that exact name.

Before publishing, bump the version in `extension-mv3/manifest.json` and in the
workspace's `EXTENSION_VERSION` constant so the UI reports the version people
actually have.

## Store publication

The Chrome Web Store listing is being prepared. It needs the developer account,
the privacy-policy URL, screenshots and the same zip. Reviewers will ask about
`debugger`: point at the Options-page grant step, the per-action attach/detach,
the password refusal, the pairing token that limits both ports to the workspace
the user paired, and the deliberate absence of `eval`, `tabs` and wildcard
hosts. See the workspace repository's `docs/extension-publishing.md` and
`docs/store-listing.md`.
