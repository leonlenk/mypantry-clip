-- Cloud sync table: stores recipe JSON for backup/restore only.
-- Embeddings are NOT stored here — they are computed client-side and kept
-- exclusively in IndexedDB for local cosine search. The cloud never queries
-- by vector similarity, so pgvector is not needed.

create table if not exists public.recipes (
    id           text        primary key,          -- URL-derived slug (matches IndexedDB key)
    user_id      uuid        not null references auth.users(id) on delete cascade,
    recipe_json  jsonb       not null,             -- Full Recipe object (embedding field excluded)
    created_at   timestamptz default now(),
    updated_at   timestamptz default now()
);

-- Row Level Security: each user can only CRUD their own recipes
alter table public.recipes enable row level security;

create policy "Users manage own recipes"
    on public.recipes
    for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Index for fast user lookups (most queries filter by user_id)
create index if not exists recipes_user_id_idx
    on public.recipes (user_id, updated_at desc);
