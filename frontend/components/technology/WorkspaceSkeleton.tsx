type WorkspaceSkeletonProps = {
  variant?: "page" | "editor";
  label?: string;
};

function SkeletonLine({ className = "" }: { className?: string }) {
  return <span className={`skeleton-line ${className}`} aria-hidden="true" />;
}

export function WorkspaceSkeleton({
  variant = "page",
  label = "正在加载内容",
}: WorkspaceSkeletonProps) {
  if (variant === "editor") {
    return (
      <div className="workspace-skeleton skeleton-editor" role="status" aria-label={label}>
        <div className="skeleton-editor-toolbar" aria-hidden="true">
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <div className="skeleton-editor-canvas">
          <SkeletonLine className="is-title" />
          <SkeletonLine className="is-medium" />
          <SkeletonLine />
          <SkeletonLine className="is-long" />
          <SkeletonLine className="is-short" />
        </div>
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  return (
    <div className="workspace-skeleton skeleton-page" role="status" aria-label={label}>
      <section className="skeleton-page-heading" aria-hidden="true">
        <div>
          <SkeletonLine className="is-kicker" />
          <SkeletonLine className="is-heading" />
          <SkeletonLine className="is-medium" />
        </div>
        <span className="skeleton-action" />
      </section>
      <section className="skeleton-page-grid" aria-hidden="true">
        <article>
          <SkeletonLine className="is-kicker" />
          <SkeletonLine className="is-heading" />
          <SkeletonLine className="is-long" />
          <div className="skeleton-row">
            <span /><span /><span />
          </div>
        </article>
        <article>
          <SkeletonLine className="is-kicker" />
          <SkeletonLine className="is-medium" />
          <div className="skeleton-chart">
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} style={{ height: `${32 + ((index * 17) % 46)}%` }} />
            ))}
          </div>
        </article>
      </section>
      <span className="sr-only">{label}</span>
    </div>
  );
}
