# AGENTS.md

Overview of this project's structure for developers and AI agents.

## Project Overview

A report variance analysis tool. Users upload three CSV reports (each a list of `category,amount` lines); the app matches categories across the three reports and highlights where values diverge.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | TanStack Start |
| Frontend | React 19, TanStack Router v1 |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 |
| Charts | Chart.js + react-chartjs-2 |
| Database | Netlify Database (Postgres) via Drizzle ORM |
| Language | TypeScript 5.9 |
| Deployment | Netlify |

## Directory Structure

```
├── db
│   ├── schema.ts       # Drizzle table definitions: reports, report_lines
│   └── index.ts        # Drizzle client (Netlify Database adapter)
├── netlify/database/migrations   # Auto-generated SQL migrations, applied by Netlify at deploy time
├── src
│   ├── server
│   │   ├── reports.server.ts     # CSV parsing, DB reads/writes, variance calculation (server-only)
│   │   └── reports.functions.ts  # createServerFn wrappers exposed to the client
│   ├── routes
│   │   ├── __root.tsx   # Root layout
│   │   └── index.tsx    # Upload UI + variance chart/table
│   ├── router.tsx
│   └── styles.css
├── drizzle.config.ts    # Drizzle Kit config (out: netlify/database/migrations)
└── vite.config.ts
```

## Data Model

Each report occupies one of three "slots" (1, 2, or 3). Uploading a new CSV into a slot replaces whatever was previously there (report row + its line items), so variance is always computed across the current three uploads.

- `reports`: `id`, `slot`, `label` (derived from the uploaded filename), `created_at`
- `report_lines`: `id`, `report_id`, `category`, `amount`

## Variance Logic

`computeVariance` (in `src/server/reports.server.ts`) unions the categories across all uploaded reports, then for each category computes the min, max, absolute variance (max - min), and percentage variance relative to the smallest value. Rows are sorted by variance percentage, descending, so the biggest discrepancies surface first. The UI flags any row with ≥10% variance in red.

## CSV Format

Plain two-column CSV, no strict header requirement (a `category,amount` header row is auto-skipped if present):

```
category,amount
Payroll,42000
Marketing,8500
```

## Development Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
```

## Conventions

- Server-only logic lives in `*.server.ts` files and is never imported from client components.
- Client-callable RPCs live in `*.functions.ts` files using `createServerFn` with `.inputValidator` (zod) for anything that takes input.
- Schema changes go through `db/schema.ts` + `npx drizzle-kit generate --name <slug>` — never hand-written DDL.
