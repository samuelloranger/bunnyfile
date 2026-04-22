import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '~/lib/cn';

const sizeMap = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-sm',
  lg: 'size-11 text-base',
  xl: 'size-14 text-lg',
} as const;
export type AvatarSize = keyof typeof sizeMap;

type RootProps = ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
  size?: AvatarSize;
};

export const Avatar = forwardRef<HTMLSpanElement, RootProps>(
  ({ className, size = 'md', ...props }, ref) => (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden rounded-full',
        'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
        'ring-1 ring-[hsl(var(--border))]',
        sizeMap[size],
        className,
      )}
      {...props}
    />
  ),
);
Avatar.displayName = 'Avatar';

export const AvatarImage = forwardRef<
  HTMLImageElement,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn('aspect-square h-full w-full object-cover', className)}
    {...props}
  />
));
AvatarImage.displayName = 'AvatarImage';

export const AvatarFallback = forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center font-medium uppercase',
      'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';
