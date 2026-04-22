import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '~/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      variant: {
        neutral: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
        primary: 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]',
        accent: 'bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))]',
        success: 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]',
        warning: 'bg-[hsl(var(--warning)/0.2)] text-[hsl(var(--warning-foreground))]',
        destructive: 'bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]',
        outline: 'border border-[hsl(var(--border))] text-[hsl(var(--foreground))]',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
