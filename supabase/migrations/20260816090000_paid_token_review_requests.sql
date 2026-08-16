-- A moderator token-review request is a paid, receipt-verified service. The
-- application verifies the canonical ERC20 Transfer before this transactional
-- boundary claims the payment and creates the queue entry.

create table public.paid_token_review_payments (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.wallet_accounts(id) on delete restrict,
  token_id uuid not null references public.tokens(id) on delete restrict,
  payment_chain_id bigint not null check (payment_chain_id in (1, 11155111)),
  payment_tx_hash text not null check (payment_tx_hash ~ '^0x[0-9a-f]{64}$'),
  payment_token_address text not null check (payment_token_address ~ '^0x[0-9a-fA-F]{40}$'),
  payment_amount_base_units numeric(78,0) not null check (payment_amount_base_units > 0),
  created_at timestamptz not null default now(),
  unique (payment_chain_id, payment_tx_hash)
);

alter table public.paid_token_review_payments enable row level security;
alter table public.paid_token_review_payments force row level security;
revoke all on table public.paid_token_review_payments from public, anon, authenticated, service_role;

create function public.app_report_paid_token_review(
  p_actor_id uuid,
  p_token_id uuid,
  p_reason text,
  p_payment_chain_id bigint,
  p_payment_tx_hash text,
  p_payment_token_address text,
  p_payment_amount_base_units text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  claimed public.paid_token_review_payments;
  existing public.paid_token_review_payments;
  existing_report public.content_reports;
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tokens where id = p_token_id) then
    raise exception 'CONTENT_NOT_FOUND' using errcode = '22023';
  end if;
  if p_payment_chain_id not in (1,11155111)
    or p_payment_tx_hash !~ '^0x[0-9a-f]{64}$'
    or p_payment_token_address !~ '^0x[0-9a-fA-F]{40}$'
    or p_payment_amount_base_units !~ '^[1-9][0-9]*$' then
    raise exception 'INVALID_TOKEN_REVIEW_PAYMENT' using errcode = '22023';
  end if;

  insert into public.paid_token_review_payments (
    reporter_id,token_id,payment_chain_id,payment_tx_hash,payment_token_address,payment_amount_base_units
  ) values (
    p_actor_id,p_token_id,p_payment_chain_id,lower(p_payment_tx_hash),p_payment_token_address,p_payment_amount_base_units::numeric
  ) on conflict (payment_chain_id,payment_tx_hash) do nothing
  returning * into claimed;

  if claimed.id is null then
    select * into existing from public.paid_token_review_payments payment
      where payment.payment_chain_id=p_payment_chain_id and payment.payment_tx_hash=lower(p_payment_tx_hash);
    if existing.reporter_id<>p_actor_id or existing.token_id<>p_token_id
      or lower(existing.payment_token_address)<>lower(p_payment_token_address)
      or existing.payment_amount_base_units<>p_payment_amount_base_units::numeric then
      raise exception 'TOKEN_REVIEW_PAYMENT_ALREADY_USED' using errcode = '23505';
    end if;
    select * into existing_report from public.content_reports report
      where report.reporter_id=p_actor_id and report.entity_type='token' and report.entity_id=p_token_id;
    if existing_report.id is null then raise exception 'TOKEN_REVIEW_PAYMENT_STATE_INVALID' using errcode='40001'; end if;
    return to_jsonb(existing_report) - 'internal_note';
  end if;

  return public.app_report_content(p_actor_id,'token',p_token_id,p_reason);
end $$;

revoke all on function public.app_report_paid_token_review(uuid,uuid,text,bigint,text,text,text)
from public, anon, authenticated;
grant execute on function public.app_report_paid_token_review(uuid,uuid,text,bigint,text,text,text)
to service_role;
