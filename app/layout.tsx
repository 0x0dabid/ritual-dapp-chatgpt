import "@/styles/globals.css";
import { Web3Provider } from "@/components/Web3Provider";

export const metadata = {
  title: "Private ChatGPT | Ritual Chain",
  description: "Private multimodal AI generator on Ritual Chain with TEE-verified LLM, Image, Audio, and Video generation.",
};

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
