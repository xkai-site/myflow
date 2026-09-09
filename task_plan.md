# Image generation preview link

## Scope
Keep existing image saving/TUI preview. Add an optional-to-open local HTML gallery link after success, supporting every image in an outcome without changing request count. Preserve pre-existing working-tree changes.

## Phases
- [complete] Inspect persistence and host tests/API example.
- [complete] Implement safe local gallery, link publication and documentation.
- [complete] Run offline tests and host integration checks.

## Follow-up: clickable links
- [complete] Inspect Pi OSC 8 link API, rendering, and terminal limitations.
- [complete] Add styled real hyperlinks for TUI while keeping RPC/plain fallback.
- [complete] Test hyperlink targets, wrapping, reload and documentation.
- Follow-up validation: 18 offline tests + host suite passed; true OSC 8 target/cell checks at widths 24/60, themed underline, TUI notification, RPC escape-free output and unsupported terminal fallback. diff --check passed with LF/CRLF warnings only. Actual terminal Ctrl+click still requires user verification.

## Follow-up: duplicate gallery links
- [complete] Identify duplicate TUI surfaces: entry renderer and Saved notification both show the same gallery URL.
- [complete] Keep one durable link in the first entry; retain Saved paths and non-TUI notification URL. Add single/batch regression coverage.
- [complete] 20 offline tests + host tests passed; single/batch + supported/unsupported terminal display has exactly one visible gallery URL. diff --check passed (CRLF warnings only). Recent model additions and existing changes preserved.

## Verification
- Plugin npm test: 18 passed, 0 failed/skipped.
- Host SDK/Jiti checks: passed (mock generation/edit, gallery publication/rendering/reload, nonfatal preview failure).
- git diff --check: passed; only existing Windows LF/CRLF conversion warnings.
- No paid image requests, browser launch or real TUI/browser manual verification performed.

## Follow-up: latest OpenAI image model (preserve configuration)
- [complete] Verify the official release/model ID and inspect config/adapter compatibility.
- [complete] Add the new models without removing old models, credentials, defaults or existing work.
- [complete] Update regression tests/docs and run offline validation: 20 tests passed, explicit-SDK host integration passed across five models/ten mock images, git diff --check passed (existing CRLF warnings only). Pre-edit snapshot comparison proves original models/providers unchanged. No real image requests.

## Follow-up: image-first browser preview
- [complete] Inspect gallery and fresh Web Interface Guidelines; preserve all existing changes.
- [complete] Remove developer-facing copy/metadata; implement unclipped responsive image presentation and accessible essential actions.
- [complete] Add offline regression coverage and verify desktop/mobile browser layout without paid generation.
- Final validation: 21/21 offline tests and explicit-SDK host suite passed. Chromium passed nine viewport/layout combinations, keyboard skip/focus/original links, forced colors, no overflow/browser errors/remote requests. Desktop multi and mobile portrait screenshots visually inspected.
- git diff --check passed (existing CRLF notices only); untracked gallery/test files separately checked for trailing whitespace.
- Browser artifacts and reproducible temporary check: C:/Users/HP/AppData/Local/Temp/gallery-design-cgHqZ4/check.mjs. No paid generation, credentials, new dependencies, staged changes or commits. Existing HTML galleries are not rewritten.
- Scope: static gallery HTML/CSS, focused tests and usage docs; no changes to Pi APIs, generation, authentication or link publication.

## Follow-up: actionable network errors and safe diagnostics
- [complete] Trace cause loss, request stages and host interfaces; preserve all prior work. Read Pi README/extensions/environment docs completely; runtime closures avoid SDK API/metadata changes.
- [complete] Add sanitized causal network diagnostics, HTTP status/request IDs, best-effort local failure logs and user guidance. No automatic retries or real paid requests.
- [complete] Cover network/body/HTTP/download failures, redaction, cancellation, logging failure and host propagation with offline tests; document troubleshooting.
- Final validation: 30/30 offline tests passed, plus explicit-SDK host checks for both providers' failure propagation and RPC notification → existing diagnostic file. No automatic retries; successful requests produce no logs.
- `git diff --check` passed (existing CRLF notices); new/untracked diagnostic and test files separately checked for trailing whitespace. No real generation, account validation, credential reads, dependency installs, staging or commits.
- Remaining: user's actual failure must occur under the updated plugin to obtain its original cause. No claim that network connectivity itself is repaired.

## Follow-up: regression against last working Git commit
- [complete] Compare HEAD e08e3f9 request/auth/runtime against current implementation using actual pinned legacy code and offline request capture: 30 scenarios pass.
- [complete] Re-check new model compatibility evidence: public API docs do not prove Codex OAuth support. Disable unverified 2.5 definitions by default without deleting them; preserve original model/UI/config/accounts. Restore confirmed direct-adapter quality:auto fallback regression.
- [complete] Add regression tests: disabled model schema/CLI/menu/runtime/auth guard, explicit-opt-in mock matrix, and pinned Git baseline comparisons. Final validation: 31/31 offline tests + SDK host suite + 30 pinned-baseline differential scenarios passed. git diff --check and source/test whitespace checks passed (existing CRLF notices only). No live generation, real credential reads, new dependencies, staged changes or commits. Online recovery and new-model compatibility remain unverified.
- User-provided diagnostic: gpt-image-2.5-flare, UND_ERR_SOCKET / other side closed, 60307 ms, no HTTP headers. This proves a closed connection, not that proxy/network configuration is the root cause. Last working version only used gpt-image-2.

