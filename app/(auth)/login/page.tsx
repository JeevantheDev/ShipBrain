import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/AuthForm";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import "../../landing.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Sign In | ShipBrain",
  description: "Sign in to ShipBrain to connect your GitHub repositories and manage your production pipeline with AI."
};

export default async function LoginPage() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/dashboard");

  return (
    <main className="landing-page-wrapper" style={{ position: "relative" }}>
      <header>
        <div className="container lp-top-inner-naked">
          <Link href="#" className="wordmark">
            <div className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="1"
                  y="2"
                  width="4"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="6"
                  y="2"
                  width="7"
                  height="2"
                  rx="0.5"
                  fill="#7d8590"
                />
                <rect
                  x="1"
                  y="6"
                  width="9"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="11"
                  y="6"
                  width="2"
                  height="2"
                  rx="0.5"
                  fill="#a371f7"
                />
                <rect
                  x="1"
                  y="10"
                  width="6"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="8"
                  y="10"
                  width="5"
                  height="2"
                  rx="0.5"
                  fill="#7d8590"
                />
              </svg>
            </div>
            <div>
               <strong style={{ fontSize: 16, letterSpacing: "-0.01em" }}>
                ship
                <em style={{ fontStyle: "normal", color: "var(--ai-purple)" }}>
                  brain
                </em>
              </strong>
            </div>
          </Link>
        </div>
      </header>
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          padding: 24,
        }}
      >
        <section className="panel" style={{ width: "min(460px, 100%)" }}>
          <div
            className="brand"
            style={{ color: "var(--ink)", marginBottom: 20 }}
          >
            {/* <div className="brand-mark">SB</div> */}
            <div>
              {/* <strong>ShipBrain</strong> */}
              <p style={{ marginBottom: 0 }}>
                Sign in first, then connect GitHub and your working
                repositories.
              </p>
            </div>
          </div>
          <AuthForm />
        </section>
      </div>
    </main>
  );
}
