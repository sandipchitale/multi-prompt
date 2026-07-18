# Iframe Workspace Spike — Findings

**Branch:** `iframe-workspace` · **Question:** can the chatbots run inside iframes on an
extension page (tab-scoped DNR rules stripping `X-Frame-Options` / CSP), keeping the
browser's real logged-in sessions — giving a single-window UX with a shared prompt box?

## How to run

1. Be logged into Gemini, Claude, and ChatGPT in normal tabs first.
2. Load the unpacked extension from this branch (`chrome://extensions`, Developer mode).
3. Popup → **Open Workspace (experimental)**.
4. Type into the shared prompt box; Enter broadcasts to every pane.

## Findings (testing 2026-06-10)

| Check                                            | Gemini | Claude | ChatGPT |
| ------------------------------------------------ | ------ | ------ | ------- |
| Pane renders logged-in UI (cookie test)          | PASS   | PASS   | PASS    |
| First prompt injects and submits from shared box | PASS   | PASS   | PASS    |
| Response streams normally                        | PASS   | PASS   | PASS    |
| Subsequent prompts from shared box               | flaky (some panes only) → injection hardened, retest |||
| History extraction / export                      | FAIL (handleExport was window-only) → frame path added, retest |||
| `data-mp-turn` stamped on the user turn          | retest with export |||
| Login/refresh redirect behaviour                 | not yet observed | not yet observed | not yet observed |
| Cloudflare / bot challenge observed              | n/a    | none   | none    |
| Frame-busting (blank pane, escaped frame)        | none   | none   | none    |
| Storage-partitioning symptoms (half logged-in)   | none   | none   | none    |

### Fixes applied after first test round
- Multi-turn flakiness: injection now picks the last *visible* editor match (conversation
  views add stray contenteditables), polls up to ~45s for a clickable send button (waits
  out streaming, when sites swap send for a stop control), and verifies the editor emptied
  after the click, retrying the set+click cycle once. Synthetic Enter remains a last
  resort only (untrusted events may be ignored).
- Export: `handleExport` now queries registered workspace frames via `frameId` first,
  falling back to the managed-window tab path per model.

### Multi-line prompts never reached Gemini (both modes)
The fill-verification compared `readPrompt(field) === text.trim()`, i.e. **exact**
string equality against `innerText`. But the innerText algorithm emits **two**
newlines at a `<p>` boundary, and every one of these composers renders one `<p>`
per line — so a multi-line prompt `"a\nb"` always read back as `"a\n\nb"` and the
check declared a perfectly good fill a failure. (Single-line prompts matched on the
first strategy, which is why this hid for so long.)

The false negative was not harmless: `setContentEditableText` burned through all
three strategies down to the **direct-DOM fallback**, which Gemini's Angular
`rich-textarea` does not register — so its send button stayed disabled, the ~45s
button poll expired, and the last-resort synthetic Enter was ignored. Result: the
prompt silently never went to Gemini. ChatGPT/Claude (ProseMirror) survived because
they re-render the fallback into their own model.

Fix: compare via `sameText()` (collapse whitespace runs, then compare) at the three
verification sites; `readPrompt` itself still returns the real text, since the
native-typing broadcast path depends on it. The direct-DOM fallback also now builds
**one `<p>` per line** (blank lines get a `<br>`) — a single `<p>` holding raw
`"\n"`s renders as one flattened run. Negative controls (empty composer, truncated
fill, different text) still compare unequal, so the "site cleared the composer" and
retry paths are unaffected.

### Fixes applied after second test round
Round 2: prompt 2 never appeared in the ChatGPT pane even though the status claimed
"Sent to 3 pane(s)"; the Gemini pane separately lost its first conversation (reloaded
back to the launcher, so prompt 2 started a fresh chat).
- Workspace broadcast was fire-and-forget: a pane that is mid-reload/busy silently
  drops the message. Delivery now requires a per-pane acknowledgment, retries for ~5s,
  and the status line reports exactly which panes accepted vs FAILED.
- Pane conversation restore: workspace frames report their stable conversation URLs
  (recorded per pane); when a frame reloads back to the blank launcher and re-hellos,
  the background steers it back to its conversation URL.
- Workspace state writes serialised (three frames hello simultaneously; interleaved
  read-modify-write could drop a pane from the registry).

### Fixes applied after third test round
Round 3: prompt 2 acked by all panes but ChatGPT's composer stayed completely empty —
the *insertion* failed silently (ChatGPT's ProseMirror reverts DOM mutations that don't
go through its input pipeline). Also: workspace UI was hardcoded dark.
- Contenteditable insertion is now a verified strategy chain: select-all +
  `execCommand('insertText')` (routes through beforeinput) → synthetic paste event
  (rich editors handle paste without trusted events) → direct DOM mutation as last
  resort. Each step is verified by reading the editor back.
