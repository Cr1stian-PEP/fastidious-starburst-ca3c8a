# AGENTS.md

Overview of this project's structure for developers and AI agents.

## Project Overview

A material stock variance report. Users upload three spreadsheet exports — **production**, **materials**, and **delivery** — and the app matches them on material number, adds the production and materials quantities together to get stock on hand, and compares that against the stock the delivery report says is needed for loads.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | TanStack Start |
| Frontend | React 19, TanStack Router v1 |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 |
| Charts | Chart.js + react-chartjs-2 |
| Spreadsheets | SheetJS (`xlsx`) |
| Database | Netlify Database (Postgres) via Drizzle ORM |
| Language | TypeScript 5.9 |
| Deployment | Netlify |

## Directory Structure

```
├── db
│   ├── schema.ts       # Drizzle table definitions: reports, report_lines, material_footprints
│   └── index.ts        # Drizzle client (Netlify Database adapter)
├── netlify/database/migrations   # Auto-generated SQL migrations, applied by Netlify at deploy time
├── scripts
│   ├── reference/Key.xlsx        # Source footprint key (pallet sizes per material)
│   └── generate-footprints.mjs   # Regenerates material-footprints.json from Key.xlsx
├── src
│   ├── server
│   │   ├── reports.server.ts     # Spreadsheet parsing, DB reads/writes, variance calc (server-only)
│   │   ├── reports.functions.ts  # createServerFn wrappers exposed to the client
│   │   └── data/material-footprints.json  # material number -> cases per pallet
│   ├── components
│   │   └── sort-header.tsx # Excel-style sortable <th>, shared by every table
│   ├── lib
│   │   ├── table-sort.ts # Pure sort/filter helpers shared by the tables and the server
│   │   ├── shortfalls.ts # Pure aggregation behind the largest-shortfalls chart
│   │   └── units.ts      # Case <-> pallet formatting shared by the stat tiles and tables
│   ├── routes
│   │   ├── __root.tsx   # Root layout
│   │   ├── index.tsx    # Upload UI + variance chart/table + pallet view
│   │   ├── production.tsx # The uploaded production workbook, rendered as a raw grid
│   │   └── footprints.tsx # View/add/edit the pallet footprints
│   ├── router.tsx
│   └── styles.css
├── drizzle.config.ts    # Drizzle Kit config (out: netlify/database/migrations)
└── vite.config.ts
```

## Data Model

Each report occupies one of three typed slots — `production`, `materials`, or `delivery`. Uploading a new file into a slot replaces whatever was previously there (report row + its line items), so the report is always computed across the current three uploads. Each tile also has a **Clear** button, which deletes that slot's report row and lines and leaves the other two in place. The `delivery` slot is labelled **Outbound loads** in the UI; the `ReportType` key, the server fns, and the database all still say `delivery`.

- `reports`: `id`, `type`, `label` (the uploaded file name, extension included, so the tile can show it), `raw_sheet`, `created_at`
- `report_lines`: `id`, `report_id`, `material`, `material_name`, `quantity`, plus delivery-only detail
  columns `order_number`, `customer_po`, `plant_name`, `sold_to`, `loading_date`, `ship_date`,
  `shipping_condition`, and the production-only `production_date`
- `material_footprints`: `material` (PK), `cases_per_pallet`, `updated_at` — user edits that override the
  generated footprint key

`raw_sheet` is a leftover column. It once held the uploaded workbook as a JSON `string[][]` grid for a raw-grid production page that has since been reverted; nothing writes or reads it now. It stays in `db/schema.ts` only because its migration is applied and applied migrations are never edited.

Detail columns are only written at upload time, so a schema addition doesn't backfill: the affected export has to be re-uploaded before its new column holds anything. That applies to `shipping_condition` too — the outbound loads export has to be re-uploaded before the `01` option shows real data.

## Input Formats

Uploads are `.xlsx`, `.xls`, or `.csv`, read with SheetJS from the **first sheet** of the workbook. There is no header requirement — rows are kept only when the material-number column holds digits, which naturally skips header and spacer rows.

