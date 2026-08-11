-- Server-side Bounties API boundary.
-- Browser callers never receive service-role credentials; the edge function validates
-- the HttpOnly bounties_session cookie and calls these SECURITY DEFINER routines.

alter table public.proposals add column if not exists proposal_hash text check (proposal_hash is null or proposal_hash ~ '^0x[0-9a-fA-F]{64}$');
alter table public.escrow_records add column if not exists transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fA-F]{64}$');
alter table public.escrow_records add column if not exists block_hash text check (block_hash is null or block_hash ~ '^0x[0-9a-fA-F]{64}$');
alter table public.escrow_records add column if not exists log_index integer check (log_index is null or log_index >= 0);
create unique index if not exists escrow_records_chain_tx_unique
  on public.escrow_records (chain_id, transaction_hash)
  where transaction_hash is not null;
create unique index if not exists escrow_records_chain_bounty_unique
  on public.escrow_records (chain_id, onchain_bounty_id)
  where onchain_bounty_id is not null;

create table if not exists public.api_rate_limits (
  actor_id uuid not null references public.wallet_accounts(id) on delete cascade,
  action text not null check (action in ('token_inspection')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (actor_id, action)
);
alter table public.api_rate_limits enable row level security;
alter table public.api_rate_limits force row level security;
revoke all on public.api_rate_limits from anon, authenticated;

create function public.app_consume_rate_limit(
  p_actor_id uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql security definer set search_path = public as $$
declare current_row public.api_rate_limits;
begin
  if p_action <> 'token_inspection' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'RATE_LIMIT_CONFIG_INVALID' using errcode = '22023';
  end if;

  insert into public.api_rate_limits (actor_id, action, window_started_at, request_count)
  values (p_actor_id, p_action, now(), 1)
  on conflict (actor_id, action) do update
    set window_started_at = case
          when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then now()
          else public.api_rate_limits.window_started_at
        end,
        request_count = case
          when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1
          else public.api_rate_limits.request_count + 1
        end
  returning * into current_row;

  if current_row.request_count > p_limit then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
end $$;

create function public.app_resolve_wallet_session(
  p_token_digest text,
  p_csrf_digest text default null,
  p_require_csrf boolean default false
)
returns table(session_id uuid, account_id uuid, wallet_address text, csrf_valid boolean)
language plpgsql security definer set search_path = public as $$
begin
  if p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'SESSION_EXPIRED' using errcode = '28000';
  end if;

  return query
  update public.wallet_sessions as s
     set last_seen_at = now(),
         idle_expires_at = least(s.absolute_expires_at, now() + interval '30 minutes')
    from public.wallet_accounts as a
   where s.account_id = a.id
     and s.token_digest = p_token_digest
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
     and (not p_require_csrf or s.csrf_digest = p_csrf_digest)
   returning s.id, s.account_id, a.wallet_address, (s.csrf_digest = p_csrf_digest);

  if not found then
    raise exception 'SESSION_EXPIRED' using errcode = '28000';
  end if;
end $$;

create function public.app_revoke_wallet_session(p_session_id uuid, p_account_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.wallet_sessions
     set revoked_at = coalesce(revoked_at, now()), idle_expires_at = least(idle_expires_at, now())
   where id = p_session_id and account_id = p_account_id and revoked_at is null;
end $$;

create function public.app_set_account_role(p_actor_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('buyer', 'provider') then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  insert into public.account_roles (account_id, role)
  values (p_actor_id, p_role)
  on conflict (account_id, role) do nothing;

  return (
    select jsonb_build_object(
      'account', jsonb_build_object('id', id, 'wallet_address', wallet_address, 'display_name', display_name),
      'roles', coalesce((select jsonb_agg(role order by role) from public.account_roles where account_id = p_actor_id), '[]'::jsonb)
    )
    from public.wallet_accounts
    where id = p_actor_id
  );
end $$;

create function public.app_upsert_inspected_token(
  p_actor_id uuid,
  p_chain_id bigint,
  p_contract_address text,
  p_checksum_address text,
  p_name text,
  p_symbol text,
  p_decimals integer,
  p_total_supply text,
  p_bytecode_present boolean,
  p_bytecode_hash text,
  p_proxy_status text,
  p_source_verification_status text,
  p_explorer_url text,
  p_risk_flags jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  token_row public.tokens;
  normalized text := public.app_normalize_wallet(p_contract_address);
  supply numeric(78,0);
begin
  if normalized is null or public.app_normalize_wallet(p_checksum_address) is distinct from normalized then
    raise exception 'INVALID_TOKEN_ADDRESS' using errcode = '22023';
  end if;
  if p_chain_id < 1 or p_explorer_url !~ '^https://' then
    raise exception 'INVALID_TOKEN_IDENTITY' using errcode = '22023';
  end if;
  if p_decimals is not null and (p_decimals < 0 or p_decimals > 255) then
    raise exception 'INVALID_TOKEN_DECIMALS' using errcode = '22023';
  end if;
  if p_total_supply is not null then
    supply := p_total_supply::numeric(78,0);
  end if;

  insert into public.tokens (
    chain_id, contract_address, checksum_address, name, symbol, decimals, total_supply,
    bytecode_present, bytecode_hash, proxy_status, source_verification_status, explorer_url,
    risk_flags, inspected_at, created_by
  )
  values (
    p_chain_id, normalized, p_checksum_address, nullif(p_name, ''), nullif(p_symbol, ''),
    p_decimals, supply, p_bytecode_present, p_bytecode_hash,
    coalesce(p_proxy_status, 'unknown'), coalesce(p_source_verification_status, 'unknown'),
    p_explorer_url, coalesce(p_risk_flags, '[]'::jsonb), now(), p_actor_id
  )
  on conflict (chain_id, contract_address) do update
    set checksum_address = excluded.checksum_address,
        name = excluded.name,
        symbol = excluded.symbol,
        decimals = excluded.decimals,
        total_supply = excluded.total_supply,
        bytecode_present = excluded.bytecode_present,
        bytecode_hash = excluded.bytecode_hash,
        proxy_status = excluded.proxy_status,
        source_verification_status = excluded.source_verification_status,
        explorer_url = excluded.explorer_url,
        risk_flags = excluded.risk_flags,
        inspected_at = now()
  returning * into token_row;

  return to_jsonb(token_row) || jsonb_build_object(
    'total_supply', case when token_row.total_supply is null then null else token_row.total_supply::text end
  );
end $$;

create function public.app_create_bounty(
  p_actor_id uuid,
  p_title text,
  p_description text,
  p_scope_source jsonb,
  p_scope_hash text,
  p_chain_id bigint,
  p_token_id uuid,
  p_budget_base_units text,
  p_milestones jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  token_row public.tokens;
  bounty_row public.bounties;
  milestone jsonb;
  milestone_total numeric(78,0) := 0;
  budget numeric(78,0) := p_budget_base_units::numeric(78,0);
begin
  select * into token_row from public.tokens where id = p_token_id and chain_id = p_chain_id;
  if not found or token_row.decimals is null then
    raise exception 'TOKEN_NOT_INSPECTED' using errcode = '22023';
  end if;
  if budget <= 0 or trunc(budget) <> budget then
    raise exception 'INVALID_BUDGET_BASE_UNITS' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_milestones, '[]'::jsonb)) <> 'array' or jsonb_array_length(p_milestones) < 1 then
    raise exception 'INVALID_MILESTONES' using errcode = '22023';
  end if;

  for milestone in select * from jsonb_array_elements(p_milestones) loop
    milestone_total := milestone_total + (milestone->>'amount_base_units')::numeric(78,0);
  end loop;
  if milestone_total <> budget then
    raise exception 'MILESTONE_TOTAL_MISMATCH' using errcode = '23514';
  end if;

  insert into public.account_roles (account_id, role) values (p_actor_id, 'buyer') on conflict do nothing;
  insert into public.bounties (
    creator_id, title, description, scope_source, scope_hash, chain_id, token_id,
    token_decimals, budget_base_units, status
  )
  values (
    p_actor_id, btrim(p_title), p_description, coalesce(p_scope_source, '{}'::jsonb),
    p_scope_hash, p_chain_id, p_token_id, token_row.decimals, budget, 'open'
  )
  returning * into bounty_row;

  for milestone in select * from jsonb_array_elements(p_milestones) loop
    insert into public.milestones (
      bounty_id, ordinal, title, amount_base_units, scope_source, evidence_requirements
    )
    values (
      bounty_row.id,
      coalesce((milestone->>'ordinal')::integer, 0),
      btrim(milestone->>'title'),
      (milestone->>'amount_base_units')::numeric(78,0),
      coalesce(milestone->'scope_source', '{}'::jsonb),
      coalesce(milestone->'evidence_requirements', '{}'::jsonb)
    );
  end loop;

  return public.app_bounty_json(bounty_row.id, p_actor_id);
end $$;

create function public.app_create_proposal(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_note text,
  p_proposed_total_base_units text,
  p_proposed_milestones jsonb,
  p_proposal_hash text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  proposal_row public.proposals;
  total numeric(78,0) := p_proposed_total_base_units::numeric(78,0);
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found or bounty_row.status <> 'open' then
    raise exception 'BOUNTY_NOT_OPEN' using errcode = '22023';
  end if;
  if bounty_row.creator_id = p_actor_id then
    raise exception 'CREATOR_CANNOT_PROPOSE' using errcode = '42501';
  end if;
  if total <> bounty_row.budget_base_units then
    raise exception 'PROPOSAL_BUDGET_MISMATCH' using errcode = '23514';
  end if;
  if p_proposal_hash is not null and p_proposal_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'INVALID_PROPOSAL_HASH' using errcode = '22023';
  end if;

  insert into public.account_roles (account_id, role) values (p_actor_id, 'provider') on conflict do nothing;
  insert into public.proposals (bounty_id, provider_id, note, proposed_total_base_units, proposed_milestones, proposal_hash)
  values (p_bounty_id, p_actor_id, btrim(p_note), total, coalesce(p_proposed_milestones, '[]'::jsonb), p_proposal_hash)
  returning * into proposal_row;

  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (
    bounty_row.creator_id, 'proposal', 'bounty', bounty_row.id, 'Proposal received',
    'proposal:' || proposal_row.id::text
  ) on conflict (dedupe_key) do nothing;

  return to_jsonb(proposal_row) || jsonb_build_object(
    'proposed_total_base_units', proposal_row.proposed_total_base_units::text
  );
end $$;

create function public.app_accept_proposal(p_actor_id uuid, p_bounty_id uuid, p_proposal_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  proposal_row public.proposals;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found or bounty_row.creator_id <> p_actor_id then
    raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501';
  end if;
  if bounty_row.status <> 'open' then
    raise exception 'BOUNTY_NOT_OPEN' using errcode = '22023';
  end if;
  select * into proposal_row from public.proposals where id = p_proposal_id and bounty_id = p_bounty_id for update;
  if not found or proposal_row.status <> 'active' then
    raise exception 'PROPOSAL_NOT_ACTIVE' using errcode = '22023';
  end if;
  if proposal_row.proposed_total_base_units <> bounty_row.budget_base_units then
    raise exception 'PROPOSAL_BUDGET_MISMATCH' using errcode = '23514';
  end if;

  update public.proposals
     set status = case when id = p_proposal_id then 'accepted'::public.proposal_status else 'rejected'::public.proposal_status end
   where bounty_id = p_bounty_id and status = 'active';
  update public.bounties set accepted_proposal_id = p_proposal_id, status = 'accepted' where id = p_bounty_id;
  update public.milestones set assigned_provider_id = proposal_row.provider_id, status = 'assigned' where bounty_id = p_bounty_id and status = 'pending';
  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (proposal_row.provider_id, 'proposal_accepted', 'bounty', p_bounty_id, 'Proposal accepted', 'proposal-accepted:' || p_proposal_id::text)
  on conflict (dedupe_key) do nothing;

  return public.app_bounty_json(p_bounty_id, p_actor_id);
end $$;

create function public.app_submit_delivery_evidence(
  p_actor_id uuid,
  p_milestone_id uuid,
  p_uri text,
  p_content_hash text,
  p_evidence_hash text,
  p_hash_version text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  next_revision integer;
  evidence_row public.delivery_evidence;
begin
  select * into milestone_row from public.milestones where id = p_milestone_id for update;
  if not found or milestone_row.assigned_provider_id <> p_actor_id then
    raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode = '42501';
  end if;
  if milestone_row.status <> 'funded' then
    raise exception 'MILESTONE_NOT_DELIVERABLE' using errcode = '22023';
  end if;
  select * into bounty_row from public.bounties where id = milestone_row.bounty_id;
  select coalesce(max(revision), 0) + 1 into next_revision from public.delivery_evidence where milestone_id = p_milestone_id;

  insert into public.delivery_evidence (
    milestone_id, provider_id, uri, content_hash, evidence_hash, hash_version, revision
  )
  values (p_milestone_id, p_actor_id, p_uri, p_content_hash, p_evidence_hash, coalesce(p_hash_version, 'bounties-evidence-v1'), next_revision)
  returning * into evidence_row;

  update public.milestones set status = 'delivered' where id = p_milestone_id;
  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (bounty_row.creator_id, 'delivery', 'milestone', p_milestone_id, 'Delivery evidence submitted', 'delivery:' || evidence_row.id::text)
  on conflict (dedupe_key) do nothing;

  return to_jsonb(evidence_row);
end $$;

create function public.app_accept_delivery(p_actor_id uuid, p_milestone_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  provider uuid;
begin
  select * into milestone_row from public.milestones where id = p_milestone_id for update;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode = '22023'; end if;
  select * into bounty_row from public.bounties where id = milestone_row.bounty_id for update;
  if bounty_row.creator_id <> p_actor_id then
    raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501';
  end if;
  if milestone_row.status <> 'delivered' then
    raise exception 'MILESTONE_NOT_DELIVERED' using errcode = '22023';
  end if;
  provider := milestone_row.assigned_provider_id;
  update public.milestones set status = 'accepted' where id = p_milestone_id;
  if not exists (select 1 from public.milestones where bounty_id = bounty_row.id and id <> p_milestone_id and status <> 'accepted') then
    update public.bounties set status = 'completed' where id = bounty_row.id;
  end if;
  if provider is not null then
    insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
    values (provider, 'delivery_accepted', 'milestone', p_milestone_id, 'Delivery accepted', 'delivery-accepted:' || p_milestone_id::text)
    on conflict (dedupe_key) do nothing;
  end if;
  return public.app_bounty_json(bounty_row.id, p_actor_id);
end $$;

create function public.app_record_escrow_observation(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_contract_address text,
  p_interface_version text,
  p_onchain_bounty_id text,
  p_requested_base_units text,
  p_received_base_units text,
  p_status text,
  p_transaction_hash text,
  p_block_hash text,
  p_log_index integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  existing_row public.escrow_records;
  normalized_contract text := null;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found or bounty_row.creator_id <> p_actor_id then
    raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501';
  end if;
  if p_contract_address is not null then
    normalized_contract := public.app_normalize_wallet(p_contract_address);
    if normalized_contract is null then raise exception 'INVALID_ESCROW_CONTRACT' using errcode = '22023'; end if;
  end if;
  if p_transaction_hash is null or p_transaction_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'INVALID_ESCROW_TRANSACTION' using errcode = '22023';
  end if;
  if p_block_hash is null or p_block_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'INVALID_ESCROW_BLOCK' using errcode = '22023';
  end if;
  if p_log_index is null or p_log_index < 0 then
    raise exception 'INVALID_ESCROW_LOG_INDEX' using errcode = '22023';
  end if;

  select * into existing_row from public.escrow_records where bounty_id = p_bounty_id for update;
  if found then
    if existing_row.chain_id <> bounty_row.chain_id
      or existing_row.contract_address is distinct from normalized_contract
      or existing_row.onchain_bounty_id is distinct from p_onchain_bounty_id
      or existing_row.transaction_hash is distinct from lower(p_transaction_hash)
      or existing_row.block_hash is distinct from lower(p_block_hash)
      or existing_row.log_index is distinct from p_log_index then
      raise exception 'ESCROW_BINDING_IMMUTABLE' using errcode = '23505';
    end if;
    return to_jsonb(existing_row) || jsonb_build_object(
      'requested_base_units', existing_row.requested_base_units::text,
      'received_base_units', existing_row.received_base_units::text
    );
  else
    insert into public.escrow_records (
    bounty_id, chain_id, token_id, contract_address, interface_version, onchain_bounty_id,
    requested_base_units, received_base_units, status, transaction_hash, block_hash, log_index
    )
    values (
      p_bounty_id, bounty_row.chain_id, bounty_row.token_id, normalized_contract,
      coalesce(p_interface_version, 'escrow-adapter.v1'), p_onchain_bounty_id,
      p_requested_base_units::numeric(78,0), coalesce(p_received_base_units, '0')::numeric(78,0),
      coalesce(p_status, 'pending')::public.escrow_status, lower(p_transaction_hash), lower(p_block_hash), p_log_index
    )
    returning * into escrow_row;
  end if;

  update public.bounties
     set status = 'funded'
   where id = p_bounty_id and status in ('accepted', 'funding_pending', 'funded');
  if not found then
    raise exception 'BOUNTY_NOT_READY_FOR_FUNDING' using errcode = '22023';
  end if;
  update public.milestones
     set status = 'funded'
   where bounty_id = p_bounty_id and status = 'assigned';

  return to_jsonb(escrow_row) || jsonb_build_object(
    'requested_base_units', escrow_row.requested_base_units::text,
    'received_base_units', escrow_row.received_base_units::text
  );
end $$;

create function public.app_mark_notification_read(p_actor_id uuid, p_notification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  notification_row public.notifications;
begin
  update public.notifications
     set read_at = coalesce(read_at, now())
   where id = p_notification_id and recipient_id = p_actor_id
   returning * into notification_row;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode = '42501'; end if;
  return to_jsonb(notification_row);
end $$;

create function public.app_bounty_json(p_bounty_id uuid, p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(b) ||
    jsonb_build_object(
      'budget_base_units', b.budget_base_units::text,
      'token', to_jsonb(t) || jsonb_build_object(
        'total_supply', case when t.total_supply is null then null else t.total_supply::text end
      ),
      'milestones', coalesce((
        select jsonb_agg(to_jsonb(m) || jsonb_build_object(
          'amount_base_units', m.amount_base_units::text,
          'evidence', coalesce((
            select jsonb_agg(to_jsonb(e) order by e.revision)
            from public.delivery_evidence e
            where e.milestone_id = m.id
          ), '[]'::jsonb)
        ) order by m.ordinal)
        from public.milestones m
        where m.bounty_id = b.id
      ), '[]'::jsonb),
      'proposals', coalesce((
        select jsonb_agg(
          to_jsonb(p) || jsonb_build_object(
            'proposed_total_base_units', p.proposed_total_base_units::text,
            'provider_wallet_address', provider.wallet_address
          )
          order by p.created_at
        )
        from public.proposals p
        join public.wallet_accounts provider on provider.id = p.provider_id
        where p.bounty_id = b.id
      ), '[]'::jsonb),
      'escrow', (
        select to_jsonb(er) || jsonb_build_object(
          'requested_base_units', er.requested_base_units::text,
          'received_base_units', er.received_base_units::text
        ) from public.escrow_records er where er.bounty_id = b.id
      )
    )
  from public.bounties b
  join public.tokens t on t.id = b.token_id
  where b.id = p_bounty_id
    and (b.status <> 'draft' or b.creator_id = p_actor_id)
$$;

create function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'account', (
      select jsonb_build_object('id', id, 'wallet_address', wallet_address, 'display_name', display_name)
      from public.wallet_accounts where id = p_actor_id
    ),
    'roles', coalesce((select jsonb_agg(role order by role) from public.account_roles where account_id = p_actor_id), '[]'::jsonb),
    'tokens', coalesce((
      select jsonb_agg(to_jsonb(t) || jsonb_build_object(
        'total_supply', case when t.total_supply is null then null else t.total_supply::text end
      ) order by t.chain_id, t.contract_address)
      from public.tokens t
    ), '[]'::jsonb),
    'bounties', coalesce((
      select jsonb_agg(public.app_bounty_json(b.id, p_actor_id) order by b.created_at desc)
      from public.bounties b
      where b.status <> 'draft' or b.creator_id = p_actor_id
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from public.notifications n
      where n.recipient_id = p_actor_id
    ), '[]'::jsonb)
  )
$$;

revoke all on function
  public.app_resolve_wallet_session(text,text,boolean),
  public.app_consume_rate_limit(uuid,text,integer,integer),
  public.app_revoke_wallet_session(uuid,uuid),
  public.app_set_account_role(uuid,text),
  public.app_upsert_inspected_token(uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,jsonb),
  public.app_create_bounty(uuid,text,text,jsonb,text,bigint,uuid,text,jsonb),
  public.app_create_proposal(uuid,uuid,text,text,jsonb,text),
  public.app_accept_proposal(uuid,uuid,uuid),
  public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text),
  public.app_accept_delivery(uuid,uuid),
  public.app_record_escrow_observation(uuid,uuid,text,text,text,text,text,text,text,text,integer),
  public.app_mark_notification_read(uuid,uuid),
  public.app_bounty_json(uuid,uuid),
  public.app_marketplace_snapshot(uuid)
from public;

grant execute on function
  public.app_resolve_wallet_session(text,text,boolean),
  public.app_consume_rate_limit(uuid,text,integer,integer),
  public.app_revoke_wallet_session(uuid,uuid),
  public.app_set_account_role(uuid,text),
  public.app_upsert_inspected_token(uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,jsonb),
  public.app_create_bounty(uuid,text,text,jsonb,text,bigint,uuid,text,jsonb),
  public.app_create_proposal(uuid,uuid,text,text,jsonb,text),
  public.app_accept_proposal(uuid,uuid,uuid),
  public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text),
  public.app_accept_delivery(uuid,uuid),
  public.app_record_escrow_observation(uuid,uuid,text,text,text,text,text,text,text,text,integer),
  public.app_mark_notification_read(uuid,uuid),
  public.app_bounty_json(uuid,uuid),
  public.app_marketplace_snapshot(uuid)
to service_role;
