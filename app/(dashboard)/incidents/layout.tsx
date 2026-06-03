import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Incident Control | ShipBrain",
  description: "Triage and resolve production incidents using AI root cause analysis, countdown-gated hotfixes, and automated post-mortems."
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