Columns are addressed by **spreadsheet column letter** (see `REPORT_COLUMNS` in `reports.server.ts`), because these files are fixed-layout system exports:

| Report | Material # | Name | Quantity | Notes |
|--------|-----------|------|----------|-------|
| production | D | F | G | Case quantity; production date in column **B** |
| materials | A | B | C | Finished stock |
| delivery | Q | R | S | Only rows where column **T** is `01` or `02` count; all other T values are ignored |

The delivery report also carries the per-material detail shown when a row is expanded: freight order / load number (**P**), Customer PO (**K or L**), plant name (W), sold-to (Y), loading date (AE), ship date (AG), and shipping condition (T).

**The Customer PO is in column K or column L, whichever is filled.** The export puts it in L on shipping-condition `01` rows (where K is blank) and in K on `02` rows (where L holds an internal order number instead), so `REPORT_COLUMNS.delivery.customerPO` is the list `['K', 'L']` and the parser takes the first non-empty of the two. Both columns hold exactly 10 digits with **no padding** — an earlier version trimmed POs to 9 characters believing the tail was filler, which corrupted them; `formatCustomerPo` no longer truncates anything. Note that not every PO starts with `4`: a large block of condition-`02` POs starts with `76`, so first-non-empty is the rule, not a leading-digit test.

**Column P is the freight order**, which is what "load #" means in the app. It is **zero-padded to 20 characters** (`00000000000112578510`) and it is **frequently blank** — in the reference export 337 of 882 lines carry no freight order at all. `formatLoadNumber` in `units.ts` strips the leading zero run for display; grouping and search still use the raw string.

Because so many rows have no freight order, a load is **not** keyed on it. `deliveryLoadKey` in `src/lib/shortfalls.ts` keys a load on `load:<freight order>` when there is one, otherwise `po:<customer PO>`, otherwise a per-line `line:<n>` — every `LoadShortfall` carries that `key` alongside the real (possibly blank) `orderNumber`. Keying on the freight order alone collapsed 172 distinct POs into a single `(no load #)` row and hid all of them; on the reference export the PO fallback yields 245 separate loads. The load table, the row refs, the expanded-row state, the chart's jump targets, and the delivery-line highlight all key on `key`; a row with no freight order renders *No load #* in the Load # cell and is identified by the PO beside it, and the chart labels it `PO <number>`.

### The production date fills downward

The production schedule prints its date once at the top of a block of material rows and leaves the cells beneath it blank (merged or visually grouped). `parseReportFile` therefore keeps a `lastDate` and reads the date cell on **every** row **before** the `if (!/^[0-9]+$/.test(material)) continue` guard runs — the row carrying the date usually has no material number of its own, so reading it after the guard would skip it. Each surviving line is then stamped with `lastDate`. Rows above the first date heading get an empty string rather than a guess. The cell goes through `cellToDateString`, so serial-number dates come out readable.

## Variance Logic

`computeMaterialSummary` (in `src/server/reports.server.ts`) unions the material numbers across all three uploads and for each one computes:

- `inProduction` — summed quantity from the production report
- `finished` — summed quantity from the materials report
- `totalOnHand` — `inProduction + finished`
- `requested` — summed delivery quantity, for the shipping conditions the selector has active (`02` by default)
- `variance` — `totalOnHand - requested`

Rows are ordered by material number. A negative variance is a shortfall and is shown in red. Material names prefer the materials report, then production, then delivery. Each row also carries `production` — the material's `{ date, quantity }` entries from the schedule, merged per date and sorted earliest first — and `deliveries`, its delivery lines.

Every quantity on screen is a whole number: `formatNumber` in `src/lib/units.ts` rounds to zero fraction digits, and every tile, table cell, and chart tooltip routes through it. It also normalizes anything that rounds to zero — including the `-1e-13` a pallet division can leave behind — to a plain `0`, because **a variance of zero must never render as `-0`**. (`footprints.tsx` keeps its own two-decimal `formatNumber`, because a cases-per-pallet value can legitimately be fractional.)

