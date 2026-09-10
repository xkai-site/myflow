# Progress
## Direct-image link simplification
- Inspected source, types, documentation and host tests. Starting state: only unrelated untracked plans/openai-image-async-client-research.md; retain it.
- Removed src/gallery.ts and test/gallery.test.ts; removed galleryPath from current types. Renderer/publisher use formatImageLink per image with no preview-file writes; old metadata is ignored. Kept image preview and Saved notifications.
- Updated README and host regressions: direct targets, URI encoding/control escapes, narrow wrapping, theme/capability refresh, single/batch deduplication, RPC URLs, serialized historical entries, missing/corrupt preview fallback, invalid path guard and original/HTML fixture preservation.
- Validation: 31/31 unit tests, explicit-SDK host suite and 30/30 baseline request comparisons passed. git diff --check passed (LF/CRLF notices only). No real credentials, paid requests, terminal mouse clicks, new dependencies, staged files or commits.
## Current c13c87fc investigation (no code changes)
- Read exact diagnostic, aggregate14 logs, inspect current adapter/HTTP trace/validation/cancellation and installed host dispatcher, re-read existing >70s local fixture results. No tests or external requests run this turn.
- Fresh Clash correlation identifies a chatgpt.com connection660ms after start via 美国LA-优化2-GPT; no close reason for that connection at failure time. Cannot uniquely join because diagnostic intentionally omits socket port. Existing output filenames include both new models, so blanket unsupported-model diagnosis is unjustified.
- Report prioritizes approximately60s actual-route cutoff exposed by slow nonstreaming generation, explicitly unproven closer/cause; no claim that prompt length, dimensions, quota or model incompatibility is established. Next live comparisons require approval and resolved usage limits; no automatic retry/TLS/proxy changes.
- Preserved all pre-existing modified/untracked files; only these three planning records changed. An initial source search used nonexistent adapters/transport glob, then corrected to actual flat src files; no execution failure or code modification.
## Actual Clash HTTPS local probe
- Added opt-in test/clash-https-probe.mjs, generated ephemeral certificate/key in OS temp, spawned child with scoped CA trust, ran installed host dispatcher to loopback HTTPS via actual7897, cleaned certificate/key. No production edits or external requests.
- BLOCKED: Clash IPCIDR(127.0.0.1/32) REJECT at01:16:27+08 (line8294), ECONNRESET36ms beforeTLS, zero HTTP requests received. Cannot conclude anything about70-second proxy/TLS wait; do not equate with production UND_ERR_SOCKET60s. No retry or rule modification. Evidence saved plans/clash-https-probe-result.json.
## Host dispatcher local-only verification
- Inspected installed dispatcher/main/settings/Undici implementation and safe allowlisted settings/environment. npm Undici8.9.0, defaults300000ms; no new60s limit identified. Disk timeout unset, project settings absent, inherited proxy local7897.
- Added explicit slow probe test/host-dispatcher-probe.mjs outside normal npm test. Two independent child processes tested actual host EnvHttpProxyAgent + matching fetch: direct70108ms and synthetic CONNECT tunnel70147ms, both HTTP200. Each one POST, tunnel one CONNECT; no external requests/credentials/TLS changes. Safe JSON evidence saved in plans/host-dispatcher-{direct,tunnel}-result.json.
- No production source/model/Pi/Clash settings edits. Planning records and local-only test/results only. Current Pi heap, real Clash and HTTPS/backend still unverified; not claiming socket root cause or fix.
## Remove obsolete model rejection tests
- Updated test/model-config.test.ts, test/command.test.ts and test/host-lifecycle.mjs only (plus planning records); did not change enabled model settings or production code.
- Removed forced-disabled/forbidden-default assumptions for both 2.5 models. Added positive default-selection and TUI selection coverage; retained generic disabled behavior with independent synthetic fixtures.
- 36/36 unit tests, SDK host suite, and 30 pinned-baseline scenarios passed. git diff --check passed with existing CRLF notices. No paid/live probes run; existing network-timeline changes preserved.
## Network timeline implementation
- Added passive request-identity/async-context Undici observation with bounded events, cleanup, fetch-only fallback; success/error logs, imagegen response ID and OpenAI safe settings. Preserved cancellation no-log behavior, all transport values and timeouts.
- Tests: 11 focused diagnostics/timeline plus one real local peer-close passed; 30 baseline mocks unchanged. Full suite 31/33 before last new test (two existing model config failures). Host success-log assertions migrated; host now stops at Image size UI question assertion line 114. No real image requests.
- README explains interpretation/limitations, UTC correlation, no sensitive payloads and manual log cleanup. Actual proxy-side attribution remains pending new user logs; no DNS/TCP/TLS individual handshake timings claimed.
## User-approved single live probe
- Inspected Codex CLI/version/features and generated app-server bindings in OS temp; no direct image method found. Did not launch a Codex Agent or claim official-client comparison.
- Added opt-in local test/live-probe.mjs, executed once after user continue. Actual plugin adapter/current local Codex auth/host proxy dispatcher returned HTTP 429 usage limit in 1792 ms; exactly one call, no retries or images. No production or credential/config changes.
- Saved sanitized summary and updated investigation report. Further real requests stopped due to explicit usage limit. Earlier 60-second socket failure remains unexplained. git diff --check passed with existing CRLF warnings.
## Official OpenAI API / Codex request investigation
- Read new GPT Image 2 log (60143 ms/socket close), fetched official Images generation/edit/tool docs and all relevant GPT Image model pages; examined official openai/codex image schema, endpoint, tool and backend code.
- Confirmed same JSON request family. Codex tool still pins Image 2; missing x-codex-image-turn-id is a real header difference but not a proven mandatory requirement/root cause. Public 2.5 support does not establish this backend's model availability.
- Inspected Pi host dispatcher and allowlisted timeout/proxy settings only: EnvHttpProxyAgent installed globally; 300000 ms default. Two credential-free GETs through host dispatcher returned 403 HTML (ChatGPT, 440 ms) and 401 JSON (public API, 565 ms); no authentication or image POST.
- Re-ran baseline: 30/30 identical legacy requests passed. npm test: 29/31; two existing tests assume disabled 2.5 config while user has enabled:true. Preserved all config/code and documented failures rather than resetting user intent.
- Wrote plans/openai-image-request-investigation.md with actual default-request schematic, official sources, uncertainties and one-at-a-time live verification plan requiring user confirmation. No production changes, real credential reads, paid requests, proxy changes, staging or commits. Root cause and online recovery remain unverified.
## Working-commit regression investigation
- Read user-specified log, compared HEAD e08e3f9 / last plugin commit 4df3ccd with current request/auth/command/runtime, and re-fetched public Flare/Sunburst documentation. No real auth or paid calls.
- Found default rollout gap: newly documented public API models were exposed in a Codex OAuth backend without live compatibility proof. Preserved definitions with enabled:false; validated CLI/menu/runtime rejection before auth/fetch and enabled default-model constraints. Legacy models/accounts/gallery remain intact.
- Added repository-only pinned-baseline differential test. Initial run caught adapter quality:auto fallback omission; restored and all 30 exact request/auth comparison scenarios passed. This is not proof of the Flare error's root cause.
- Updated UND_ERR_SOCKET hint to acknowledge request/model compatibility, not just proxy/network configuration. Documented opt-in limits and offline-vs-live verification distinction.
- Final rerun: 31 offline tests, SDK-host suite and all 30 pinned-baseline scenarios passed. All five models still covered by explicit-opt-in test-only serialization matrix. Default disabled CLI, runtime and TUI paths tested without generation/auth calls. git diff --check and all source/test whitespace checks passed (existing CRLF notices only). No live generation, new dependencies, staging or commits; do not claim online recovery.
## Network diagnostics follow-up
- Traced fetch failures through adapters/downloader and two runtime message-only catches. No existing log facility for image requests.
- Added errors.ts redaction and diagnostics.ts bounded cause-chain/logging, shared HTTP wrapper for request + body failures, adapter operation/model context, and per-generation logger closure in runtime. No extension UI/preview/config/account changes this turn.
- Added nine focused diagnostic tests covering nested DNS/TLS/socket/timeouts, AggregateError/cycles, JSON/HTML HTTP failures, header/payload request IDs, response-read failures, both adapters and signed CDN downloads, redaction/terminal controls, cancel vs timeout, log failure, success/no-log and safe atomic/symlink-rejecting storage.
- 30/30 offline tests passed. Explicit-SDK host suite passed with both-provider failures and RPC notification/log-path checks; one request/one log, no automatic retries. Existing image/gallery/OSC8/reload coverage still passes.
- Updated README troubleshooting and root Git ignore for `.pi/image-generation-logs/`. Logs are failure-only and relative to generation cwd; no raw stack/request/response body or environment dumps.
- `git diff --check` passed with pre-existing CRLF notices; new/untracked source/tests have clean whitespace. No real paid generation/credential checks or new dependencies. Actual network cause still requires a fresh failure after reload.
## Image-first browser preview
- Located gallery renderer and existing gallery tests; fetched current Web Interface Guidelines.
- Existing worktree is dirty, including gallery/tests and planning files; preserve previous work and limit changes to this follow-up.
- Updated gallery HTML/CSS, focused gallery regression tests and README; 21 offline tests plus host lifecycle suite passed. No generation/authentication/TUI source changes or new dependencies.
- Used installed Playwright API + cached Chromium, with synthetic PNG fixtures in OS temp directory and offline browser context. Nine desktop/mobile/portrait/landscape/zoom-equivalent layout combinations passed; keyboard skip/focus and both original links work; forced-colors styles apply; no overflow, errors or remote resource requests.
- Found local file download attribute is ignored by Chromium (navigates to PNG); removed misleading button and kept reliable original view. Final browser pass completed; inspected desktop multi/mobile portrait screenshots.
- Re-ran 21/21 offline tests and explicit-SDK host suite successfully. git diff --check passed (CRLF notices); untracked gallery/test files have no trailing whitespace.
- Browser artifacts/check script: C:/Users/HP/AppData/Local/Temp/gallery-design-cgHqZ4/. Only new galleries get updated design; no existing HTML/image or credentials modified, no paid requests.
## Duplicate-link follow-up
- Fixed publishOutcome to omit gallery link from TUI notification while preserving durable clickable entry and Saved paths.
- Added host regression checks across single/batch outcomes and both capability modes: exactly one visible preview URL, correct click target, notification has only Saved count/paths. Existing RPC/reload checks retained.
- 20 offline tests + host suite passed; targeted diff check passed with CRLF warnings. No real generation or manual TUI verification performed this turn.

