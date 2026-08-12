import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const databaseUrl = process.env.POSTGRES_URL_NON_POOLING?.trim() || process.env.POSTGRES_URL?.trim();
const isVercelCloudBuild = process.env.VERCEL === "1" && process.env.CI === "true";

if (!databaseUrl) {
  if (isVercelCloudBuild) {
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

    const appliedRows = await transaction`select version from public.app_schema_migrations`;
    const applied = new Set(appliedRows.map(({ version }) => String(version)));

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
