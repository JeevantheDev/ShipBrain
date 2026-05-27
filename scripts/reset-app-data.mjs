import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const { Client } = pg;

function loadEnvFile(filePath) {
  try {
    return Object.fromEntries(
      fsSync.readFileSync(filePath, "utf8")
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
  throw new Error("Missing DIRECT_URL, SUPABASE_DB_URL, or DATABASE_URL.");
}

function getSupabaseAdmin(env) {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for auth user reset.");
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

async function deleteAuthUsers(env) {
  const supabase = getSupabaseAdmin(env);
  let page = 1;
  let deleted = 0;

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const users = data.users ?? [];
    if (!users.length) break;

    for (const user of users) {
      const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
      if (deleteError) throw deleteError;
      deleted += 1;
    }

    if (users.length < 100) break;
    page += 1;
  }

  return deleted;
}

async function main() {
  const env = { ...process.env, ...loadEnvFile(path.join(process.cwd(), ".env.local")) };
  const includeAuthUsers = process.argv.includes("--include-auth-users");
  const client = new Client({
    connectionString: getDatabaseUrl(env),
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query("begin");
    await client.query(`
      truncate table
        public.approval_events,
        public.cloudflare_webhook_events,
        public.ci_runs,
        public.incidents,
        public.notifications,
        public.release_traces,
        public.specs,
        public.telegram_notification_deliveries,
        public.telegram_users,
        public.telegram_webhook_updates,
        public.trace_events,
        public.repos,
        public.profiles
      cascade;
    `);
    await client.query("commit");
    const deletedUsers = includeAuthUsers ? await deleteAuthUsers(env) : 0;
    console.log(
      includeAuthUsers
        ? `ShipBrain full reset complete. Deleted ${deletedUsers} Supabase auth users.`
        : "ShipBrain app data reset complete. Supabase auth users were not deleted. Pass --include-auth-users for a full reset."
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
