"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ShipBrain dashboard error boundary", error);
  }, [error]);

  return (
    <div className="dashboard-error-panel" role="alert" aria-live="assertive">
      <div className="error-boundary-icon" aria-hidden="true">
        <AlertTriangle size={20} />
      </div>
      <div>
        <span className="eyebrow">View error</span>
        <h1>This workspace view needs a retry</h1>
        <p>
          ShipBrain caught the error inside this page, so the sidebar and session remain available. Retry
          the view when you are ready.
        </p>
        {error.digest ? <code>Error digest: {error.digest}</code> : null}
        <div className="error-boundary-actions">
          <button className="primary-action" type="button" onClick={reset}>
            <RefreshCw size={15} />
            Retry view
          </button>
        </div>
      </div>
    </div>
  );
}
