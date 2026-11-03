# Synth Workspace Bridge (Chrome MV3)

This folder is the unpacked extension. For install steps, pairing, privacy and
release instructions see the [repository README](../README.md).

Quick install: download `synth-workspace-bridge.zip` from the latest release,
unzip it, open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked** and select the unzipped folder. Then open the extension's Options
page, grant network access, generate a pairing token, and paste the extension id
and token into Synth Workspace under **Settings → Extension**.

The extension is the PWA's primary network egress for BYO model calls. The key
is only ever in the in-memory headers of one request — never in
`chrome.storage`, IndexedDB, localStorage, the Worker or a log.

Chromium browsers only. A Chrome Web Store listing is planned; this manual
install remains available afterwards.
