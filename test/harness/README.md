# Same-host browser ↔ werift resume harness

Reproduces the dashboard's "resume" path against a watcher-shaped Node peer
in a throwaway room (network `gitpigeon-harness-v1`) that the real fleet
never joins. Found the glare duplicate-channel teardown and the relay's
replay of dead offers (2026-09-02).

    # Node peer: uses GitPigeon's werift install exactly like the watcher.
    mkdir -p node && cp node-peer.mjs rtc-tap.js glare-pair.mjs node/
    ln -sfn ~/Documents/ChatGPT/GitPigeon/node_modules node/node_modules
    (cd node && ROOM=hr-1 RUN_MS=300000 node node-peer.mjs | tee ../node.log)

    # Browser peer: bundled from the dashboard's node_modules.
    ln -sfn ~/Documents/ChatGPT/gitpigeon.dev/node_modules node_modules
    ~/Documents/ChatGPT/gitpigeon.dev/node_modules/.bin/esbuild browser-entry.js \
      --bundle --format=esm --platform=browser --outfile=app.js
    node serve.mjs   # http://127.0.0.1:8765/?room=hr-1

Open the page, then in its console `document.dispatchEvent(new Event('resume'))`
runs FreeRTC's exact suspend-restore path (handleSuspendRestore). `window.harnessLines`
holds the log; `rtc-tap.js` wraps RTCPeerConnection on both sides to print
candidates, states, the selected pair and channel opens/closes.

`glare-pair.mjs`: two werift peers started together (watcher ↔ watcher glare):
    (cd node && ROOM=g1 LABEL=A node glare-pair.mjs & ROOM=g1 LABEL=B node glare-pair.mjs)

Politeness is by peer id: the lexically later id rolls back. Restart a peer
to redraw ids when a specific role is wanted.