- `findEditor` honours selector order (site configs list the specific selector first,
  e.g. `#prompt-textarea`), instead of blindly taking the last visible match.
- Per-pane truth in the status line: each pane reports whether the prompt's user turn
  actually *rendered* (Gemini ✓ Claude ✓ ChatGPT ✗ instead of a blanket "Sent to 3").
- Workspace now follows the popup's theme setting (auto/light/dark, live updates).

### Fixes applied after fourth test round
Round 4: Gemini pane absent from the status line entirely (frame never registered) and
its pane regressed to the launcher; ChatGPT reported ✓ for a prompt that never appeared;
export was missing ChatGPT.
- Likely Gemini root cause: content script matched only `gemini.google.com/app*`, but
  Google can serve `/u/<n>/app` (multi-account) — no content script, no registration,
  no URL capture, no restore. Match broadened to `*://gemini.google.com/*`.
- Hello is now a 2s heartbeat (piggybacking the existing URL-report interval), so a
  reloaded pane or a lost registry re-registers within seconds; registry writes are
  skipped when unchanged. This also keeps export's frame targets fresh.
- Pane title bars show live connection dots (● registered / ○ not) polled every 2s —
  an unregistered pane is now visible before sending instead of after.
- False ✓ fix: "user turn rendered" is re-confirmed 1.5s after first detection
  (optimistic renders that the site rolls back no longer count as sent).
- Console diagnostics (`[Multi-Prompt] …`) at every injection step: editor found,
  insertion strategy used, send click vs synthetic-Enter fallback, turn rendered —
  check the failing pane's console (right-click pane → Inspect) next time.

