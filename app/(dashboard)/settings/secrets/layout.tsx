import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Secrets Settings | ShipBrain",
  description: "Securely configure environment variables, API tokens, and credentials for your repositories."
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
