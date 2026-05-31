import { NextResponse } from "next/server";
import { branchExists, createDevelopBranchFromProduction, scanRepository } from "@/lib/github/setup";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function getContext() {
  const supabase = getSupabaseServerClient();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user ?? null;
  if (!user) return { supabase, user: null, token: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("github_access_token")
    .eq("id", user.id)
    .maybeSingle();
  const token = profile?.github_access_token ?? session?.provider_token;
  return { supabase, user, token };
}

export async function GET(request: Request) {
  const { user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!token) return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });

  const repo = new URL(request.url).searchParams.get("repo");
  if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });

  try {
    return NextResponse.json(await scanRepository(repo, token));
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to scan repository.", detail: error instanceof Error ? error.message : "GitHub rejected the scan request." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const { user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!token) return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });

  const body = await request.json();
  const repo = String(body.repo ?? "");
  const action = String(body.action ?? "create_develop");
  const productionBranch = String(body.productionBranch ?? "main");
  if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });

  try {
    if (action === "validate_custom") {
      const prod = String(body.productionBranch ?? "").trim();
      const dev = String(body.developmentBranch ?? "").trim();
      if (!prod || /\s/.test(prod)) return NextResponse.json({ error: "Production branch is required and cannot contain spaces." }, { status: 400 });
      const prodExists = await branchExists(repo, prod, token);
      const devExists = dev ? await branchExists(repo, dev, token) : true;
      if (!prodExists) return NextResponse.json({ error: `Branch '${prod}' was not found in this repo.` }, { status: 404 });
      if (!devExists) return NextResponse.json({ error: `Branch '${dev}' was not found in this repo.` }, { status: 404 });
      const scan = await scanRepository(repo, token);
      return NextResponse.json({
        ...scan,
        branches: {
          ...scan.branches,
          productionBranch: prod,
          developmentBranch: dev || null,
          scenario: "custom"
        }
      });
    }

    await createDevelopBranchFromProduction(repo, productionBranch, token);
    return NextResponse.json(await scanRepository(repo, token));
  } catch (error) {
    return NextResponse.json(
      { error: "Couldn't create the branch.", detail: error instanceof Error ? error.message : "Check your GitHub token has write access to this repo." },
      { status: 500 }
    );
  }
}