Customer POs and freight orders render whole. `formatCustomerPo` in `units.ts` only trims surrounding whitespace, and `formatLoadNumber` only strips a freight order's leading zero padding. Grouping, sorting, refs, and highlighting all key on the untouched strings, so two records can never collapse into one.

### Expanded material row

Opening a material row shows its summary tiles (In production / Finished / Total on hand / Cases per pallet), then **Scheduled production**, then its delivery lines. The scheduled-production block renders `MaterialRow.production` — the server's per-date `{ date, quantity }` entries, already sorted — as a compact Date · Quantity table, with quantities through `formatQty` so pallet view applies. If the material has production quantity but no dated schedule rows, a single line says the quantity and that the rows carried no date. If it has none at all, nothing renders rather than an empty heading.

### Stat tiles

Above the chart: **Materials tracked**, **Finished Goods**, **To be produced**, **Needed for loads**, and **Shortfalls**. *Finished Goods* is the summed `finished` quantity — only what is physically finished — and *To be produced* is the summed `inProduction` quantity, so the two are disjoint and neither is contained in the other. *To be produced* only appears while a production report occupies its slot; it disappears again when that slot is cleared, and the grid drops from five columns to four. The table's **Stock on Hand** column and the variance math still use `totalOnHand` (`inProduction + finished`); only the tile is narrower than that.

## Pallet View

The dashboard's **Pallet View** button converts case quantities to pallet quantities. The conversion comes from the footprint key: a footprint like `100X25X4` means 100 cases fit on a pallet, so only the **first number** is used. `scripts/generate-footprints.mjs` parses `scripts/reference/Key.xlsx` into `src/server/data/material-footprints.json` (a plain material-number → cases-per-pallet map) so the runtime never has to read the binary key file.

Re-run it after updating the key:

```bash
node scripts/generate-footprints.mjs
```

Materials with no footprint match stay in cases and are labelled `cs`; the table shows a note counting them.

The toggle is page-wide and lives in the page header, above everything it changes: the stat tiles and both tables. Because cases-per-pallet differs by material, a page-level total can't be divided at the end — `totalUnits` in `src/lib/units.ts` converts material by material and keeps the unconvertible cases separate, so the **Finished Goods**, **To be produced**, and **Needed for loads** tiles read as `… pl` with a `+ N cs with no footprint` note underneath when part of the total has no key match. The load table's totals are built the same way, from each load's own per-material lines. A total made up entirely of unkeyed materials falls back to cases instead of reading as zero. **The chart follows Pallet View too**: material bars convert with `qtyValue`, and load bars are built material-by-material across the load's own `lines` with `totalUnits` + `totalValue`, so a bar always agrees with the row it points at. The tooltip prints the formatted string (`… pl` / `… cs`) rather than the raw datum. `formatNumber`, `formatCustomerPo`, `formatLoadNumber`, `formatQty`, `formatTotal`, `qtyValue`, `totalValue`, and `totalUnits` all live in `src/lib/units.ts`.

## Footprints Page

`/footprints` (linked from the dashboard header) lists every material the app knows about — the union of the generated key file and the material numbers seen in the uploads — in the same table format as the variance report: sortable headers, a search box, and a segmented filter (**All** / **Missing footprint** / **Edited**).

The key file stays the baseline and is never written to. A row in `material_footprints` overrides it for one material, which is how the page both corrects a wrong value and adds a footprint the key file doesn't cover. Each row is tagged with where its value came from:

- `key` — straight from `material-footprints.json`
- `override` — the key file has a value, but a user edit replaces it
- `added` — the key file has no value; the whole footprint is a user edit

Editing is inline: click the cases-per-pallet value, type, and press Enter (Escape cancels). Overridden and added rows also offer **Revert** / **Remove**, which deletes the override row so the key file's value (or nothing) applies again. `resolveFootprints` merges baseline + overrides and is what the dashboard loader passes into `computeMaterialSummary`, so an edit shows up in Pallet View immediately.

## Largest Shortfalls Chart

