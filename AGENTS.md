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
│   │   ├── production.tsx # Read-only view of the uploaded production schedule
│   │   └── footprints.tsx # View/add/edit the pallet footprints
│   ├── router.tsx
│   └── styles.css
├── drizzle.config.ts    # Drizzle Kit config (out: netlify/database/migrations)
└── vite.config.ts
```

## Data Model

Each report occupies one of three typed slots — `production`, `materials`, or `delivery`. Uploading a new file into a slot replaces whatever was previously there (report row + its line items), so the report is always computed across the current three uploads. Each tile also has a **Clear** button, which deletes that slot's report row and lines and leaves the other two in place. The `delivery` slot is labelled **Outbound loads** in the UI; the `ReportType` key, the server fns, and the database all still say `delivery`.

- `reports`: `id`, `type`, `label` (the uploaded file name, extension included, so the tile can show it), `created_at`
- `report_lines`: `id`, `report_id`, `material`, `material_name`, `quantity`, plus delivery-only detail
  columns `order_number`, `customer_po`, `plant_name`, `sold_to`, `loading_date`, `ship_date`, and the
  production-only `production_date`
- `material_footprints`: `material` (PK), `cases_per_pallet`, `updated_at` — user edits that override the
  generated footprint key

Detail columns are only written at upload time, so a schema addition doesn't backfill: the affected export has to be re-uploaded before its new column holds anything.

## Input Formats

Uploads are `.xlsx`, `.xls`, or `.csv`, read with SheetJS from the **first sheet** of the workbook. There is no header requirement — rows are kept only when the material-number column holds digits, which naturally skips header and spacer rows.

Columns are addressed by **spreadsheet column letter** (see `REPORT_COLUMNS` in `reports.server.ts`), because these files are fixed-layout system exports:

| Report | Material # | Name | Quantity | Notes |
|--------|-----------|------|----------|-------|
| production | D | F | G | Case quantity; production date in column **B** |
| materials | A | B | C | Finished stock |
| delivery | Q | R | S | Only rows where column **T = `02`** count; all other T values are ignored |

The delivery report also carries the per-material detail shown when a row is expanded: order number and Customer PO (both **L** — see below), plant name (W), sold-to (Y), loading date (AE), and ship date (AG).

`orderNumber` and `customerPO` currently both point at column **L**. Column L is reported to hold the Customer PO rather than the sales document number, but the source export wasn't available to confirm which column carries the order number, so nothing was remapped away from the behaviour that already worked. Once the header row can be checked, point `orderNumber` at the sales-document column in `REPORT_COLUMNS.delivery` — that one line is the whole change.

### The production date fills downward

The production schedule prints its date once at the top of a block of material rows and leaves the cells beneath it blank (merged or visually grouped). `parseReportFile` therefore keeps a `lastDate` and reads the date cell on **every** row **before** the `if (!/^[0-9]+$/.test(material)) continue` guard runs — the row carrying the date usually has no material number of its own, so reading it after the guard would skip it. Each surviving line is then stamped with `lastDate`. Rows above the first date heading get an empty string rather than a guess. The cell goes through `cellToDateString`, so serial-number dates come out readable.

## Variance Logic

`computeMaterialSummary` (in `src/server/reports.server.ts`) unions the material numbers across all three uploads and for each one computes:

- `inProduction` — summed quantity from the production report
- `finished` — summed quantity from the materials report
- `totalOnHand` — `inProduction + finished`
- `requested` — summed delivery quantity (condition `02` rows only)
- `variance` — `totalOnHand - requested`

Rows are ordered by material number. A negative variance is a shortfall and is shown in red. Material names prefer the materials report, then production, then delivery. Each row also carries `production` — the material's `{ date, quantity }` entries from the schedule, merged per date and sorted earliest first — and `deliveries`, its delivery lines.

Every quantity on screen is a whole number: `formatNumber` in `src/lib/units.ts` rounds to zero fraction digits, and every tile, table cell, and chart tooltip routes through it. (`footprints.tsx` keeps its own two-decimal `formatNumber`, because a cases-per-pallet value can legitimately be fractional.)

Order numbers arrive padded with trailing filler, so `formatOrderNumber` (also in `units.ts`) trims anything past the first 9 characters **for display only**. Grouping, sorting, refs, and highlighting all key on the full untrimmed string, so two orders can never collapse into one.

### Stat tiles

Above the chart: **Materials tracked**, **Finished Goods**, **To be produced**, **Needed for loads**, and **Shortfalls**. *Finished Goods* is the summed `finished` quantity — only what is physically finished — and *To be produced* is the summed `inProduction` quantity, so the two are disjoint and neither is contained in the other. *To be produced* only appears while a production report occupies its slot; it disappears again when that slot is cleared, and the grid drops from five columns to four. The table's **Stock on Hand** column and the variance math still use `totalOnHand` (`inProduction + finished`); only the tile is narrower than that.

## Pallet View

The dashboard's **Pallet View** button converts case quantities to pallet quantities. The conversion comes from the footprint key: a footprint like `100X25X4` means 100 cases fit on a pallet, so only the **first number** is used. `scripts/generate-footprints.mjs` parses `scripts/reference/Key.xlsx` into `src/server/data/material-footprints.json` (a plain material-number → cases-per-pallet map) so the runtime never has to read the binary key file.

Re-run it after updating the key:

```bash
node scripts/generate-footprints.mjs
```

Materials with no footprint match stay in cases and are labelled `cs`; the table shows a note counting them.

The toggle is page-wide and lives in the page header, above everything it changes: the stat tiles and both tables. Because cases-per-pallet differs by material, a page-level total can't be divided at the end — `totalUnits` in `src/lib/units.ts` converts material by material and keeps the unconvertible cases separate, so the **Finished Goods**, **To be produced**, and **Needed for loads** tiles read as `… pl` with a `+ N cs with no footprint` note underneath when part of the total has no key match. The load table's totals are built the same way, from each load's own per-material lines. A total made up entirely of unkeyed materials falls back to cases instead of reading as zero. The chart is deliberately left in cases: a by-load bar mixes materials with different pallet sizes, so there is no single divisor for it. `formatNumber`, `formatOrderNumber`, `formatQty`, `formatTotal`, and `totalUnits` all live in `src/lib/units.ts`.

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

`src/lib/shortfalls.ts` holds both aggregations as pure functions. The allocation loop also keeps the per-material breakdown it used to throw away: each `LoadShortfall` carries `customerPO` and a `lines` array of `{ material, materialName, requested, available, variance, casesPerPallet }`. `summarizeLoads` returns **every** load in allocation order (what the load table renders); `topShortfallLoads` filters that to `variance < 0`, worst first, sliced to the chart limit. The dashboard calls `summarizeLoads` once and derives its chart rows from the result, so nothing allocates twice.

Clicking a bar jumps to the matching row: the dashboard relaxes the search box (and the shortfalls filter, if it would hide the target), expands the row, scrolls it to the middle of the viewport, and flashes it amber for a few seconds. In by-material mode the target is the material's row; in by-load mode it's the **load's** row, keyed on the full untrimmed order number. Because the row may not exist yet when the search is being cleared, the scroll runs from an effect keyed on the visible rows rather than inline in the click handler.

The chart body collapses behind a chevron in the card header (`aria-expanded`, open by default), animated with a `grid-rows-[1fr]` → `grid-rows-[0fr]` transition so it works at any chart height. The heading, the caption, the grouping toggle, and the ship-date range stay visible when it's collapsed — they're how you decide whether to open it, and the toggle still drives the table.

## Loads View

With **By load #** selected, the table below the chart mirrors the material table one row per outbound load: Load # · Customer PO · Ship Date · Materials · Stock Available · Needed for Loads · Variance, sorted worst-variance-first by default. Load # renders through `formatOrderNumber`. Expanding a row lists that load's materials (Material · Name · Needed · Available · Variance) from the allocation's own `lines`, so pallet view converts with each material's footprint.

`LoadSortKey` and `filterAndSortLoads` in `table-sort.ts` handle the sorting and filtering: **Shortfalls Only** keeps loads with a negative variance, and the search box matches the load number, the Customer PO, or any material number/name on the load. Expanded state is per-view — switching the toggle collapses whatever was open rather than carrying an id across two different kinds of row.

## Ship Date Range

Two date inputs (**From** / **To**, with a **Clear** button that appears once either is set) sit in the view controls next to the grouping toggle. `filterMaterialsByShipDate` in `table-sort.ts` applies the window client-side **before** anything else is computed, and the filtered array feeds the tiles, the chart in both groupings, and both tables.

Only delivery lines whose ship date falls inside the range (inclusive at both ends) survive; `requested` and `variance` are rebuilt from the survivors while `totalOnHand`, `inProduction`, and `finished` are left alone, because stock isn't dated. A material whose lines all fall outside the window stays in the list with `requested: 0`. Lines with no parseable ship date are dropped while a range is active — they can't be shown to fall inside it — and a note under the controls counts them.

## Production Schedule Page

`/production` (linked from the dashboard header, `Factory` icon) is a clean read of the uploaded schedule, loaded by `getProductionSchedule` → `listProductionSchedule`. Rows are grouped by production date ascending, each date a subheading row carrying that date's total case count, with Material · Name · Quantity beneath it. A search box filters on material number and name. Undated rows group last. When no production report is loaded the page shows an empty state linking back to the dashboard.

## Table Controls

Both dashboard tables — the variance/load table and the detail table inside an expanded row — have Excel-style sortable column headers, as does the footprints table. `src/components/sort-header.tsx` renders them: clicking a header sorts that column ascending; clicking the active header flips the direction. `src/lib/table-sort.ts` holds the comparators, which are pure and shared with the server:

- **Material number** sorts numerically, not as text, so `999` comes before `1000`.
- **Loading date / ship date** sort on the parsed date, since these arrive as `m/d/yy` strings where a text sort would put `10/1/26` before `7/29/26`. Blank dates stay last in both directions.
- **Cases per pallet** keeps materials with no footprint at the bottom in both directions, so the gaps to fill in don't scatter through the list when the sort flips.
- `computeMaterialSummary` uses the same `sortDeliveries` helper to produce its default oldest-ship-date-first order, so the server and the client can't drift.

The delivery table inside an expanded material row shows Order # · Customer PO · Plant · Sold-To · Ship Date · Quantity. Loading date is no longer a column, but it is still parsed and still feeds the load allocation as the ship-date fallback, and `loadingDate` remains in `DeliverySortKey`.

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
