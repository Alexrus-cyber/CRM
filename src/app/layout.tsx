import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { ThemeProvider } from "next-themes";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nova CRM — управление задачами и командой",
  description:
    "CRM-система: дашборд, задачи, контрагенты, календарь, команда и чат, достижения.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="min-h-screen">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} nonce={nonce}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
