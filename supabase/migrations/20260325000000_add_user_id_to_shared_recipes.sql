-- Add user_id to shared_recipes so shares are attributable to their creator.
-- Nullable (not a FK) to keep reads simple and avoid orphan issues if a user
-- account is deleted — the share page remains accessible until expiry.

alter table public.shared_recipes
    add column if not exists user_id text;
