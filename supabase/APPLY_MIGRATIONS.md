# Apply ShipBrain Supabase Migrations

## Option A: npm script

Add one of these to `.env.local`:

```bash
DIRECT_URL=postgresql://postgres.<project-ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
```

or:

```bash
SUPABASE_DB_PASSWORD=your-database-password
```

or paste the full pooled/direct URL:

```bash
SUPABASE_DB_URL=postgresql://postgres:<password>@db.czmzfdkqwqpiznobdabc.supabase.co:5432/postgres
```

Then run:

```bash
npm run migrate:status
npm run migrate:apply
```

## Option B: Supabase SQL Editor

Run these files in the Supabase SQL Editor for project `czmzfdkqwqpiznobdabc`, in order:

1. `supabase/migrations/001_initial.sql`
2. `supabase/migrations/002_spec_runs_resume.sql`

Then refresh the app. The Spec-to-PR page and Dashboard will read recent AI PR plans from the `specs` table.

If you prefer CLI, link the Supabase project and run:

```bash
npx supabase link --project-ref czmzfdkqwqpiznobdabc
npx supabase db push
```