The chart above the variance table can be grouped two ways, toggled in the view controls in its header. **The toggle drives the table underneath as well as the chart** — picking a grouping switches the whole view, not just the bars:

- **By material #** — the materials with the worst variance, restricted to materials some load actually asks for.
- **By load #** — delivery lines grouped by order number, with stock **allocated** across loads rather than counted once per load. `groupShortfallsByLoad` walks the loads in ship-date order (loading date as fallback; undated loads last, since they can't claim priority) and draws each material down as it commits it, so a load's "stock on hand" is its own demand capped by whatever is left after the earlier loads took their share. That makes the two bars directly comparable — `variance` is exactly `totalOnHand - requested` for that load — and stops one short material from being charged in full against every load that needs it, which is what made the earlier numbers read wrong. The tooltip shows ship date, material count, and cases short; the series is labelled *Stock available for this load* in this grouping.

`src/lib/shortfalls.ts` holds both aggregations as pure functions. The allocation loop also keeps the per-material breakdown it used to throw away: each `LoadShortfall` carries `key`, `orderNumber`, `customerPO`, and a `lines` array of `{ material, materialName, requested, available, variance, casesPerPallet }`. `summarizeLoads` returns **every** load in allocation order (what the load table renders); `topShortfallLoads` filters that to `variance < 0`, worst first, sliced to the chart limit. The dashboard calls `summarizeLoads` once and derives its chart rows from the result, so nothing allocates twice.

Clicking a bar jumps to the matching row: the dashboard relaxes the search box (and the shortfalls filter, if it would hide the target), expands the row, scrolls it to the middle of the viewport, and flashes it amber for a few seconds. In by-material mode the target is the material's row; in by-load mode it's the **load's** row, keyed on the load's `key` (see `deliveryLoadKey` above), never on the freight order — which may be blank. Because the row may not exist yet when the search is being cleared, the scroll runs from an effect keyed on the visible rows rather than inline in the click handler.

The chart body collapses behind a chevron in the card header (`aria-expanded`, open by default). The animation is a `max-height` + opacity transition on an `overflow-hidden` clipping wrapper, with the canvas inside a fixed `h-[380px]` box and `maintainAspectRatio: false` on the chart options. **Don't go back to animating `grid-template-rows` on the container**: Chart.js is `responsive: true` and watches its container with a `ResizeObserver`, so a container whose height changes every frame makes the chart re-lay out every frame and visibly fight the transition. Clipping a constant-height box keeps the observer quiet. The empty-state paragraph sits in the same fixed box so collapsing behaves identically with or without bars. The heading, the caption, the grouping toggle, the ship-date range, and the shipping-condition selector stay visible when it's collapsed — they're how you decide whether to open it, and the toggle still drives the table.

The y-axis floor is pinned: `min: Math.min(0, ...every bar value)`, with `beginAtZero` only when that minimum is zero. Left to itself Chart.js rounds the floor down to a whole tick step, so a single small negative bar dropped the axis to **-2000** and flattened everything else — most visibly when switching to shipping condition `01`. Pinning it means the axis descends exactly as far as the data does and no further.

## Loads View

With **By load #** selected, the table below the chart mirrors the material table one row per outbound load: Load # · Customer PO · Ship Date · Materials · Stock Available · Needed for Loads · Variance, sorted worst-variance-first by default. Load # is the freight order from column P with its leading zeros stripped (`formatLoadNumber`), or an italic *No load #* when the export left it blank; the Customer PO goes through `formatCustomerPo`. Expanding a row shows **Ship From** (plant name, column W) and **Ship To** (sold-to, column Y) above that load's materials (Material · Name · Needed · Available · Variance) from the allocation's own `lines`, so pallet view converts with each material's footprint. Ship from / ship to belong to the load, not the material, so they are collected during the allocation: `groupShortfallsByLoad` keeps every **distinct** non-empty value across the load's delivery lines and joins them, rather than taking the first and hiding a disagreement the export doesn't forbid.

