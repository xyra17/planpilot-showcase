import { AuthProvider } from "@/components/technology/AuthProvider";
import { ProductShell } from "@/components/technology/ProductShell";
import { ThemeProvider } from "@/components/technology/ThemeProvider";
import { AppProviders } from "@/components/app/AppProviders";
import "@/styles/technology/base.css";
import "@/styles/technology/product-redesign.css";
import "@/styles/technology/theme-experiences.css";
import "@/styles/technology/usability.css";
import "@/styles/technology/goal-workspace.css";
import "@/styles/technology/notes-workspace.css";
import "@/styles/technology/knowledge-workspace.css";
import "@/styles/technology/companion-workspace.css";
import "@/styles/technology/settings-workspace.css";
import "@/styles/technology/settings-task-redesign.css";
import "@/styles/technology/clock-time-picker.css";
import "@/styles/technology/quick-task-select.css";
import "@/styles/technology/theme-coherence.css";
import "@/styles/technology/today-workspace.css";

export default function TechnologyWorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AppProviders>
      <AuthProvider>
        <ThemeProvider>
          <ProductShell>{children}</ProductShell>
        </ThemeProvider>
      </AuthProvider>
    </AppProviders>
  );
}
