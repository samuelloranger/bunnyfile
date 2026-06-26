import type { ReactNode } from 'react';
import logo from '~/assets/logo-transparent.svg';

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
        <img src={logo} alt="BunnyFile" className="size-14 shrink-0" />
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
