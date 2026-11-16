# Peek motion: Genie in, Seamless after

The owner picked the hybrid from `extras/peek-prototype` (2026-11-16): a Peek opens with a Genie warp out of the link it
came from, and everything after that (pinch, settle, close, Open as Tab) is Seamless, one uniform scale of a page that
is already laid out at the size it will have as a tab.

## Design

- **One native owner.** `PeekStage` (`packages/shell/ios/PeekStage.swift`) holds the scrim, the card chrome and the
  page in containers it owns, and one state machine (`PeekMotion.swift`) drives every frame from a display link:
  waiting, entrance, open, gesture, settle, close, promote. JS starts it (`begin`), asks it to close or promote, and hears
  back once per generation (`onPeekDone`). Nothing in React animates the card.
- **Fixed viewport.** The page is laid out from the first frame at the rectangle it will fill as a tab
  (`components/peek/peekGeometry.ts`: the card minus the toolbar row, the bookmarks bar when it shows and the share bar),
  and shown at one uniform scale `k` inside the card. Open as Tab springs that scale to 1 and the page origin to its tab
  position, then hands the same Chrome tab to the tab's pane at the same size: no resize, no reflow, no reload.
- **Chrome fades on its own.** The card's bar, backdrop and rims follow the card's scale but fade by their own curve, so
  the page never scales twice.
- **Genie is a mesh on the card, checked at runtime.** `ArdiaPeekMesh` (`packages/shell/ios/ArdiaPeekMesh.m`) checks
  the private `CAMeshTransform` class, its constructor's selector, argument count and the layout of its vertex and face
  structs before it calls anything, validates every vertex and face, and catches exceptions. Any failure plays the
  Seamless entrance instead (`affine`), and reduced motion fades (`fade`).
- **Interrupting the Genie.** A pinch, close or promote during the warp freezes the warp's last presented vertices and
  opacity as a residual on top of the Seamless state: a zero pinch moves no vertex, and the residual springs away while
  the uniform scale follows the fingers.
- **Input.** Core Animation transforms don't move AppKit's geometry, so while the page is scaled the stage maps each
  mouse and scroll event through the inverse of what is on screen before Chrome sees it. During the warp the card takes
  no clicks (the page isn't where it looks); pinch and dismiss still work.
- **Test keys.** `ARDIA_TEST=peekMesh=unavailable|throws`, `peekReady=never`, `peekReduceMotion`, `peekSlow=<n>`.
- **Readiness.** `begin` waits for the page's first drawn frame (`-[ArdiaWebView showsPaintedFrame]`, polled each
  display frame), at most `PEEK_READY_TIMEOUT` (150 ms); then the entrance plays anyway over the card's own colour.
- **Mesh.** 36 rows × 4 columns, one topology for every frame. Each row edge springs on its own (critically damped), slower the closer it is to the link with a smoothstep profile, so the edge bends in one curve instead of folding at the link's row.
- **Source.** The page script reports the click point, not the link's bounds, so the Genie starts from a 28 × 18 pt
  rectangle centred on that point, clamped into the card.

## Failure scenarios

Written before the implementation. Each names how it breaks and the check in `apps/browser/scripts/peek-hybrid-test.mjs`
that catches it. Every check writes its geometry, identity and frame trace to the run's `peek-hybrid.json`.

| # | Failure | How it shows | Check |
| --- | --- | --- | --- |
| P1 | The Peek's page is laid out smaller than the tab it becomes and reflows on promotion | the page's `innerWidth`/`innerHeight` differ between Peek and tab; a resize event fires in the page | `viewport`: inner size before, during and after Open as Tab are equal; the page's resize counter stays 0 |
| P2 | The card scales unevenly (x ≠ y) or the page scale disagrees with its rectangle | trace frames with `sx ≠ sy`, or the page's shown rect isn't `k ×` the tab rect | `uniform`: every trace frame has one scale; at rest `shown = k · tab`, at the last promote frame `shown = tab` exactly |
| P3 | The page lands at a different origin than its tab and jumps at handoff | the last promote frame's page origin differs from the tab pane's web view origin | `handoff`: last frame origin equals the tab's native web view frame within 0.5 pt |
| P4 | Promotion reloads or swaps the document | a nonce set in the page is gone; history length, form text, scroll offset or media time reset; the Chrome tab id changes | `identity`: nonce, `history.length`, an input's value, `scrollY` and a playing audio element's `currentTime` survive; `browserId` is unchanged |
| P5 | A pinch that starts during the Genie jumps (snaps to full size or loses the warp) | the first gesture frame's vertices differ from the last entrance frame's | `regrab-genie`: at 3 timestamps (40, 90, 150 ms) a zero-delta pinch keeps every vertex within 1e-6 and the opacity unchanged |
| P6 | The warp never settles after an interrupted entrance | `residual` stays above 0 | `regrab-genie`: residual reaches 0 within 400 ms of the pinch's start while the scale follows the pinch |
| P7 | A reversed pinch (spread then pinch back) or a regrab mid-settle jumps | the scale's first value after a regrab differs from the last before it | `reversal`: spread to 0.2, back to −0.1, release, regrab during the settle at zero delta: no frame-to-frame jump above the spring's own step |
| P8 | Close and Open as Tab racing both run (two outcomes, or the tab promoted after closing) | two `onPeekDone`, or a tab added after close | `race`: close then promote in the same tick, and promote then close: exactly one outcome per generation, the first one asked |
| P9 | A new Peek replacing one mid-animation gets the old one's completion | the new Peek closes or promotes by itself | `replacement`: open A, open B during A's entrance: A's generation never reports, B opens and stays open |
| P10 | Navigating the source page or switching tabs mid-entrance leaves a card or a stale callback | a card over the wrong page, a late promote | `navigation`: source navigates during the entrance; the Peek is gone, no outcome is reported after its unmount |
| P11 | Resizing the window mid-animation leaves the page at the old size or the card mid-warp | the page's layout size isn't the new tab rect; mesh still applied | `resize`: resize during entrance, settle and promote: entrance snaps to rest at the new geometry, promote finishes at the new tab rect |
| P12 | The Peek page going full screen keeps the card transform | page drawn scaled in full screen | `fullscreen`: page requests full screen: identity transform, chrome and scrim at 0, no remap |
| P13 | The Genie path calls the private API with the wrong layout or crashes on failure | crash, or a warp drawn wrong | `fallback`: `ARDIA_TEST=peekMesh=unavailable` and `peekMesh=throws` both play `affine`, report the reason, and still open, pinch and promote |
| P14 | A page that never paints holds the Peek invisible | nothing shows | `timeout`: `ARDIA_TEST=peekReady=never`: the entrance starts at 150 ms ± one frame |
| P15 | Reduced motion still scales or moves | a trace frame with scale ≠ rest or translation during entrance or close | `reduced`: entrance and close change only opacity; promote jumps once and fades the chrome |
| P16 | Clicks during the warp reach the page, or clicks at rest land at the wrong spot | the page records a click during the entrance, or at the wrong coordinates at rest | `input`: a click during the warp is swallowed; a click at rest on a target's shown centre hits that target in the page |
| P17 | A pinch or Esc during the warp is ignored | the Peek stays | `input`: Esc and a pinch-in during the entrance close it |
| P18 | The delayed focus after promotion steals focus from a tab picked in between | another tab selected within 50 ms loses focus | `focus`: promote, select another tab at once: the promoted page doesn't take focus |
| P19 | A stale `onPeekDone` after unmount closes a newer Peek or a tab | a later Peek closes on its own | covered by `replacement` and `race` (generation guard) |
| P20 | Any run logs a native exception, JS error or page error | console output | every check reads the app's console and the trace's `errors` |

