# Multi-Prompt — agent notes

## UI/UX working agreement

When changing anything user-visible, own the design outcome — don't just apply the literal request. Before reporting UI work done, critique the rendered result against:

- **Hierarchy** — what should the eye hit first (the shared prompt pill is the star of the workspace).
- **Proximity** — status and controls sit next to the thing they describe (per-pane state goes in that pane's titlebar, never in a shared bar).
- **Alignment** — controls sharing a row share a height; nested rounded corners are concentric (inner radius = outer radius − gutter).
- **Targets & affordances** — generous hit areas (whole strip, not a tiny button); hidden gestures (drag, double-click) need a visible hint or a redundant visible control.
- **Feedback** — async actions show in-flight state; failures are visible where they happened.
- **Access** — `:focus-visible` styles, `prefers-reduced-motion` for decorative animation.

Verify by looking (load the extension / ask for a screenshot), and proactively flag UX problems in adjacent UI.

## Design language (workspace + popup)

- Workspace bottom bar: one row of equal-height **54px pills**, `border-radius: 999px` — prompt shell (Send embedded), export-format select (custom SVG chevron; native select arrows collide with curved borders), Export, theme toggle rightmost.
- Accent `#7c3aed`; gradients `#7c3aed → #d946ef` (primary buttons), prompt border drift adds `#06b6d4`/`#22c55e`. Glows stay subtle.
- Theme: CSS vars `--bg/--panel/--border/--text/--muted` + `[data-theme="dark"]`; preference `themePref` (auto/light/dark) in `chrome.storage.local`, synced everywhere via `storage.onChanged`.
- Popup and workspace share idioms (segmented theme toggle, pill controls).

## Layout architecture (workspace tiles)

Tiles are flex children of `#panes`; widths are `flex-grow` weights so proportions survive window resizes. Splitters are rebuilt from DOM order (`rebuildSplitters()`) and only placed between two expanded neighbours. Mouse interactions over iframes require the fixed-position `.drag-overlay` trick (iframes otherwise swallow events mid-drag). Tile order / collapse / maximize state is session-local by design.

## Shared prompt bar (Tiled Windows)

Always opened in Tiled Windows mode (`new_chat`/`open_session` pass `withBar: true` unconditionally) — it is the way to broadcast to every tiled window now that typing in a chatbot's own box defaults to local-only (the `broadcastOnTypePref` switch, default off, gates whether a direct keystroke also broadcasts). `promptbar.html/.js` is a thin, chrome-less `type:"popup"` app window the service worker docks full-width across the bottom of the work area; the chatbot windows are tiled into a shortened rect (`tileScreen()` subtracts `PROMPT_BAR_HEIGHT`). It reuses the workspace bottom-bar idioms (pill prompt, Private/Export/theme). The bar is added to the **managed window set** so `handleBroadcast` accepts it as a source and `closeTiledWindows` tears it down; it broadcasts via the existing `broadcast_prompt` path with **no `source`** (so every model is targeted). Per-model delivery badges come from content scripts reporting `tiled_inject_result` (the managed-window twin of `workspace_inject_result`), forwarded by the background to the bar's tab. Bar geometry is re-applied after tiling (`positionPromptBar`) for Safari, which ignores create-time bounds. When a bar is present it **hosts the panel `[M]` button** (`#pb-menu` → `open_popup`), and the in-page floating FAB is suppressed in every tiled window — `query_managed` returns `hasBar`, and `notifyManagedButtons` sends `hide_managed_button` instead of `show_managed_button`. This is the Safari-friendly equivalent of Tiled-in-a-Tab's shared prompt box. The Tiled-in-a-Tab workspace bar carries the **same `[M]` button** (`#ws-menu` → `open_popup`) for uniformity; both buttons share the `.bar-menu` style in `bar.css`.

## Standalone popup window (`type:"popup"`) — sizing on Safari/macOS

When `chrome.action.openPopup` is unavailable/rejected (Safari), `openActionPopup` falls back to `openPopupWindow`, which opens `popup.html#window` as a standalone `type:"popup"` window. The `#window` hash tells `popup.js` it has no toolbar to auto-size against, so it self-sizes to its content (measure the **body** box — `documentElement` stretches to fill the viewport when content is short — add the once-measured `outerHeight−innerHeight` frame delta, clamp to `availHeight`, center on first fit).

**The non-obvious part is window _state_, not size.** Safari opens these windows in an auto/zoomed-like state and **ignores create-time bounds**, so size must be re-applied via `windows.update` afterward — and any `windows.update({width,height})` is silently ignored while the window is zoomed/tiled. You **must pass `state: "normal"`** to demote it to a freely-resizable window first (both `openPopupWindow` and the snap-back do this). Symptom when you forget: the window looks correctly sized, but the **first titlebar drag balloons it** to the OS's remembered frame, because dragging hands window management to macOS which reasserts the zoomed-state frame. The fix is a **one-shot resize→snap-back** (`popup.js`), attached only **after** a startup settle delay (so our own startup resizes don't consume it) and using a timeout (≈400ms) before reading geometry, since live `outerWidth/Height` are unreliable mid-/just-post-drag. Don't gate the snap on comparing live metrics — attach-after-settle is what distinguishes a real drag from startup.
