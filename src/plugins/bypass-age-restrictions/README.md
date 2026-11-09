# Bypass age restrictions

This opt-in plugin vendors **Simple YouTube Age Restriction Bypass v2.5.11** by
zerodytrash, under the MIT license. It patches page globals synchronously at
preload time using Electron's `contextBridge.executeInMainWorld`; restarting is
required to remove those permanent patches after disabling the plugin. It does
not expose Electron APIs to the page or fetch/execute replacement JavaScript at
runtime.

Upstream source and MIT license are pinned to commit
`47c5508bf9d994cdeab30a94673f3771f41d8aaf`:

- [Source](https://github.com/zerodytrash/Simple-YouTube-Age-Restriction-Bypass/blob/47c5508bf9d994cdeab30a94673f3771f41d8aaf/dist/Simple-YouTube-Age-Restriction-Bypass.user.js)
- [License](https://github.com/zerodytrash/Simple-YouTube-Age-Restriction-Bypass/blob/47c5508bf9d994cdeab30a94673f3771f41d8aaf/LICENSE)
- Source SHA-256: `5779b2dc6ba843a4a77e610541041e12903782df3a82c9ee10684d2d4a59b752`.
- License SHA-256: `ce863258536133a2cdc1d8d24e5802f7d0b2f7bdacec5ac7781ace374c2267a5`.

The exact local modifications are recorded in `vendor/LOCAL.patch`:

1. Export the self-contained IIFE as a named function instead of immediately
   running it in the preload realm. Remove the userscript sandbox/eval fallback,
   because Electron explicitly executes the function in the page's main world.
2. Guard global patch installation with a page-local symbol to make repeated
   injection harmless.
3. At the exact configured account/media proxy origins, always omit automatic
   credentials and strip `Authorization`, `Cookie`, `Cookie2`,
   `Proxy-Authorization`, `X-Goog-*`, and `X-Origin` headers without regard to
   casing. Apply this to XHR, Request, and direct fetch, supporting objects,
   Headers, tuples, URL objects, and Request inputs. Preserve non-auth headers
   such as Range and first-party YouTube authentication; restore first-party
   behavior when an XHR is reused. Copy caller options before editing.
   Clear the browser's internal credential flag through its native setter after
   native `open()` reaches OPENED; changing the visible JS accessor alone is
   insufficient. Preserve the prior credential preference for later first-party
   reopens, including consecutive proxy uses.
4. Restrict media hostname detection to genuine `.googlevideo.com` suffixes.
5. Include the upstream MIT copyright/license notice in the vendored source and
   retain the original userscript metadata. Exclude this third-party file from
   local formatting/lint rules so its upstream diff remains reviewable.

Reproduce and verify the vendored file from the pinned download:

```sh
python3 src/plugins/bypass-age-restrictions/vendor/rebuild.py --check
```

For an offline check with an existing copy of the pinned raw source:

```sh
python3 src/plugins/bypass-age-restrictions/vendor/rebuild.py --source /tmp/pear-age-2.5.11.js --check
```

Omit `--check` to rebuild `vendor/bypass.js`. The helper verifies source/license
hashes before applying the recorded patch; it never evaluates downloaded code.

## Network boundaries and limitations

Upstream first tries YouTube InnerTube player clients, including authenticated
requests to YouTube itself when login permits them. If those fail, it can send
the video ID and player/client metadata to `https://youtube-proxy.zerody.one`.
For an account-proxied video with a geographic restriction, it can send the
encoded original signed Googlevideo URL to `https://ny.4everproxy.com/direct/…`.
Those external services see the requested video and the client's IP address.
The local patch prevents forwarding Google session headers/cookies to them.

All upstream player, embedded-preview, next/sidebar/description, and blurred
thumbnail logic remains in the vendored file. The upstream synchronous XHR
strategy can block the page while a fallback request is in progress. Its
availability depends on YouTube API changes, permissions, and the external
proxies; restoration does not establish that any particular live restricted
video can be unlocked. Fixture tests use fake transports and isolated page
realms, without a user's profile, credentials, or live proxy requests.
