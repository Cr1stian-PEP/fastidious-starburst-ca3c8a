import { pgTable, serial, text, integer, timestamp, doublePrecision } from "drizzle-orm/pg-core";

export const reports = pgTable("reports", {
  id: serial().primaryKey(),
  slot: integer("slot").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const reportLines = pgTable("report_lines", {
  id: serial().primaryKey(),
  reportId: integer("report_id").notNull().references(() => reports.id),
  category: text("category").notNull(),
  amount: doublePrecision("amount").notNull(),
});
