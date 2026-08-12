import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const databaseUrl = process.env.POSTGRES_URL_NON_POOLING?.trim() || process.env.POSTGRES_URL?.trim();
const isVercelCloudBuild = process.env.VERCEL === "1" && process.env.CI === "true";
const isVercelProductionBuild = isVercelCloudBuild && process.env.VERCEL_ENV === "production";

if (isVercelCloudBuild && !isVercelProductionBuild) {
  process.stdout.write("Database migration skipped: preview and development builds are read-only.\n");
  process.exit(0);
}

if (!databaseUrl) {
  if (isVercelProductionBuild) {
    throw new Error("Database migration configuration is unavailable.");
  }
  process.stdout.write("Database migration skipped: no deployment database is configured.\n");
  process.exit(0);
}

const migrationsDirectory = path.resolve("supabase/migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
  .sort();

if (!migrationFiles.length) throw new Error("No database migrations were found.");

const sql = postgres(databaseUrl, {
  connect_timeout: 15,
  idle_timeout: 5,
  max: 1,
  prepare: false
});

try {
  await sql.begin(async (transaction) => {
    await transaction.unsafe("select pg_advisory_xact_lock(hashtext('bounties:schema-migrations:v1'))");
    await transaction.unsafe(`
      create table if not exists public.app_schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      );
      revoke all on public.app_schema_migrations from public, anon, authenticated;
    `);

    const supabaseLedger = await transaction.unsafe(`
      select to_regclass('supabase_migrations.schema_migrations') is not null as exists
    `);
    if (supabaseLedger[0]?.exists) {
      const untrackedSupabaseVersions = await transaction.unsafe(`
        select supabase.version
        from supabase_migrations.schema_migrations supabase
        left join public.app_schema_migrations app on app.version = supabase.version
        where app.version is null
      `);
      if (untrackedSupabaseVersions.length) {
        throw new Error('The retired Supabase ledger contains versions unknown to the Vercel authority; run the documented one-time reconciliation.');
      }
    }

    const appliedRows = await transaction`select version from public.app_schema_migrations`;
    const applied = new Set(appliedRows.map(({ version }) => String(version)));
    const unknownApplied = [...applied].filter((version) => !migrationFiles.some((filename) => filename.startsWith(`${version}_`)));
    if (unknownApplied.length) throw new Error('The Vercel migration ledger contains a version absent from this repository.');

    for (const filename of migrationFiles) {
      const version = filename.slice(0, filename.indexOf("_"));
      if (applied.has(version)) continue;
      const migration = await readFile(path.join(migrationsDirectory, filename), "utf8");
      process.stdout.write(`Applying database migration ${filename}\n`);
      await transaction.unsafe(migration);
      await transaction`insert into public.app_schema_migrations (version) values (${version})`;
    }
  });
  process.stdout.write("Database migrations are current.\n");
} catch {
  throw new Error("Database migration failed; no partial migration was committed.");
} finally {
  await sql.end({ timeout: 5 });
}
