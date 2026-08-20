import Image from "next/image";
import Link from "next/link";

export function AppBrand({ compact = false, href = "/studio/work" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="pp-brand" aria-label="PlanPilot 首页">
      <span className="pp-brand-mark">
        <Image
          src="/brand/planpilot-tech.svg"
          width={28}
          height={28}
          alt=""
          priority
        />
      </span>
      {!compact && (
        <span>
          <span className="pp-brand-name">PlanPilot</span>
          <span className="pp-brand-caption">长期学习伙伴</span>
        </span>
      )}
    </Link>
  );
}
