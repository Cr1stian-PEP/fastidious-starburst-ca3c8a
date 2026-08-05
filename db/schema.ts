import { pgTable, serial, text, integer, timestamp, doublePrecision } from "drizzle-orm/pg-core";

export const reports = pgTable("reports", {
  id: serial().primaryKey(),
  type: text("type").notNull(), // 'production' | 'materials' | 'delivery'
  label: text("label").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const reportLines = pgTable("report_lines", {
  id: serial().primaryKey(),
  reportId: integer("report_id").notNull().references(() => reports.id),
  material: text("material").notNull(),
  materialName: text("material_name").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  // delivery-only fields, used for the per-material expand view
  orderNumber: text("order_number"),
  plantName: text("plant_name"),
  soldTo: text("sold_to"),
  loadingDate: text("loading_date"),
  shipDate: text("ship_date"),
});

// User edits to the pallet footprint key. The generated
// src/server/data/material-footprints.json stays the baseline; a row here
// overrides it for that material, which is how the footprints page adds a
// material the key file doesn't cover or corrects one it gets wrong.
export const materialFootprints = pgTable("material_footprints", {
  material: text("material").primaryKey(),
  casesPerPallet: doublePrecision("cases_per_pallet").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
