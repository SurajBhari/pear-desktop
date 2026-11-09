# MCP dependency notices

The local attributes disable Git text conversion for the original notice files, preserving their exact bytes across platforms.

This directory contains the original notice bytes for the 94 package/version identities in the MCP SDK 1.32.0 production dependency subtree. It is deliberately scoped to MCP dependencies. It is not an application-wide license inventory, license-expression validation, or legal acceptance.

`binding.json` joins each package/version to its source record ID, original notice path, notice byte length and SHA-256, original archive SHA-256, package.json SHA-256, source group and unchanged source qualification labels. The 92 unchanged original catalog records retain their accepted portable source bytes and qualifications. The SDK 1.32.0 source was recaptured from its official registry archive with SHA-512 integrity; sources/sdk-1.32.0.json records its new exact-version provenance. Identical LICENSE bytes do not reuse the old SDK version identity. The input catalog, portable index and closure hashes identify the accepted inputs without including local evidence paths or private fields.

The graph binds 94 exact current lock snapshots, including peer contexts and the SDK patch qualifier. It includes 160 required edges, one declared optional edge and 13 exact peer-context references. Optional edges describe possible declared dependencies, not every platform's installed selection. Peer references establish exact-context presence, not peer-range satisfaction. Source qualification labels retain their original limits; joining a record does not promote source-only metadata to a broader audit result.

The build emitter in `vite-plugins/mcp-notices.mts` validates the exact SDK importer, SDK patch bytes, selected package/snapshot lock blocks, complete declared graph, original notice paths and original notice bytes. It rejects missing, duplicate, changed or unbound records. Unrelated builder or development lock records are outside this gate.

The main build emits an escaped static document at `dist/main/assets/mcp-dependency-notices.html`, covered by the existing `dist` packaging rule. Notice text is processed only during the build; the main application loads the document lazily from disk. The document requires no network or JavaScript.

Run the explicit build/graph checks with:

```sh
node --test scripts/mcp-notices.node.mjs
pnpm exec playwright test tests/mcp-notices-window.test.ts --workers=1
pnpm build
```

When an SDK dependency, patch, peer context or accepted notice source changes, qualify the new exact source identity and regenerate the affected binding from accepted source bytes before building. Do not weaken this gate to accept a whole-lock hash update. The two catalog records for xmldom/plist outside this SDK closure and all other application dependencies remain separately scoped.

Automated source/build checks do not prove an actual packaged application's offline window behavior. That requires packaged-asset inspection and a native user-interface check.

The scoped Express dependency now selects body-parser 2.4.0. Its official archive integrity, exact package.json and original LICENSE provenance are recorded in `sources/body-parser-2.4.0.json`; this replaces only the old body-parser identity. The other 93 current source identities, original notice bytes and qualification labels remain unchanged, including the previously qualified SDK 1.32.0 source. Only the body-parser node labels and Express child snapshot binding change in the 94-node graph. Semantic provenance JSON is LF-canonicalized for CRLF checkouts; original notice payloads remain byte-exact.
