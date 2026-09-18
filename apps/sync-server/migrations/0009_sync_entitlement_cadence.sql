-- Billing cadence for the active Paddle subscription.
-- Additive and nullable on purpose: existing rows keep working with NULL
-- ("unknown"), and the value fills in on the next Paddle webhook. Nothing
-- gates on cadence — it only drives the "switch to annual" affordance.
ALTER TABLE sync_entitlements ADD COLUMN cadence TEXT;
