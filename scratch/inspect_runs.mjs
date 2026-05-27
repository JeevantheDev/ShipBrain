import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const { Client } = pg;

function loadEnvFile(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, "utf8")
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
  } catch {
    return {};
  }
}

function getDatabaseUrl(env) {
  if (env.DIRECT_URL) return env.DIRECT_URL;
  if (env.SUPABASE_DB_URL) return env.SUPABASE_DB_URL;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  return `postgresql://postgres:${encodeURIComponent(env.SUPABASE_DB_PASSWORD)}@db.${projectRef}.supabase.co:5432/postgres`;
}

async function main() {
  const env = { ...process.env, ...loadEnvFile(path.join(process.cwd(), ".env.local")) };
  const client = new Client({
    connectionString: getDatabaseUrl(env),
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    const { rows } = await client.query(
      "select github_run_id, spec_id, workflow_name, title, html_url, head_sha, branch, status, conclusion, created_at from public.ci_runs where repo_full_name = 'JeevantheDev/shipbrain_sandbox' order by created_at desc limit 5"
    );
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(console.error);
