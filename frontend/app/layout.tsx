import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme-context";
import { TasksProvider } from "@/lib/tasks-context";
import { KnowledgeProvider } from "@/lib/knowledge-context";

export const metadata: Metadata = {
  title: "PlanPilot - AI 学习规划工具",
  description: "用 AI 制定你的学习计划",
};

const THEME_INIT_SCRIPT = `(function(){try{
  var info=localStorage.getItem('user_info');
  var uid='guest';
  try{if(info)uid=JSON.parse(info).id||'guest';}catch(e){}
  var mode=localStorage.getItem('theme-mode-'+uid)||'default';
  var color=localStorage.getItem('theme-color-'+uid)||'indigo';
  if(color.indexOf('calm-')===0)mode='default';
  document.documentElement.setAttribute('data-theme',mode);
  document.documentElement.setAttribute('data-color',color);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      {/* 同步脚本：在 React 水合之前写入主题属性，防止 CSS 闪烁 */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <KnowledgeProvider>
            <TasksProvider>{children}</TasksProvider>
          </KnowledgeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
