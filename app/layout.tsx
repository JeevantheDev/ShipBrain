import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShipBrain",
  description: "AI-powered production command center"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
