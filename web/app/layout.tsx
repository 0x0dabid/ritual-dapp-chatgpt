import "@/styles/globals.css";
import { Web3Provider } from "@/components/Web3Provider";

export { metadata } from "next/headers";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
