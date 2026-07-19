# Toast notifications

```yaml
id: toast
status: implemented
version: 1
owner: websynth
related:
  - architecture
  - session-autosave   # primary consumer (the load-undo toast)
source:
  - src/ui/components/toast.ts
  - src/ui/styles/toast.module.css
```

## Background / Why

Destructive-but-undoable actions (loading a demo/song over the working session)
need lightweight, non-blocking feedback with a one-click escape hatch — a
confirm dialog for every load would nag, and a silent overwrite loses work.
Nothing transient existed: all feedback ran through the modal `dialog.md`
helpers. This adds the app's one snackbar/toast facility, designed so a caller
can safely park state (e.g. the pre-load session stash) in the toast's closure
and have a guaranteed release signal.

## Requirements

- **REQ-1** — `showToast(opts)` renders a message with an optional single
  action button and an always-present ✕ dismiss button, in a fixed
  bottom-center host overlaying the app.
- **REQ-2** — Single-slot: at most one toast exists at a time. Showing a new
  toast dismisses the previous one first (its `onDismiss` fires before the new
  toast mounts).
- **REQ-3** — Auto-dismiss after `durationMs` (default 8000 ms);
  `durationMs: 0` means sticky (only manual/action/replacement dismissal).
- **REQ-4** — The action callback fires **at most once**, then the toast
  dismisses itself.
- **REQ-5** — `onDismiss` listeners fire exactly once, on every exit path:
  timeout, ✕ click, action click, programmatic `dismiss()`, or replacement.
  This is the contract that lets consumers release closure-held state.
- **REQ-6** — Non-modal and accessible: `role="status"` + `aria-live="polite"`,
  never steals focus, never blocks pointer input outside its own box (the host
  is `pointer-events: none`; the toast re-enables them).
- **REQ-7** — Layering: above panels and floating windows, **below** the Modal
  backdrop (z 1000) and the tour overlay (z 1100) — an alert or tour opened
  over a live toast must cover it.
- **REQ-8** — Stable testids: `toast-host`, `toast` (overridable via
  `opts.testId`), `toast-action`, `toast-dismiss`.

## Technical design

### Contract / public interface

```ts
export interface ToastOptions {
  message: string;
  actionLabel?: string;      // renders the single action button
  onAction?: () => void;     // at-most-once, then dismiss
  durationMs?: number;       // default 8000; 0 = sticky
  testId?: string;           // default 'toast'
}
export interface ToastHandle {
  readonly el: HTMLElement;
  dismiss(): void;
  onDismiss(fn: () => void): void;
}
export function showToast(opts: ToastOptions): ToastHandle;
```

### Layer touchpoints & ordering

- Pure DOM component (`ui/components/`), no bus/engine dependencies; buttons
  come from the shared `createButton` factory in the switch style, matching
  `dialog.md`'s convention.
- The host `<div>` is created lazily on first `showToast` and appended to
  `document.body` (module-level singleton — the replace-not-stack rule is
  structural: the host has at most one child).
- Entry is animated via CSS only; exit is immediate removal (no exit
  transition to await — keeps jsdom tests and rapid replacement simple).

### Persistence

None — toasts are ephemeral by definition.

## Scenarios (BDD)

```gherkin
Scenario: action fires once and dismisses
  Given a toast with an Undo action
  When the action button is clicked twice rapidly
  Then the callback ran exactly once
  And the toast has left the DOM and onDismiss fired once
# pinned by: tests/ui/toast.test.ts

Scenario: replacement releases the previous toast
  Given a visible toast A with an onDismiss listener
  When showToast is called for toast B
  Then A's onDismiss has fired and only B is in the host
# pinned by: tests/ui/toast.test.ts

Scenario: auto-dismiss honours durationMs
  Given a toast with durationMs 5000
  When 5000 ms elapse
  Then the toast is gone and onDismiss fired
# pinned by: tests/ui/toast.test.ts (fake timers)

Scenario: sticky toast never times out
  Given a toast with durationMs 0
  When any amount of time elapses
  Then it remains until dismissed manually
# pinned by: tests/ui/toast.test.ts
```

## Tests & verification

- Unit: `tests/ui/toast.test.ts` (jsdom + fake timers) — `npm test`
- E2E: exercised through the session-undo flow in `e2e/session.spec.ts`
  (`song-undo-toast` / `toast-action`) — `npm run e2e`
- Typecheck: `npm run typecheck`