## GPT Image 2.5 additive update
- Added Sunburst/Flare entries in models.jsonc with independent stable selectors and xhigh/max quality. No runtime adapter, credentials, endpoint or dependency changes.
- Compared against pre-edit config snapshot: all original provider fields and all original model fields deeply equal; exactly two entries appended.
- Added config/CLI/request regression coverage (both tasks, six qualities, documented dimensions, old quality rejection and unchanged account defaults); 20 offline tests passed.
- Host test needs explicit global SDK URL. First SDK-backed run exposed stale hardcoded six-image expectation; updated counts to derive from catalog size (ten generated/edit mock images).
- Final host run passed with file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js; gallery/links/reload checks also pass. git diff --check passed with existing CRLF warnings only.
- No paid/network generation calls, real account validation, credential access, staging or commits. Reload plugin and explicitly select openai-sunburst/openai-flare; original openai remains GPT Image 2.
## Clickable-link follow-up
- Added src/preview-link.ts using Pi's hyperlink() + getCapabilities(), theme mdLink color and underline. No raw ANSI in session metadata or RPC output.
- Entry links compute current theme/capabilities on render; saved notifications now use the same hyperlink format in TUI.
- Documented Windows Terminal Ctrl+click vs traditional CMD/PowerShell console limitations and PI_HYPERLINKS detection override (does not add terminal support).
- 18 offline tests and enhanced host suite passed; checks verify OSC 8 actual click targets, escaping, wrapping, link closure, theme changes, notification/reload and unsupported/RPC fallback. No real terminal mouse click/browser launch tested.

- Reviewed Pi extensions and TUI docs in prior turn.
- Confirmed user wants a preview link only; multi-image gallery presentation, not batch generation.
- Implemented static local gallery with relative image links, HTML escaping, unique/atomic saves and existing output-directory safety checks.
- publishOutcome now awaits best-effort gallery creation, preserves saved images on failure, emits a copyable file URI and persists galleryPath on the first image entry.
- Added gallery tests, host rendering/reload/failure checks and README usage.
- Host offline integration checks passed. Initial npm test command used the wrong cwd (ENOENT); corrected plugin-directory run passed all 18 tests (0 failed/skipped).
- git diff --check passed with LF/CRLF conversion warnings only. Pre-existing changes preserved; no commit/staging or new dependencies.
- Real browser/TUI manual verification and paid generation were not run. Use /reload, then /image to receive the local gallery link.
