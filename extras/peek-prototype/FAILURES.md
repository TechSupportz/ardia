# Peek prototype: failure scenarios

Written before the harness. Each row names the way a variant can break and the check in `e2e.mjs` that catches it.
Applies to all three variants unless a row says otherwise.

| # | Failure | How it shows | Check |
| --- | --- | --- | --- |
| F1 | Ctrl-wheel over the Peek zooms or scrolls the page instead of pinching | `visualViewport.scale` changes, card doesn't react | after a ctrl-wheel burst, scale stays 1 and the Peek phase went to `pinch` |
| F2 | A pinch released below threshold leaves the card part-way | card transform isn't back at rest | small spread, wait, phase `open`, card transform at identity (or strips gone) |
| F3 | One pinch promotes twice (late wheel events after the release timer) | two new sidebar rows | tab count goes up by exactly one after a spread plus trailing wheel events |
| F4 | Promotion doesn't leave the new tab active | old row keeps `aria-current`, content shows the old page | exactly one `aria-current="page"` row, it's the new one, content title matches the peeked page |
| F5 | Close, then reopen, fails (stale leaving flag, orphan overlay) | second click does nothing or two cards | close by button, Esc, scrim (where one exists) and pinch-in, reopen each time, one card |
| F6 | Replay or a variant switch mid-animation leaves timers that write into the new mount | errors, or the fresh scene starts with an extra tab | press R mid-open and switch variants mid-promote, then the tab count is back to 3, no console errors |
| F7 | Esc with nothing open throws | console error | Esc on a closed scene |
| F8 | Reduced motion still scales or moves things | a non-identity transform during open/promote | emulate `prefers-reduced-motion: reduce`, sample transforms during open and promote |
| F9 | Motion animates layout (width, height, top, left) | card's `offsetWidth`/`offsetHeight` change mid-animation | sample layout boxes during open, pinch and promote while bounding rects move |
| F10 | Motion runs past 300 ms | phase log shows longer spans | `opening→open`, `closing→closed`, `promoting→promoted` each under 300 ms (one frame of slack) |
| F11 | Genie bends the wrong way for links near the bottom | strips nearest the link don't lag on open | mid-open, the strip nearest the link is narrower than the far strip, for top and bottom links |
| F12 | Clicking a link while a Peek is closing opens two cards | two `.pk` nodes | click during close, exactly one card |
| F13 | Picker keys fire while a modifier is held | ctrl-wheel or ⌘ shortcut flips variants | ctrl held during the pinch, the variant stays put |
| F14 | Little Window dragged out of the window | it lands off-screen | drag far past the edge, rect stays inside the window |
| F15 | Copy Link is a dead button under `file://` (clipboard refused) | no feedback | press it, the label flips to "Copied" |
| F16 | Pinching during the open animation jumps | transform snaps | pinch starts mid-open, the card keeps growing with no jump to full size |
| F17 | Clicking inside the card closes it (scrim catches the click) | Peek closes | click on the card body, still open |
| F18 | Switching sidebar tabs with a Peek open leaves the Peek over the wrong page | card stays | click another row, the Peek closes, that row is active |
| F19 | Seamless loses the scroll position on promotion | the tab opens at the top | scroll the Peek, promote, the tab's scrollTop matches |
| F20 | Any variant logs a console error or page error | console output | collect every console error and `pageerror` across the run |
