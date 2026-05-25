import Link from "next/link";
import { ArrowRight, GitPullRequest, Siren, TestTube2 } from "lucide-react";
import { DashboardPrOverview } from "@/components/dashboard/DashboardPrOverview";
import { EnvironmentsWidget } from "@/components/dashboard/EnvironmentsWidget";
import { PendingDeployQueue } from "@/components/dashboard/PendingDeployQueue";
import { RecentActivity } from "@/components/dashboard/RecentActivity";

export default function DashboardPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Command center</div>
          <h1>Ship software with AI doing the mechanical work.</h1>
          <p>Paste specs, explain CI failures, and coordinate incidents with human approval at each critical step.</p>
        </div>
      </div>

      <DashboardPrOverview />

      <section className="grid two" style={{ marginTop: 18 }}>
        <PendingDeployQueue />

        <div className="panel">
          <h2>Quick Actions</h2>
          <div className="split-list">
            <Link className="button secondary" href="/spec-to-pr">
              <GitPullRequest size={18} />
              Generate Draft PR
              <ArrowRight size={16} />
            </Link>
            <Link className="button secondary" href="/ci">
              <TestTube2 size={18} />
              Explain Failed CI
              <ArrowRight size={16} />
            </Link>
            <Link className="button secondary" href="/incidents">
              <Siren size={18} />
              Triage Incident
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      <section className="grid two" style={{ marginTop: 18 }}>
        <EnvironmentsWidget />
        <RecentActivity />
      </section>
    </>
  );
}
