import { resolvePublicShipBrainUrl } from "@/lib/shipbrain/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function yaml(serverUrl: string) {
  return `openapi: 3.0.3
info:
  title: ShipBrain Agent API
  version: 1.0.0
  description: Read-only ShipBrain operational context for Microsoft Foundry agents.
servers:
  - url: ${serverUrl}
security:
  - ShipBrainApiKey: []
paths:
  /api/agent/context:
    get:
      operationId: getDashboardSummary
      summary: Get the current ShipBrain dashboard summary.
      description: Returns connected repos, recent PRs, CI runs, pending deployments, incidents, release traces, and notifications.
      responses:
        "200":
          description: Dashboard context.
  /api/agent/prs:
    get:
      operationId: getRecentPrs
      summary: Get recent ShipBrain Spec-to-PR records.
      parameters:
        - in: query
          name: status
          schema:
            type: string
          required: false
        - in: query
          name: limit
          schema:
            type: integer
            minimum: 1
            maximum: 50
          required: false
      responses:
        "200":
          description: Recent PR records.
  /api/agent/ci-runs:
    get:
      operationId: getCiRuns
      summary: Get recent CI workflow runs.
      parameters:
        - in: query
          name: repo
          schema:
            type: string
          required: false
        - in: query
          name: limit
          schema:
            type: integer
            minimum: 1
            maximum: 50
          required: false
      responses:
        "200":
          description: CI workflow runs.
  /api/agent/deployments/pending:
    get:
      operationId: getPendingDeployments
      summary: Get pending preview and production deployment records.
      responses:
        "200":
          description: Pending deployments.
  /api/agent/incidents:
    get:
      operationId: getIncidents
      summary: Get ShipBrain incidents.
      parameters:
        - in: query
          name: status
          schema:
            type: string
          required: false
        - in: query
          name: limit
          schema:
            type: integer
            minimum: 1
            maximum: 50
          required: false
      responses:
        "200":
          description: Incident records.
  /api/agent/release-traces:
    get:
      operationId: getReleaseTraces
      summary: Get Release Trace board records.
      parameters:
        - in: query
          name: status
          schema:
            type: string
          required: false
        - in: query
          name: repo
          schema:
            type: string
          required: false
        - in: query
          name: limit
          schema:
            type: integer
            minimum: 1
            maximum: 50
          required: false
      responses:
        "200":
          description: Release trace records.
components:
  securitySchemes:
    ShipBrainApiKey:
      type: apiKey
      in: header
      name: x-shipbrain-api-key
      description: Repo-specific ShipBrain API key that starts with sb_live_.
`;
}

export async function GET(request: Request) {
  const serverUrl = resolvePublicShipBrainUrl(request);
  return new Response(yaml(serverUrl), {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
