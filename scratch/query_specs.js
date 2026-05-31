const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://postgres.czmzfdkqwqpiznobdabc:Ew5iBUnx5lAoTxOo@aws-1-us-east-2.pooler.supabase.com:5432/postgres"
  });
  
  await client.connect();
  try {
    const res = await client.query('SELECT id, type, title, status, spec_id, release_pr_number, draft_pr_number, source_branch, target_branch FROM release_traces ORDER BY created_at DESC;');
    console.log("Release traces in DB:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

main();