### Fixes applied after fifth test round (console logs — root causes found)
Logs showed `inject failed: no visible editor` for ChatGPT/Gemini while Claude logged
clean success, plus CSP `frame-ancestors` blocks for `accounts.google.com` (Gemini's
session-rotation frame) and `a.claude.ai` (Claude's sandbox segment).
- **Nested-frame hijack (the injection bug):** with `all_frames: true` the content
  script also ran in helper iframes the sites embed within themselves on the same
  origin; their heartbeat hellos overwrote the pane's frameId, so broadcasts went to
  a frame with no composer. Claude escaped only because its helper frame lives on
  `a.claude.ai` (doesn't match the content-script pattern). Content scripts now run
  only in the tab's top frame (window mode) or a pane root (direct child of the
  workspace page); nested frames opt out entirely.
- **Service-frame blocks:** the chatbots frame accounts.google.com / a.claude.ai
  within themselves; `frame-ancestors` walks the whole ancestor chain (which now
  includes the extension origin) so those frames were blocked — Gemini could not
  rotate session cookies inside the workspace (long-session logout risk). Both hosts
  added to the tab-scoped sub_frame header rule.
- Storage partitioning sighting (informational): Datadog in the Claude/ChatGPT frames
  logs "No storage available for session" — analytics only; core chat unaffected.

## Known design trade-offs (accepted for the spike)

- DNR can only remove whole headers, so the framed site's **entire CSP** is dropped
  inside the panes (including its own XSS protections). Rules are session-only and
  scoped to the workspace tab + `sub_frame` loads, and are removed when the tab closes.
- `accounts.google.com` is deliberately not covered: login pages keep clickjacking
  protection, so an in-pane login redirect dead-ends — sign in via a normal tab.
- Safari has no DNR `modifyHeaders`; the workspace is Chrome-only. Window tiling
  remains the default mode everywhere.
- Typing *inside* a pane does not broadcast yet (only the shared box does); the
  managed-window model doesn't map to frames. In scope only if the spike passes.

## Verdict (2026-06-10, sixth round)

- [x] **PASS** — all three panes render logged-in, every prompt from the shared box
      injects/submits/streams in all three (status: ChatGPT ✓ Claude ✓ Gemini ✓),
      and export aligns every turn across all three models by turn id.

Root causes fixed along the way, in order of impact: nested-frame registry hijack
(`all_frames` + same-origin helper iframes), Gemini content-script match too narrow
(`/app*` missing `/u/<n>/app`), rich-editor insertion bypassing the editors' input
pipelines, fire-and-forget delivery hiding failures, and export not knowing about
frames. The diagnostics (per-pane ✓/✗, connection dots, console tracing — now behind
a `DEBUG` flag in `content/common.js`) were what isolated the real bugs.

### Remaining observations (not blockers)
- The nested service frames (accounts.google.com cookie rotation, a.claude.ai
  sandbox segment) STILL log `frame-ancestors` blocks even though the header rule
  lists those domains — needs investigation (DNR vs CSP-enforcement nuance?).
  Impact: very long workspace sessions might hit a Gemini session-refresh hiccup;
  Claude features served from a.claude.ai (e.g. some artifact rendering) may not
  work in a pane. Workaround: reopen the workspace.
- Datadog (Claude/ChatGPT analytics) logs "No storage available for session" —
  third-party storage partitioning. Usually analytics-only, but the same
  partitioning can reach account-gated features — see the Claude model-config
  episode below.
- "Blocked autofocusing on a <textarea> in a cross-origin subframe" — benign.

### Observed (and since self-resolved): Claude's model picker empty / "model isn't available"
**Status: not currently reproducing.** Seen 2026-07-17, gone 2026-07-18 with no
extension change — so the trigger was on Chrome's or Claude's side, and the failure
mode is worth keeping on record rather than treating as permanent. Kept here as a
diagnostic, not as a shipped limitation (no UI warning is shown; see the end).

In Tiled in a Tab, Claude runs as a **cross-origin iframe under a
`chrome-extension://` top-level**, so Chrome gives it a **partitioned (empty) DOM
storage** bucket keyed to that top-level site. Claude reads its available-model
list / feature gates from `localStorage`/`IndexedDB`, so in the iframe that list
comes back empty: the model picker renders with **no entries**, the app falls back
to a hardcoded default (`claude-3-5-haiku-latest`) the account can't use, and the
`…/completion` request **403s** with "This model isn't available right now."
Login still works (session rides on SameSite=None cookies) and a conversation is
even created, which is why it looks logged-in but can't send.

What does **not** fix it:
- **Logging in fresh inside the iframe** — confirmed by testing: the in-frame
  login flow *completes*, yet you land in the exact same empty-picker / 403 state.
  This proves the cause is the partitioned DOM storage, **not** authentication — a
  valid session in an empty storage partition still has no model list to read.
- **Storage Access API** (`document.requestStorageAccess()` from the pane content
  script) — restores *cookies*, not partitioned DOM storage; the config still
  loads empty. (Also, reloading the pane on the grant gesture raced Claude's
  in-flight conversation create → spurious `title`/conversation 404s. Removed.)
- **`chrome://flags/#third-party-storage-partitioning` → Disabled** — the flag no
  longer exists in current Chrome, so this opt-out is gone. (Enterprise policies
  `DefaultThirdPartyStoragePartitioningSetting` /
  `ThirdPartyStoragePartitioningBlockedForOrigins` reportedly still exist —
  untested here.)
- There is **no extension API** to un-partition a framed origin's DOM storage.

What (probably) did fix it: nothing we shipped. Candidates, in order — a Claude
deploy that no longer reads the model list from partitioned storage; the
partition getting populated by the in-frame login done while debugging (which
would make the recovery profile-local, not universal); a Chrome change.

Product decision: **do not** ship a per-tile warning for this. A hard-coded
"Claude is broken here" badge was briefly added and then removed once the symptom
disappeared — a permanent warning for an intermittent, third-party-controlled
failure is worse than none. If this recurs and needs surfacing, gate it on
**runtime detection** of the actual failure, not on a model allow-list.

### Promoted from spike into the product
- Two explicit modes in the popup: **New Chat (Tiled Windows)** (the original
  separate-OS-windows flow + Close Tiles) and **New Chat (Workspace)** (single-tab
  iframes). Saved sessions can be reopened in **either** mode (Tiled / Workspace
  buttons in the Saved Sessions row).
- Workspace can now open a saved session: `openWorkspace(folderId)` stashes the
  target, `initWorkspace` loads that session's saved per-model URLs + turn ledger,
  panes load the real conversations, and each pane is re-stamped via `reattach_turns`
  on registration so export alignment survives — same guarantee as tiled reopen.

### Multiple independent workspaces
Workspace state is now a map keyed by tab id, so **any number of workspace tabs**
can be open at once (fresh chats or reopened saved sessions). Each tab's shared
prompt box broadcasts only to the panes in that same tab; per-pane status results
are routed back to the originating tab only (`workspace_pane_result` via the
background, not a runtime broadcast). One declarativeNetRequest rule covers all
open workspace tabs via its `tabIds` list, re-synced as tabs open/close. The
saved-session target travels in the page hash (`#session=<id>`) so each tab is
self-describing. Export captures whichever workspace tab is active in the
last-focused window. Tiled mode remains single-set (each New Chat/Open-tiled
closes the previous tiles first) to avoid an unusable crowd of windows.

### Added (Tiled in a Tab polish)
- **Resizable splitters** between panes: drag the bar between two panes to shift
  flex-grow weight (proportions survive a window resize); a transparent overlay
  covers the iframes during the drag so the parent keeps the mouse.
- **Per-tab Export** in the workspace bar (Markdown / PDF), exporting only that
  tab's panes — `export_workspace` → `exportWorkspaceTab(sender)`. Markdown/Download
  helpers moved into the shared `align.js` (loaded by popup, export, and workspace).
- **Deselection respected on reopen**: `filterToSelected()` drops any chatbot the
  user has currently deselected when reopening a saved session in either mode, so no
  window/pane/splitter is created for it (falls back to the full set if all are
  deselected). Fresh chats already used the selected set.

### Robustness hardening (post-critique)
- **Export XSS**: `parseMarkdownToHtml` now escapes `"`/`'` as well as `<>&`, so a
  crafted `[text](https://…")` link in a chat response can't break out of the
  `href=""` we build and inject an attribute. (A full marked+DOMPurify swap is the
  heavier option if shipping to the store; the quote-escape closes the actual hole
  without a dependency.)
- **Bookmark URL length**: the ledger is now spread across as many sequenced
  bookkeeping bookmarks as needed — a primary (seq 0, carrying order + custom
  title) plus continuations titled `… -02`, `… -03`, each a turn chunk kept under
  ~7000 chars (`chunkSessionMeta`). Readers gather every meta bookmark in the
  folder, sort by `seq`, and concatenate turns (`collectMetaBookmarks`/`mergeMeta`).
  `saveMeta` reconciles bookmarks↔chunks (update / create / delete surplus). So a
  long session keeps *all* its prompt prefixes instead of dropping them; the
  single-bookmark drop-prefix fallback (`buildMetaUrl`) remains only for the rare
  non-chunked write (rename).
- Already in place from earlier work (so noted, not re-done): DNR rule is scoped to
  `sub_frame` + tabIds + requestDomains (never main-frame loads); export print CSS
  already uses `break-inside: avoid`; content scripts opt out of nested helper
  frames so listeners aren't double-bound on SPA-embedded iframes.

### Tiled-in-a-Tab session persistence (now implemented)
Tab-mode chats now save like tiled ones. `handleWorkspaceBroadcast` calls
`persistWorkspaceTurn` → `doPersistWorkspaceTurn`, which appends to the tab's
ledger and (on the first prompt) lazily creates the durable session record via
`sessionRepo`, mirroring the tiled `recordLedgerTurn`/`ensureSessionPersisted`
path but keyed to the per-tab workspace entry (serialised through
`workspacePersistChain`). Reopening a saved session in a tab appends new turns to
that same session. `captureWorkspaceUrl` now also points each pane's saved
bookmark at the live conversation permalink (re-persisting on every stable report
to survive the create-vs-report race). `initWorkspace` seeds the entry with
`order`/`folderId`/`bookmarks`/`metaBookmarkId`.

### Private / temporary chat mode (implemented)
All three chatbots expose a private/temporary-chat toggle on their fresh-chat
launcher (Gemini `mat-icon[gemini_chat_temp]`, Claude's ghost-icon button,
ChatGPT `button[aria-label^="Turn on temporary"]`). A popup checkbox
(`privateChatPref`) makes every New Chat — both modes — click that toggle
automatically as soon as each chat is ready; the workspace bar also gets a
global **Private** pill that switches all panes on demand. Key mechanics:
- The site toggles are TOGGLES: clicking twice exits private mode. The content
  script keeps a page-lifetime guard (`privateModeEntered`, reset by
  `new_chat`) so repeated `enter_private_chat` requests (launch auto-privatize
  + bar button + heartbeat re-registration) are idempotent. ChatGPT also has a
  detectable on-state (`?temporary-chat=true` / "Turn off temporary chat"),
  used as ground truth for verification.
- Private chats are deliberately never saved (their permalinks are ephemeral):
  `doRecordLedgerTurn`, `doPersistWorkspaceTurn`, and `captureWorkspaceUrl`
  all skip when the session/tab is private — and going private from the bar
  also disables the pane URL-restore steering (pre-filled `navigated`), so a
  reloaded pane is not steered back to an abandoned conversation.
- Per-pane truth in the titlebar: each pane's hello heartbeat reports its
  private state; the workspace shows a small ghost glyph next to the
  connection dot, and the bar pill lights up once every connected pane is
  actually private.
- Reopened saved sessions never auto-privatize (they are existing, non-private
  conversations); the bar button remains available as an explicit action.

### Still out of scope (follow-ups)
In-pane typing broadcast, per-pane new-chat/reload controls, drag-to-reorder
panes, Safari fallback messaging (no DNR modifyHeaders there — window tiling
remains the Safari path).
