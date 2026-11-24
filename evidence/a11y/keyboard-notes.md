# Keyboard walkthrough notes (D9)

Environment: https://staging.bklabs10.com, Chrome on macOS, signed in as the coordinator. Mouse and trackpad not used after sign-in.

## What I did (keyboard only)
1. Pressed Tab from the top of the page. The focus outline was visible on every control I reached.
2. Typed `kite` in Search, then pressed Tab through Location, Type, Status, From and To to reach **Apply filters**.
   Screenshot: `keyboard-1-focus-visible-on-apply-filters.png` (yellow outline on the button).
3. Pressed Enter. The list changed from 6 events to 1 (Kite Flying Afternoon).
   Screenshot: `keyboard-2-search-applied-with-enter.png`.
4. Tabbed to the event title (Kite Flying Afternoon) and pressed Enter to open it. Tabbed to New status, chose a value with the arrow keys, tabbed to Reason, typed a reason, tabbed to Apply status and pressed Enter. Completed with the keyboard only, then set the status back to scheduled.

## Focus order
Skip to content, FieldDay brand link, Sign out, New event (coordinator only), Search, Location, Type, Status, From, To, Apply filters, Clear, then each event title link.
This is the same order as the page reads, left to right and top to bottom. No positive `tabindex` values are used.

## From the code (not from the run)
- `styles.css` has one global `:focus-visible` rule (3px outline, 2px offset), so every control gets a visible focus ring.
- The only `tabindex` in the app is `-1` on `<main>`, used so focus moves to the content after navigating between pages. There are no custom key handlers, so nothing traps the keyboard.
- The "Skip to content" link is the first Tab stop.

## Traps or problems found
None found. Focus was always visible and I never got stuck.

## Automated check
Lighthouse accessibility (axe-core in real Chrome, colour contrast included): board 100, event detail 100, no failing audits.
Reports: `board.report.json` / `.html`, `event-detail.report.json` / `.html` in this folder.
The jsdom axe tests in the web test suite cover the signed-in coordinator forms.
