-- goblett elections: which elections exist and which wallets each one whitelists, so the
-- app can show a signed-in wallet the elections it may vote in. Everything here is a copy
-- of public on-chain data; the server function reads it back from the chain before
-- storing it (functions/api/elections.js).
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists public.elections (
  chain_id         bigint not null,
  -- lowercase 0x address of the election contract
  address          text   not null check (address ~ '^0x[0-9a-f]{40}$'),
  title            text   not null,
  -- 'fptp' or 'ranked'
  kind             text   not null,
  -- lowercase 0x address of the wallet that deployed it
  creator          text   not null check (creator ~ '^0x[0-9a-f]{40}$'),
  -- unix seconds, as fixed in the contract
  registration_end bigint not null,
  voting_start     bigint not null,
  voting_end       bigint not null,
  created_at       timestamptz not null default now(),
  primary key (chain_id, address)
);
create index if not exists elections_creator on public.elections (chain_id, creator);

create table if not exists public.election_voters (
  chain_id bigint not null,
  election text   not null,
  -- lowercase 0x address of a whitelisted wallet
  wallet   text   not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  primary key (chain_id, election, wallet),
  foreign key (chain_id, election) references public.elections (chain_id, address) on delete cascade
);
create index if not exists election_voters_wallet on public.election_voters (chain_id, wallet);

-- Row level security ON with no policies, as for accounts: only the site's server
-- function, which holds the secret key, reads or writes these tables.
alter table public.elections enable row level security;
alter table public.election_voters enable row level security;
