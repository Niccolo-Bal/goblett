-- goblett accounts: a public username for a wallet address. Nothing else.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists public.accounts (
  -- lowercase 0x address; one username per wallet
  address    text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  -- lowercase; unique across all wallets
  username   text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  -- the issuedAt of the signature that last set this row; only newer signatures may change it
  signed_at  bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row level security ON with no policies: the publishable (browser) key can do nothing.
-- Only the site's server function, which holds the secret key and checks the wallet's
-- signature first, reads or writes this table.
alter table public.accounts enable row level security;
