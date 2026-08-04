# Report Variance Analysis

A small web app for comparing three reports side by side and surfacing where their line items diverge. Upload three CSV files — each a list of `category,amount` rows — and the app matches up categories across the reports, computes the variance and variance percentage for each, and charts the comparison.

## How it works

- Each report is uploaded into one of three slots. Re-uploading into a slot replaces its previous contents.
- Categories are matched by exact name across the three reports.
- For each category, the app shows every report's value plus the min/max variance and variance percentage. Rows with 10% or more variance are flagged.

## Tech stack

- [TanStack Start](https://tanstack.com/start) (React 19, TanStack Router)
- Tailwind CSS 4
- Chart.js / react-chartjs-2 for the comparison chart
- Netlify Database (managed Postgres) with Drizzle ORM for storing report data
- Deployed on Netlify

## Running locally

```bash
npm install
npm run dev
```

This starts the Vite dev server. For full Netlify platform emulation (including the database), use the Netlify CLI instead:

```bash
netlify dev
```

## Database

Schema is defined in `db/schema.ts`. Any schema change requires generating a migration:

```bash
npx drizzle-kit generate --name <descriptive_name>
```

Migrations live in `netlify/database/migrations/` and are applied automatically by Netlify on deploy.
