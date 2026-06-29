import type { Metadata } from "next";
import { Providers } from "./providers";
import { AppLayout } from "./app-layout";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "MediaLocker Dashboard",
    template: "%s | MediaLocker",
  },
  description: "Manage your MediaLocker storage, media library, and settings.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppLayout>{children}</AppLayout>
        </Providers>
      </body>
    </html>
  );
}
