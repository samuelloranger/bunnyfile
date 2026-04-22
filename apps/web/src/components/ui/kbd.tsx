import type { HTMLAttributes } from 'react';
import { cn } from '~/lib/cn';

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center rounded border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))]',
        'px-1.5 py-0.5 font-mono text-[10px] font-medium text-[hsl(var(--muted-foreground))]',
        className,
      )}
      {...props}
    />
  );
}
