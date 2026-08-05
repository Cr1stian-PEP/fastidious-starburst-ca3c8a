CREATE TABLE "material_footprints" (
	"material" text PRIMARY KEY,
	"cases_per_pallet" double precision NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