## Follow-up: official API versus current OpenAI requests
- [complete] Fetch current official model/API documentation and examine the newly supplied GPT Image 2 diagnostic.
- [complete] Capture current serialized requests offline; inspect auth, endpoint and transport against official contracts and Codex upstream. Baseline 30/30 passed; no mandatory JSON/body correction identified.
- [complete] Document confirmed mismatches versus hypotheses in plans/openai-image-request-investigation.md. No production code/config changes justified without controlled live evidence. Two credential-free GET probes only; no paid generation/retries. Root cause remains unproven.
- Current npm test: 29/31 passed; two existing config-coupled tests assume disabled 2.5 models, but current user configuration enables them. Preserve enabled:true rather than modify it to satisfy tests.

## Follow-up: user-approved live verification
- [complete] Inspect Codex CLI 0.153.4 and generated protocol: image_generation enabled, no direct image RPC found. Official Agent generation not launched to avoid uncontrolled request count.
- [complete] Execute actual plugin adapter once with current live Codex credential and host dispatcher: HTTP 429 usage limit, 1792 ms total. No retry or image output.
- [complete] Save sanitized result/report. Stop paid comparisons while usage-limited; official-client comparison and earlier socket root cause remain unresolved. Production code/config preserved.

## Follow-up: request-scoped network timeline
- [complete] Add passive Undici request-scoped timing, success/failure logs and safe metadata without changing transport, headers, timeout or retries. Explicit cancellation keeps prior no-log behavior.
- [complete] Offline concurrent isolation, event cleanup, redaction and real local HTTP success/peer-close tests; update troubleshooting docs.
- Validation: focused diagnostics/timeline 12 tests passed; baseline 30/30 identical mocked requests. Full suite before adding final peer-close test: 31/33 (two known config-coupled failures). Host test updated for success logs, then blocked at existing Image size UI assertion line 114; not claiming full host suite pass. No changes to model/UI configuration to force tests green.
- No new paid requests; preserve user-enabled models and existing modifications.

## Follow-up: remove obsolete GPT Image 2.5 test restrictions
- [complete] Remove assertions that Sunburst/Flare must be disabled or cannot be defaults; test the actual enabled catalog without overriding it. Added positive default-model validation for both.
- [complete] Generic enabled:false CLI/runtime behavior now uses synthetic test-only models, avoiding empty-loop passes. TUI tests select each real 2.5 model and advance to size selection, then cancel before authentication.
- [complete] 36/36 unit tests, host suite and 30 baseline differential cases passed. git diff --check passed (existing CRLF notices). Only three test files and planning records changed; runtime/model configuration, live-probe and timeline work preserved. No paid requests.

## Errors
- Current npm test failed 2/31: model-config.test.ts:33 expects enabled:false; :89 expects enabled Flare to be rejected as default. Existing tests and user-enabled config disagree; no runtime request failure was reproduced by these tests. Documented without altering configuration.
- Current research: Codex guessed legacy core handler/provider/default_client source paths returned 404 (upstream reorganized); search for new paths. GitHub issue fetch hit anonymous API rate limit; no authentication changes made. Broad host rg matched minified bundles and truncated; use bounded/scoped reads instead.
- Baseline differential first run failed because direct adapter no longer included quality:auto when omitted; restored legacy default, rerun passed all 30 scenarios. Normal configured command already supplied quality; do not misidentify this as the demonstrated cause of Flare disconnection.
- Findings heading edit used an incorrect heading and made no change; read the file and inserted a new regression section using the actual heading.
- Wan model diagnostic edit matched both request/download blocks due substring indentation; retried with unique surrounding closing delimiters.
- Browser check initially timed out waiting 30s for file:// download. Focused probe confirmed Chromium navigates to original instead of downloading. Removed misleading download action; final browser check passes.
- Chrome not found at standard Program Files path; use preinstalled Chromium executable in Playwright cache, no installation required.
- Host integration initially asserted six images for three models; new five-model catalog correctly produced ten. Replace hardcoded gallery counts with config-derived counts, preserving all-model coverage.
- Default host test cannot resolve globally installed @earendil-works/pi-coding-agent; retry with the documented explicit SDK file URL.
- OpenAI announcement fetch returned HTTP 403; official developer model/guide pages fetched successfully instead.
- Initially tried test/transports.test.ts (ENOENT); directory listing identifies test/transport.test.ts.
- Repository-wide rg encountered Windows `nul`; scope subsequent searches to plugin files.
- Read terminal-image.js with offset beyond EOF while locating helper; used rg to locate hyperlink at line 518 and read the correct slice.
- Follow-up rg initially looked for pi-tui at global package root; it is nested under pi-coding-agent/node_modules. Use the host-resolved dependency.
- Initial npm test was run from repository root (no package.json, ENOENT); rerun from work/scripts/pi/pi-image-generation. Host test already passed.
