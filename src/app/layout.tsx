import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Tutor MBOS",
  description: "Tutoring business administration",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: "0 auto",
          maxWidth: "40rem",
          padding: "2rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
