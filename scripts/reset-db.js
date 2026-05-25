const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf8");
const envVars = {};
envContent.split("\n").forEach(line => {
  const [key, ...valueParts] = line.split("=");
  if (key && valueParts.length) {
    envVars[key.trim()] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
  }
});

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function reset() {
  const tables = [
    "approval_events",
    "ci_runs", 
    "specs",
    "incidents",
    "repos"  // This is the connected repos table
  ];

  for (const table of tables) {
    console.log(`Deleting all from ${table}...`);
    const { error } = await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) console.error(`  ${table} error:`, error.message);
    else console.log(`  ✓ ${table} cleared`);
  }

  console.log("\nDatabase reset complete! (auth users & profiles preserved)");
}

reset().catch(console.error);
