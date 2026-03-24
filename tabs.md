# Tab Sizing Bug

## Problem
Tabs are either invisible, showing only a single letter, or too tiny to read. This has been through multiple fix attempts and keeps breaking.

## Layout Chain
```
header_header (fixed, full width)
  └─ header_bar (display: flex, height: 34px)
       ├─ tabs_nav (contains tab list + new-tab button)
       │    ├─ tabs_list (ul, display: flex, contains tab items)
       │    │    ├─ tab_tab (li, each individual tab)
       │    │    │    └─ tab_text (span, contains the label)
       │    │    │         └─ tab_textInner (span, actual text)
       │    │    └─ ... more tabs
       │    └─ DropdownButton (new tab + button)
       └─ header_dragRegion (window drag area)
```

## Root Cause
The flex layout has competing interests:
1. `header_dragRegion` needs SOME space for window dragging
2. `tabs_nav` needs to fill most of the bar
3. `tabs_list` needs to contain all tabs and scroll when overflow
4. Each `tab_tab` needs enough width to show its name

Original Hyper solved this with:
- `tabs_list` had `flex-grow: 1` — it took all available space
- `tab_tab` had `flex-grow: 1` — tabs split the list equally
- There was NO separate drag region — `tabs_nav` itself had `-webkit-app-region: drag`
- Tabs were only rendered when `tabs.length > 1`

Our version broke it by:
- Adding a separate `header_dragRegion` with `flex: 1` that competed with tabs for space
- Adding `overflow-x: auto` on `tabs_list` which allows it to collapse to zero
- Changing `tab_tab` flex properties multiple times (33%, flex-basis: 0, flex-basis: 100px)
- Making `tab_textInner` use `position: absolute` (removed from flow, zero width contribution) — partially fixed to use flex/padding but may still have issues

## Files Involved
- `lib/components/header.tsx` — header_bar layout, drag region
- `lib/components/tabs.tsx` — tabs_nav, tabs_list
- `lib/components/tab.tsx` — individual tab styling (tab_tab, tab_text, tab_textInner)

## Current CSS Values
```css
/* header.tsx */
.header_bar { display: flex; height: 34px; align-items: stretch; }
.header_dragRegion { flex: 0 0 40px; -webkit-app-region: drag; }

/* tabs.tsx */
.tabs_nav { display: flex; flex: 1 1 auto; min-width: 0; }
.tabs_list { display: flex; flex: 1 1 auto; min-width: 0; overflow-x: auto; }

/* tab.tsx */
.tab_tab { flex-grow: 1; flex-shrink: 1; flex-basis: 100px; min-width: 60px; max-width: 250px; }
.tab_text { display: flex; align-items: center; height: 34px; width: 100%; overflow: hidden; }
.tab_textInner { padding: 0 24px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; flex: 1; }
```

## What It Should Do
- 1 tab: tab fills the bar (minus new-tab button and drag area)
- 2-5 tabs: tabs split available space equally, each showing full name
- 6+ tabs: tabs shrink proportionally, names truncate with ellipsis
- 20+ tabs: tabs hit min-width, horizontal scroll kicks in
- Tab text is always centered and readable
- Window is still draggable (titlebar overlay on Windows handles this)

## What Original Hyper Did Differently
The original Hyper hid the tab bar entirely when there was only 1 tab (`tabs.length === 1` → no tabs rendered, just title). We always show tabs. The original also used `-webkit-app-region: drag` on `tabs_nav` itself instead of a separate drag div — the tab text areas were `no-drag` overrides within the draggable nav.

## Suggested Fix
Consider going back to the original Hyper approach: make `tabs_nav` the drag region, remove the separate `header_dragRegion` entirely (on Windows the titlebar overlay handles dragging anyway), and let the flex chain be simpler: `header_bar > tabs_nav(flex:1) > tabs_list(flex:1) > tab_tab(flex-grow:1)`.
