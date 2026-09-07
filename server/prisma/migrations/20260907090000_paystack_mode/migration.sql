-- Paystack live/test mode: make it a database setting rather than an env edit.
--
-- Before this the mode was implied by whichever secret sat in
-- PAYSTACK_SECRET_KEY, so switching meant editing .env and restarting the API.
-- One row now holds the answer, readable at request time and flippable without
-- a redeploy.
--
-- `test` is the default and the fallback everywhere: a fresh database, a new
-- environment, or a failed read must never resolve to charging real cards.

CREATE TYPE "PaystackEnvironment" AS ENUM ('test', 'live');

CREATE TABLE "paystack_mode" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "PaystackEnvironment" NOT NULL DEFAULT 'test',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paystack_mode_pkey" PRIMARY KEY ("id"),
    -- Enforce the singleton in the database rather than by convention: a second
    -- row would make "the current mode" ambiguous, and the ambiguity would only
    -- ever surface as a charge going to the wrong environment.
    CONSTRAINT "paystack_mode_singleton" CHECK ("id" = 'singleton')
);

-- Seed the row so every reader can assume it exists and no caller has to treat
-- "not configured yet" as a separate case.
INSERT INTO "paystack_mode" ("id", "mode", "updatedAt")
VALUES ('singleton', 'test', CURRENT_TIMESTAMP);
