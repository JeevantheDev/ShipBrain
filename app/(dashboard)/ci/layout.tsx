import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CI Monitor | ShipBrain",
  description: "Monitor and analyze your repository's CI runs, test suites, notifications, and production deployments."
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
