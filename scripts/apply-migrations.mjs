import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;

function loadEnvFile(filePath) {
  return Object.fromEntries(
    (awaitSafe(() => fsSync.readFileSync(filePath, "utf8")) ?? "")
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function awaitSafe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function getDatabaseUrl(env) {
  if (env.DIRECT_URL) return env.DIRECT_URL;
  if (env.SUPABASE_DB_URL) return env.SUPABASE_DB_URL;
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  if (!env.SUPABASE_DB_PASSWORD) {
    throw new Error(
      "Missing database connection. Add SUPABASE_DB_URL or SUPABASE_DB_PASSWORD to .env.local. You can find the DB password in Supabase Project Settings > Database."
    );
  }
  return `postgresql://postgres:${encodeURIComponent(env.SUPABASE_DB_PASSWORD)}@db.${projectRef}.supabase.co:5432/postgres`;
}

async function getMigrationFiles() {
  const migrationDir = path.join(process.cwd(), "supabase", "migrations");
  const files = await fs.readdir(migrationDir);
  return files
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => path.join(migrationDir, file));
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists public.shipbrain_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query("select name from public.shipbrain_migrations");
  return new Set(rows.map((row) => row.name));
}

async function main() {
  const mode = process.argv[2] ?? "apply";
  const env = { ...process.env, ...loadEnvFile(path.join(process.cwd(), ".env.local")) };
  const client = new Client({
    connectionString: getDatabaseUrl(env),
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files = await getMigrationFiles();

    if (mode === "status") {
      for (const file of files) {
        const name = path.basename(file);
        console.log(`${applied.has(name) ? "applied" : "pending"} ${name}`);
      }
      return;
    }

    for (const file of files) {
      const name = path.basename(file);
      if (applied.has(name)) {
        console.log(`skip ${name}`);
        continue;
      }
      const sql = await fs.readFile(file, "utf8");
      console.log(`apply ${name}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into public.shipbrain_migrations(name) values($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    console.log("migrations complete");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
