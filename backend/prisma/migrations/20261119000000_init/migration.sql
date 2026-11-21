CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE "Category" AS ENUM ('tree', 'planting', 'care');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(60) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(100),
    "google_id" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

CREATE TABLE "contributions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "category" "Category" NOT NULL,
  "location" geometry(Point, 4326) NOT NULL,
  "address" VARCHAR(500),
  "description" VARCHAR(240),
  "photos" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "contributor" VARCHAR(60),
  "user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contributions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contributions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "contributions_category_idx" ON "contributions"("category");
CREATE INDEX "contributions_created_at_idx" ON "contributions"("created_at");
CREATE INDEX "contributions_location_gist_idx" ON "contributions" USING GIST ("location");
