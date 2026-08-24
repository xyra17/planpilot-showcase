import type { Metadata } from "next";
import "./globals.css";
import { KnowledgeProvider } from "@/lib/knowledge-context";

export const metadata: Metadata = {
  title: "PlanPilot - 你的长期学习伙伴",
  description: "理解学习节奏，陪伴长期目标",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <KnowledgeProvider>
          {children}
        </KnowledgeProvider>
      </body>
    </html>
  );
}
