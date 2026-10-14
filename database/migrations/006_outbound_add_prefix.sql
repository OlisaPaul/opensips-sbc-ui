-- Explicit, additive migration for the existing custom outbound routing table.
-- Existing routes retain their rows and add no digits by default.
ALTER TABLE prefix_mapping
  ADD COLUMN IF NOT EXISTS add_prefix varchar(32) NULL DEFAULT NULL AFTER strip_prefix;
