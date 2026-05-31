import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTIAL_UUID_REGEX = /^[0-9a-f-]{7,36}$/i;

function mapTraceToMockSpec(trace: any) {
  return {
    id: trace.spec_id || trace.id,
    status: trace.status,
    repo_full_name: trace.repo_full_name,
    branch_name: trace.source_branch,
    base_branch: trace.target_branch,
    pr_number: trace.draft_pr_number || trace.release_pr_number || null,
    pr_url: trace.draft_pr_url || trace.release_pr_url || null,
    preview_url: trace.preview_deployment?.url || null,
    release_tag: trace.production_deployment?.releaseTag || null,
    decomposed_tasks: { prTitle: trace.title },
    updated_at: trace.updated_at,
    created_at: trace.created_at
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  console.log("[Specs API] GET called for ID:", id, "authenticated user_id:", user?.id);

  if (!user) {
    console.log("[Specs API] Unauthorized access attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cleanId = id.trim().toLowerCase();
  console.log("[Specs API] Cleaned ID:", cleanId);

  // 1. If it's a full UUID
  if (FULL_UUID_REGEX.test(cleanId)) {
    console.log("[Specs API] Full UUID detected. Checking specs table...");
    const { data: spec, error: specErr } = await supabase
      .from("specs")
      .select("*")
      .eq("id", cleanId)
      .maybeSingle();

    if (specErr) {
      console.error("[Specs API] DB Error querying specs:", specErr.message);
      return NextResponse.json({ error: "Failed to fetch spec", detail: specErr.message }, { status: 500 });
    }

    if (spec) {
      console.log("[Specs API] Found directly in specs table:", spec.id);
      return NextResponse.json(spec);
    }

    console.log("[Specs API] Not found in specs. Checking release_traces table...");
    const { data: trace, error: traceErr } = await supabase
      .from("release_traces")
      .select("*")
      .eq("id", cleanId)
      .maybeSingle();

    if (traceErr) {
      console.error("[Specs API] DB Error querying traces:", traceErr.message);
      return NextResponse.json({ error: "Failed to fetch trace", detail: traceErr.message }, { status: 500 });
    }

    if (trace) {
      console.log("[Specs API] Found trace matching ID:", trace.id);
      if (trace.spec_id) {
        console.log("[Specs API] Trace has spec_id:", trace.spec_id, ". Fetching spec...");
        const { data: specFromTrace, error: specFromTraceErr } = await supabase
          .from("specs")
          .select("*")
          .eq("id", trace.spec_id)
          .maybeSingle();

        if (!specFromTraceErr && specFromTrace) {
          console.log("[Specs API] Spec resolved from trace:", specFromTrace.id);
          return NextResponse.json(specFromTrace);
        }
      }
      console.log("[Specs API] No direct spec or resolved spec. Returning mapped mock spec from trace.");
      return NextResponse.json(mapTraceToMockSpec(trace));
    }

    console.log("[Specs API] ID did not match any spec or release trace.");
    return NextResponse.json({ error: "Spec not found" }, { status: 404 });
  }

  // 2. If it's a partial UUID prefix
  if (PARTIAL_UUID_REGEX.test(cleanId)) {
    console.log("[Specs API] Partial UUID detected. Fetching all specs and traces...");
    const { data: allSpecs, error: specsErr } = await supabase
      .from("specs")
      .select("*");

    if (specsErr) {
      console.error("[Specs API] DB Error fetching all specs:", specsErr.message);
      return NextResponse.json({ error: "Failed to fetch specs", detail: specsErr.message }, { status: 500 });
    }

    const searchTarget = cleanId.replace(/-/g, "");
    
    // Check in specs table first
    const spec = allSpecs?.find(s => {
      const cleanDbId = s.id.replace(/-/g, "").toLowerCase();
      return cleanDbId.startsWith(searchTarget);
    }) ?? null;

    if (spec) {
      console.log("[Specs API] Partial matched in specs table:", spec.id);
      return NextResponse.json(spec);
    }

    // Check in release_traces table
    console.log("[Specs API] Partial not matched in specs. Fetching release traces...");
    const { data: allTraces, error: tracesErr } = await supabase
      .from("release_traces")
      .select("*");

    if (tracesErr) {
      console.error("[Specs API] DB Error fetching all traces:", tracesErr.message);
      return NextResponse.json({ error: "Failed to fetch traces", detail: tracesErr.message }, { status: 500 });
    }

    const trace = allTraces?.find(t => {
      const cleanDbId = t.id.replace(/-/g, "").toLowerCase();
      return cleanDbId.startsWith(searchTarget);
    }) ?? null;

    if (trace) {
      console.log("[Specs API] Partial matched trace:", trace.id);
      if (trace.spec_id) {
        const specFromTrace = allSpecs?.find(s => s.id === trace.spec_id);
        if (specFromTrace) {
          console.log("[Specs API] Resolved spec from trace in partial match:", specFromTrace.id);
          return NextResponse.json(specFromTrace);
        }
      }
      console.log("[Specs API] Returning mapped mock spec from trace in partial match.");
      return NextResponse.json(mapTraceToMockSpec(trace));
    }

    console.log("[Specs API] Partial ID did not match any spec or release trace.");
    return NextResponse.json({ error: "Spec not found" }, { status: 404 });
  }

  // 3. Invalid format
  console.log("[Specs API] Invalid spec ID format:", cleanId);
  return NextResponse.json({ error: "Invalid spec ID format" }, { status: 400 });
}


