-- Server-only tables; use a dedicated database and restricted runtime role.
create schema if not exists jungle;
create table if not exists jungle.players (
 id uuid primary key, display_name text not null check (char_length(display_name) between 2 and 40),
 token_hash text not null unique, created_at timestamptz not null default now()
);
create unique index if not exists jungle_player_name on jungle.players(lower(display_name));
create table if not exists jungle.rounds (
 id uuid primary key, round_key text unique not null, title text not null,
 category text not null check (category in ('daily','trial','survivor','eviction','champion','final')),
 opens_at timestamptz not null, closes_at timestamptz not null, check (opens_at < closes_at)
);
create table if not exists jungle.questions (
 id uuid primary key, round_id uuid not null references jungle.rounds(id),
 position integer not null, prompt text not null, options jsonb not null,
 points integer not null check(points between 1 and 20),
 resolution_rule text not null, status text not null default 'pending' check(status in ('pending','settled','void')),
 answer text, evidence jsonb, resolved_at timestamptz,
 unique(round_id,position),
 check ((status='settled' and answer is not null and evidence is not null) or (status='void' and answer is null and evidence is not null) or (status='pending' and answer is null))
);
create table if not exists jungle.predictions (
 player_id uuid not null references jungle.players(id), question_id uuid not null references jungle.questions(id),
 choice text not null, updated_at timestamptz not null default now(), primary key(player_id,question_id)
);
create index if not exists jungle_predictions_question on jungle.predictions(question_id);
revoke all on schema jungle from public;
revoke all on all tables in schema jungle from public;
-- For Supabase defense in depth; direct server-side role needs explicit policies/grants if not owner.
alter table jungle.players enable row level security;
alter table jungle.rounds enable row level security;
alter table jungle.questions enable row level security;
alter table jungle.predictions enable row level security;
