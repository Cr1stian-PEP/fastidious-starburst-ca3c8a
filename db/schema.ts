import { pgTable, serial, text, integer, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";

// One browser visit. Uploaded reports belong to a session and are only ever read
// back through it, so two people working at the same time never see each other's
// files and a new visit starts empty. Rows here are disposable: a session whose
// last_seen_at has gone stale is deleted along with everything it uploaded.
export const reportSessions = pgTable("report_sessions", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export const reports = pgTable("reports", {
  id: serial().primaryKey(),
  type: text("type").notNull(), // 'production' | 'materials' | 'delivery'
  label: text("label").notNull(),
  // Which visit uploaded this report. Nullable only because rows predating
  // session scoping exist; those belong to nobody and are purged rather than
  // shown, so everything written now carries a session.
  sessionId: text("session_id"),
  // Retained so the schema matches the applied migration. Nothing writes it
  // now: the production page reads the parsed schedule, not a raw grid.
  rawSheet: text("raw_sheet"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  // Every read of a report starts from the session that owns it.
  index("reports_session_id_idx").on(t.sessionId),
]);

export const reportLines = pgTable("report_lines", {
  id: serial().primaryKey(),
  reportId: integer("report_id").notNull().references(() => reports.id),
  material: text("material").notNull(),
  materialName: text("material_name").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  // delivery-only fields, used for the per-material expand view
  orderNumber: text("order_number"),
  customerPo: text("customer_po"),
  plantName: text("plant_name"),
  soldTo: text("sold_to"),
  loadingDate: text("loading_date"),
  shipDate: text("ship_date"),
  // delivery-only: shipping condition from column T ('01' or '02')
  shippingCondition: text("shipping_condition"),
  // production-only: the date block the row sits under in the schedule
  productionDate: text("production_date"),
}, (t) => [
  // Lines are always fetched for a known set of reports.
  index("report_lines_report_id_idx").on(t.reportId),
]);

// User edits to the pallet footprint key. The generated
// src/server/data/material-footprints.json stays the baseline; a row here
// overrides it for that material, which is how the footprints page adds a
// material the key file doesn't cover or corrects one it gets wrong.
export const materialFootprints = pgTable("material_footprints", {
  material: text("material").primaryKey(),
  casesPerPallet: doublePrecision("cases_per_pallet").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
