import type { ReactNode } from 'react';
import { useState } from 'react';
import { Drawer, DrawerContent } from '~/components/ui/drawer';
import { TooltipProvider } from '~/components/ui/tooltip';
import { UploadTriggerProvider } from '~/lib/upload-trigger';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={180}>
      <UploadTriggerProvider>
        <div className="flex h-dvh w-full bg-[hsl(var(--background))] relative overflow-hidden">
          {/* Desktop sidebar */}
          <div className="hidden w-64 shrink-0 md:block z-10">
            <Sidebar />
          </div>

          {/* Mobile sidebar as a left drawer */}
          <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
            <DrawerContent side="left" showClose className="w-72 !p-0">
              <Sidebar className="border-r-0" />
            </DrawerContent>
          </Drawer>

          <div className="flex min-w-0 flex-1 flex-col z-10">
            <Topbar onMenuClick={() => setMobileOpen(true)} />
            <main className="flex-1 overflow-y-auto bg-transparent relative z-0">{children}</main>
          </div>

          {/* Ambient background glow matching the brand colors */}
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-0 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--primary)/0.06),transparent_50%),radial-gradient(ellipse_at_bottom_left,hsl(var(--accent)/0.03),transparent_50%)]"
          />
        </div>
      </UploadTriggerProvider>
    </TooltipProvider>
  );
}
