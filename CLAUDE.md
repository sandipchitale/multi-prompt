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
