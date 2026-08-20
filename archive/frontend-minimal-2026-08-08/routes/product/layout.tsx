import { ProductShell } from "@/components/app/ProductShell";

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell>{children}</ProductShell>;
}
