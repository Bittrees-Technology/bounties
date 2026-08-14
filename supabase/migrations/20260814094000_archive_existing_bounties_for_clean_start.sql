-- Start the public product with an empty marketplace without destroying the
-- historical bounty and escrow evidence retained for private audit purposes.
-- Rows created after this migration are unaffected.

update public.bounties
set
  moderation_status = 'hidden',
  moderation_reason = 'Archived for the August 2026 marketplace reset';
