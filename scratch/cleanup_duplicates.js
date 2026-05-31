const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Read .env.local manually
try {
  const envPath = path.join(__dirname, "../.env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        let val = match[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        process.env[key] = val;
      }
    });
  }
} catch (err) {
  console.error("Error reading .env.local", err);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const correctTraceId = "41a21af0-4eb0-46a4-a838-e8702626f9c1";
  const duplicateTraceIds = [
    "7d0109b3-7978-4abe-8cc0-7d6248c4c9bc",
    "1851df18-71fd-4943-bdb9-238399c40c64"
  ];
  const originalSpecId = "c96b2933-618d-4191-af08-c6adf5069f7c";
  const duplicateSpecId = "18effe9d-b316-429b-9d16-9b4758517ce1";

  console.log("1. Updating correct trace to point to original spec...");
  const { error: updateTraceErr } = await supabase
    .from("release_traces")
    .update({ spec_id: originalSpecId })
    .eq("id", correctTraceId);

  if (updateTraceErr) {
    console.error("Failed to update correct trace spec_id:", updateTraceErr);
  } else {
    console.log("Correct trace updated successfully.");
  }

  console.log("2. Deleting trace events for duplicate traces...");
  const { error: deleteEventsErr } = await supabase
    .from("trace_events")
    .delete()
    .in("trace_id", duplicateTraceIds);

  if (deleteEventsErr) {
    console.error("Failed to delete trace events:", deleteEventsErr);
  } else {
    console.log("Duplicate trace events deleted successfully.");
  }

  console.log("3. Deleting duplicate traces...");
  const { error: deleteTracesErr } = await supabase
    .from("release_traces")
    .delete()
    .in("id", duplicateTraceIds);

  if (deleteTracesErr) {
    console.error("Failed to delete duplicate traces:", deleteTracesErr);
  } else {
    console.log("Duplicate traces deleted successfully.");
  }

  console.log("4. Checking and deleting any references to the duplicate spec...");
  // Check if any other table points to the duplicate spec
  const { data: specRuns } = await supabase
    .from("spec_runs")
    .select("id")
    .eq("spec_id", duplicateSpecId);

  if (specRuns && specRuns.length > 0) {
    console.log(`Found ${specRuns.length} spec runs for duplicate spec, deleting them...`);
    const { error: deleteRunsErr } = await supabase
      .from("spec_runs")
      .delete()
      .eq("spec_id", duplicateSpecId);
    if (deleteRunsErr) console.error("Failed to delete spec runs:", deleteRunsErr);
  }

  console.log("5. Deleting duplicate spec...");
  const { error: deleteSpecErr } = await supabase
    .from("specs")
    .delete()
    .eq("id", duplicateSpecId);

  if (deleteSpecErr) {
    console.error("Failed to delete duplicate spec:", deleteSpecErr);
  } else {
    console.log("Duplicate spec deleted successfully.");
  }

  console.log("Cleanup complete!");
}

main().catch(console.error);
