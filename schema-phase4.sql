-- Parent Sync — Phase 4 migration (docs/parent-sync-spec.md §6.2, §7).
-- Adds parent-assigned child identity to pairing, to a database already
-- created from schema.sql (+ schema-phase3.sql if applied separately).
-- Purely additive: the new column is nullable, so an old pairing code row
-- (already redeemed, or a parent-role code, which never carries one) is
-- untouched.
--
-- Apply with:
--   npx wrangler d1 execute star-homeschool --remote --file=./schema-phase4.sql
--
-- The --remote flag matters (§12 Step 4): without it you migrate a local dev
-- copy and the real database stays on the old schema, with every step
-- appearing to succeed.
--
-- schema.sql carries this same column, so a *fresh* deployment needs only
-- that file. This one exists for the deployment that is already live.

ALTER TABLE pairing_codes ADD COLUMN child_id TEXT REFERENCES children(id);
