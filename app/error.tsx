"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function RootError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ShipBrain root error boundary", error);
  }, [error]);

  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card" role="alert" aria-live="assertive">
        <div className="error-boundary-icon" aria-hidden="true">
          <AlertTriangle size={20} />
        </div>
        <div>
          <span className="eyebrow">ShipBrain recovered the view</span>
          <h1>Something interrupted this page</h1>
          <p>
            The workspace is still available. Retry the page, or return to the dashboard while ShipBrain
            keeps the rest of the app steady.
          </p>
          {error.digest ? <code>Error digest: {error.digest}</code> : null}
          <div className="error-boundary-actions">
            <button className="primary-action" type="button" onClick={reset}>
              <RefreshCw size={15} />
              Retry
            </button>
            <Link className="secondary-action" href="/dashboard">
              Open dashboard
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