`LoadSortKey` and `filterAndSortLoads` in `table-sort.ts` handle the sorting and filtering: **Shortfalls Only** keeps loads with a negative variance, and the search box matches the load number, the Customer PO, the ship-from plant or ship-to party, or any material number/name on the load. Sorting by load number keeps the blank freight orders at the bottom in **both** directions, the same way blank dates and missing footprints do, so the load-less rows don't jump to the top on a flip. Expanded state is per-view — switching the toggle collapses whatever was open rather than carrying an id across two different kinds of row.

## Ship Date Range and Shipping Condition

Two date inputs (**From** / **To**, with a **Clear** button that appears once either is set) and a three-way **Shipping condition** selector (`01` · `02` · **Both**, segmented like the grouping toggle) sit in the view controls next to the grouping toggle. `filterMaterialsByDelivery` in `table-sort.ts` applies both client-side **before** anything else is computed, and the filtered array feeds the tiles, the chart in both groupings, and both tables. It takes an options object `{ from, to, condition }` and is the single pass over the demand side — don't add a second one.

Only delivery lines whose ship date falls inside the range (inclusive at both ends) and whose shipping condition matches the selector survive; `requested` and `variance` are rebuilt from the survivors while `totalOnHand`, `inProduction`, and `finished` are left alone, because stock isn't dated or conditioned. A material whose lines all fall outside the window stays in the list with `requested: 0`. Lines with no parseable ship date are dropped while a range is active — they can't be shown to fall inside it — and a note under the controls counts them.

The selector defaults to `02`, which is what the report showed before it existed. Both `01` and `02` rows are stored at upload; anything else in column T is still dropped by the parser. A line with a blank `shippingCondition` — stored before the column existed — reads as `02`, so an old upload doesn't vanish from the default view.

## Production Page

`/production` (linked from the dashboard header, `Factory` icon) lists the uploaded production schedule **grouped by production date**, loaded by `getProductionSchedule` → `listProductionSchedule`. Above the groups sit three tiles (Scheduled lines / Production dates / Total cases) and a search box matching material number or name. Undated rows sort last. When no production report is loaded the page shows an empty state linking back to the dashboard.

A raw-spreadsheet-grid version of this page was tried and reverted — a clean grouped view is what this page is for. `extractSheetGrid`, `getProductionSheetGrid`, and the `raw_sheet` write went with it; the column itself survives in `db/schema.ts` because its migration is applied. `MaterialRow.production` is unrelated and still feeds the expanded material row.

## Table Controls

Both dashboard tables — the variance/load table and the detail table inside an expanded row — have Excel-style sortable column headers, as does the footprints table. `src/components/sort-header.tsx` renders them: clicking a header sorts that column ascending; clicking the active header flips the direction. `src/lib/table-sort.ts` holds the comparators, which are pure and shared with the server:

- **Material number** sorts numerically, not as text, so `999` comes before `1000`.
- **Loading date / ship date** sort on the parsed date, since these arrive as `m/d/yy` strings where a text sort would put `10/1/26` before `7/29/26`. Blank dates stay last in both directions.
- **Cases per pallet** keeps materials with no footprint at the bottom in both directions, so the gaps to fill in don't scatter through the list when the sort flips.
- `computeMaterialSummary` uses the same `sortDeliveries` helper to produce its default oldest-ship-date-first order, so the server and the client can't drift.

The delivery table inside an expanded material row shows Load # · Customer PO · Plant · Sold-To · Ship Date · Quantity. Loading date is no longer a column, but it is still parsed and still feeds the load allocation as the ship-date fallback, and `loadingDate` remains in `DeliverySortKey`.

A **Shortfalls Only** button filters the table to negative variances — materials in by-material mode, loads in by-load mode. It composes with the search box, and the row count under the table reflects both.

## Development Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
```

## Conventions

- Server-only logic lives in `*.server.ts` files and is never imported from client components.
- Client-callable RPCs live in `*.functions.ts` files using `createServerFn` with `.inputValidator` (zod) for anything that takes input. Uploads are sent as base64 so binary `.xlsx` files survive the round trip.
- Schema changes go through `db/schema.ts` + `npx drizzle-kit generate --name <slug>` — never hand-written DDL.
