import Link from "next/link";
import { Search } from "lucide-react";

export default function NotFound() {
  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card">
        <div className="error-boundary-icon" aria-hidden="true">
          <Search size={20} />
        </div>
        <div>
          <span className="eyebrow">404</span>
          <h1>This ShipBrain view does not exist</h1>
          <p>
            The route may have moved, or the workspace link is no longer valid. Head back to the dashboard
            to continue from the current system state.
          </p>
          <div className="error-boundary-actions">
            <Link className="primary-action" href="/dashboard">
              Open dashboard
            </Link>
            <Link className="secondary-action" href="/spec-to-pr">
              Go to Spec-to-PR
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