### Round 2 (2026-11-16, owner's test and the post-change review), written before the fixes

| # | Failure | How it shows | Check |
| --- | --- | --- | --- |
| P21 | A real trackpad pinch never reaches the Peek: the magnify monitor was only installed by `MagnifyArea`, which Peek no longer uses, and the synthetic test called the router directly | pinching zooms the page instead | `pinch-monitor`: a magnify event posted through `NSApp` (not the router) with no Little Ardia window open moves the card |
| P22 | The page is drawn at `k²` inside a card sized for `k`, so a wide border shows around it | WindowServer capture: page rect ≠ the card's page slot | `rest-capture`: the drawn page edge sits `inset` from the card edge (±2 pt) in a WindowServer capture |
| P23 | The Genie collapses to a 28 × 18 pt point and staggers rows far apart, so it reads as a violent fold | per-row timing spread and neck size | `genie-shape`: the neck is ≥ 18 % of the card's width, row timing spread ≤ ± 12 %, and the entrance settles in ≤ 320 ms |
| P24 | Closing doesn't retrace the entrance | close plays a zoom while open played a Genie | `close-genie`: close by ×, Esc and pinch-in all warp back into the link; with the mesh off it zooms back |
| P25 | An interruption recomputes the warp at the event's time instead of starting from what was last on screen | first frame after a pinch differs from the last drawn frame | `regrab-genie-*`: the frame at the freeze equals the last committed frame, and no vertex moves more per frame after the freeze than the fastest one did before it |
| P26 | Promotion parks the page outside the window between the two hosts | the page sees `visibilitychange` hidden → visible and a `resize` | `handoff-direct`: no `visibilitychange`, no `resize`, same `browserId`, the Peek host keeps the tab until the tab's host has it, and neither host's teardown closes or clears it |
| P27 | Cancelling the hand-over (the tab closes, the window closes) leaks or closes the wrong page | a page left parked, or the donor's page closed | `handoff-cancel`: close the promoted tab within the hand-over: the tab is gone, no page is left parked |
| P28 | With auto-hide toolbars the tab's first frame lays the page out under a different toolbar state | inner height changes after the hand-over | `handoff-autohide`: `hideToolbarWhileScrolling` on: inner size constant |
| P29 | Chrome's popups and IME rect use the unscaled page position while the page is scaled | a `<select>` menu or IME candidate window opens away from the field | `outgoing-coords`: the field's on-screen rect from the engine matches the drawn rect |
| P30 | The Genie runs without a way to turn it off remotely, or the private API is inspected before the switch is read | no switch, or an inspection with the switch off | `kill-switch`: `ARDIA_SWITCHES=peekGenie=off`: `affine`, and the mesh runtime was never inspected |
| P31 | Scroll and hover over the scaled page land at the wrong point | the page reports wheel/mousemove at unscaled coords | `input`: wheel scrolls the page under the pointer; mousemove over a target fires its `mouseover` |
| P32 | Esc is tested through ⌘W instead of the Escape key | the test passes while Escape is broken | `escape-during-warp`: a real Escape key press |
| P33 | Focus checks read the store, not the window's first responder | the page takes key focus after another tab was picked | `focus`: first responder after the pick isn't the promoted page's view |
| P34 | The tests overclaim the blip's length (assertion time, not hidden time) | wrong evidence | `handoff-direct` records the page's own `visibilitychange` timestamps |
| P35 | A residual mesh failure mid-interruption leaves a warped card | mesh stays applied after a failed apply | `fallback-throws` also pinches during the entrance: no mesh after |
| P36 | Full screen during the entrance or a pinch leaves warp or gesture state | warped full-screen page | `fullscreen`: full screen requested during the entrance: identity, no mesh |
