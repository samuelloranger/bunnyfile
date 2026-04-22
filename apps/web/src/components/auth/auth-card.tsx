import type { ReactNode } from 'react';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-[hsl(var(--background))] px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.18),transparent_50%),radial-gradient(ellipse_at_bottom,hsl(var(--accent)/0.12),transparent_45%)]"
      />
      {children}
    </div>
  );
}

export function AuthCard({
  title,
  description,
  footer,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="w-full max-w-md">
      <div className="mb-6 flex flex-col items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[hsl(var(--primary))] to-[hsl(var(--accent))] text-white shadow-lg shadow-[hsl(var(--primary)/0.35)]">
          <span aria-hidden className="text-xl leading-none">
            🐰
          </span>
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{description}</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6 shadow-xl shadow-black/5 dark:shadow-black/30">
        {children}
      </div>

      {footer && (
        <p className="mt-4 text-center text-xs text-[hsl(var(--muted-foreground))]">{footer}</p>
      )}
    </div>
  );
}
