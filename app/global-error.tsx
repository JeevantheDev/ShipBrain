"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import "./globals.css";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error("ShipBrain global error boundary", error);

  return (
    <html lang="en">
      <body>
        <main className="error-boundary-page">
          <section className="error-boundary-card" role="alert" aria-live="assertive">
            <div className="error-boundary-icon" aria-hidden="true">
              <AlertTriangle size={20} />
            </div>
            <div>
              <span className="eyebrow">ShipBrain system boundary</span>
              <h1>The app shell needs a retry</h1>
              <p>
                A top-level render failed before the workspace could finish loading. Retry the app shell to
                restore the current session.
              </p>
              {error.digest ? <code>Error digest: {error.digest}</code> : null}
              <div className="error-boundary-actions">
                <button className="primary-action" type="button" onClick={reset}>
                  <RefreshCw size={15} />
                  Retry app
                </button>
                <a className="secondary-action" href="/dashboard">
                  Open dashboard
                </a>
              </div>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
