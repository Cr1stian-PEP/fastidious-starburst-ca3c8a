CREATE TABLE "report_sessions" (
	"id" text PRIMARY KEY,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "report_lines_report_id_idx" ON "report_lines" ("report_id");--> statement-breakpoint
CREATE INDEX "reports_session_id_idx" ON "reports" ("session_id");