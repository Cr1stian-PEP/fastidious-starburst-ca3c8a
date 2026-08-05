ALTER TABLE "report_lines" ADD COLUMN "material" text NOT NULL;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "material_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "quantity" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "plant_name" text;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "sold_to" text;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "loading_date" text;--> statement-breakpoint
ALTER TABLE "report_lines" ADD COLUMN "ship_date" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "type" text NOT NULL;