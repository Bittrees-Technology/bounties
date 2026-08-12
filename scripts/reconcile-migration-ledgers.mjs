import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

if (process.env.CONFIRM_BOUNTIES_MIGRATION_LEDGER_RECONCILIATION !== "yes") {
  throw new Error("Set CONFIRM_BOUNTIES_MIGRATION_LEDGER_RECONCILIATION=yes after reviewing both remote ledgers.");
}
const databaseUrl = process.env.POSTGRES_URL_NON_POOLING?.trim();
if (!databaseUrl) throw new Error("POSTGRES_URL_NON_POOLING is required for the one-time reconciliation.");
const repoVersions = new Set((await readdir(path.resolve("supabase/migrations")))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
  .map((name) => name.slice(0, name.indexOf("_"))));
const sql = postgres(databaseUrl, { connect_timeout: 15, idle_timeout: 5, max: 1, prepare: false });

try {
  await sql.begin(async (transaction) => {
    await transaction.unsafe("select pg_advisory_xact_lock(hashtext('bounties:schema-migrations:v1'))");
    const exists = await transaction.unsafe("select to_regclass('supabase_migrations.schema_migrations') is not null as exists");
    if (!exists[0]?.exists) throw new Error("The Supabase migration ledger does not exist; reconciliation is not applicable.");
    await transaction.unsafe(`
      create table if not exists public.app_schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      );
      revoke all on public.app_schema_migrations from public, anon, authenticated;
    `);
    const [supabaseRows, appRows] = await Promise.all([
      transaction.unsafe("select version from supabase_migrations.schema_migrations order by version"),
      transaction.unsafe("select version from public.app_schema_migrations order by version")
    ]);
    const supabaseVersions = new Set(supabaseRows.map(({ version }) => String(version)));
    const appVersions = new Set(appRows.map(({ version }) => String(version)));
    const unknown = [...new Set([...supabaseVersions, ...appVersions])].filter((version) => !repoVersions.has(version));
    if (unknown.length) {
      throw new Error("Remote ledgers contain unverified versions; no reconciliation was performed.");
    }
    for (const version of supabaseVersions) {
      await transaction`insert into public.app_schema_migrations(version) values (${version}) on conflict do nothing`;
    }
    await transaction.unsafe(`
      create table if not exists public.app_schema_migration_authority (
        singleton boolean primary key default true check (singleton),
        authority text not null check (authority = 'vercel-production'),
        handed_off_at timestamptz not null default now()
      );
      revoke all on public.app_schema_migration_authority from public, anon, authenticated;
      insert into public.app_schema_migration_authority(singleton, authority)
      values (true, 'vercel-production')
      on conflict (singleton) do update
        set authority = excluded.authority, handed_off_at = now();
    `);
  });
  process.stdout.write("Migration ledgers reconciled to the verified Supabase-applied repository versions.\n");
} finally {
  await sql.end({ timeout: 5 });
}
