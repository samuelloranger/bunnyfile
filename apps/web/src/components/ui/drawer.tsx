import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ComponentPropsWithoutRef, forwardRef, type HTMLAttributes } from 'react';
import { cn } from '~/lib/cn';

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export const DrawerOverlay = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
      'data-[state=open]:animate-[overlay-in_220ms_ease-out]',
      'data-[state=closed]:animate-[overlay-out_180ms_ease-in]',
      className,
    )}
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

type Side = 'left' | 'right' | 'top' | 'bottom';

const sideClasses: Record<Side, string> = {
  right:
    'inset-y-0 right-0 h-full w-[22rem] max-w-[90vw] border-l data-[state=open]:animate-[drawer-in-right_260ms_cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:animate-[drawer-out-right_220ms_ease-in]',
  left: 'inset-y-0 left-0 h-full w-[20rem] max-w-[90vw] border-r data-[state=open]:animate-[drawer-in-left_260ms_cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:animate-[drawer-out-left_220ms_ease-in]',
  top: 'inset-x-0 top-0 border-b data-[state=open]:animate-[content-in_200ms_ease-out] data-[state=closed]:animate-[content-out_150ms_ease-in]',
  bottom:
    'inset-x-0 bottom-0 border-t data-[state=open]:animate-[content-in_200ms_ease-out] data-[state=closed]:animate-[content-out_150ms_ease-in]',
};

export interface DrawerContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: Side;
  showClose?: boolean;
}

export const DrawerContent = forwardRef<HTMLDivElement, DrawerContentProps>(
  ({ className, children, side = 'right', showClose = true, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex flex-col p-6',
          'bg-[hsl(var(--surface))] text-[hsl(var(--foreground))]',
          'border-[hsl(var(--border))] shadow-2xl',
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className={cn(
              'absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md',
              'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
            )}
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DrawerContent.displayName = 'DrawerContent';

export const DrawerHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />
);

export const DrawerFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);

export const DrawerTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold tracking-tight', className)}
    {...props}
  />
));
DrawerTitle.displayName = 'DrawerTitle';

export const DrawerDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-[hsl(var(--muted-foreground))]', className)}
    {...props}
  />
));
DrawerDescription.displayName = 'DrawerDescription';
