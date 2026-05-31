import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

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
    // Reset any profile whose id is amit@gmail.com (id: '18f05c09-dff3-4ea2-94de-d8aac22c5000')
    const { rowCount } = await client.query(`
      UPDATE public.profiles
      SET github_login = NULL, github_access_token = NULL, avatar_url = NULL
      WHERE id = '18f05c09-dff3-4ea2-94de-d8aac22c5000'
    `);
    console.log(`Successfully cleared connection for ${rowCount} non-owner profile(s).`);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.end();
  }
}

main();
