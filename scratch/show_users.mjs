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

async function main() {
  const env = { ...process.env, ...loadEnvFile(path.join(process.cwd(), ".env.local")) };
  const client = new Client({
    connectionString: env.DIRECT_URL || env.SUPABASE_DB_URL || env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    const { rows: profiles } = await client.query("SELECT * FROM public.profiles");
    console.log("Profiles in DB:", profiles);
    
    if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await supabase.auth.admin.listUsers();
      console.log("Auth Users:", data.users.map(u => ({ id: u.id, email: u.email, metadata: u.user_metadata })));
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.end();
  }
}

main();
