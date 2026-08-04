CREATE TABLE "report_lines" (
	"id" serial PRIMARY KEY,
	"report_id" integer NOT NULL,
	"category" text NOT NULL,
	"amount" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY,
	"slot" integer NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "report_lines" ADD CONSTRAINT "report_lines_report_id_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id");