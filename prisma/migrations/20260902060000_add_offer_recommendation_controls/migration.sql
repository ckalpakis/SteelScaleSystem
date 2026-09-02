CREATE TYPE "ProspectRelationshipStatus" AS ENUM (
  'prospect',
  'current_customer',
  'former_customer',
  'partner',
  'do_not_target'
);

ALTER TABLE "ProspectBusiness"
ADD COLUMN "relationship_status" "ProspectRelationshipStatus" NOT NULL DEFAULT 'prospect';

CREATE TABLE "OfferSuppression" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "offer" "IntelligenceOffer" NOT NULL,
  "reason" TEXT NOT NULL,
  "suppressed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lifted_at" TIMESTAMP(3),
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfferSuppression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProspectBusiness_client_id_relationship_status_idx"
ON "ProspectBusiness"("client_id", "relationship_status");

CREATE INDEX "OfferSuppression_client_id_offer_lifted_at_idx"
ON "OfferSuppression"("client_id", "offer", "lifted_at");

CREATE INDEX "OfferSuppression_lead_id_offer_suppressed_at_idx"
ON "OfferSuppression"("lead_id", "offer", "suppressed_at");

CREATE UNIQUE INDEX "OfferSuppression_one_active_per_offer_idx"
ON "OfferSuppression"("lead_id", "offer") WHERE "lifted_at" IS NULL;

ALTER TABLE "OfferSuppression"
ADD CONSTRAINT "OfferSuppression_client_id_fkey"
FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OfferSuppression"
ADD CONSTRAINT "OfferSuppression_lead_id_fkey"
FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
