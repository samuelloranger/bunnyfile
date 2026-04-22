import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '~/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, leftIcon, rightIcon, invalid, type = 'text', ...props }, ref) => {
    const hasLeft = Boolean(leftIcon);
    const hasRight = Boolean(rightIcon);

    return (
      <div className="relative w-full">
        {hasLeft && (
          <span
            className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center text-[hsl(var(--muted-foreground))] [&_svg]:size-4"
            aria-hidden
          >
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          type={type}
          aria-invalid={invalid || undefined}
          className={cn(
            'flex h-9 w-full rounded-md bg-[hsl(var(--surface))] px-3 text-sm',
            'border border-[hsl(var(--input))] text-[hsl(var(--foreground))]',
            'placeholder:text-[hsl(var(--muted-foreground))]',
            'transition-[border-color,box-shadow] duration-150',
            'focus-visible:outline-none focus-visible:border-[hsl(var(--ring))] focus-visible:ring-4 focus-visible:ring-[hsl(var(--ring)/0.15)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[hsl(var(--foreground))]',
            hasLeft && 'pl-9',
            hasRight && 'pr-9',
            invalid &&
              'border-[hsl(var(--destructive))] focus-visible:border-[hsl(var(--destructive))] focus-visible:ring-[hsl(var(--destructive)/0.2)]',
            className,
          )}
          {...props}
        />
        {hasRight && (
          <span
            className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center text-[hsl(var(--muted-foreground))] [&_svg]:size-4"
            aria-hidden
          >
            {rightIcon}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
