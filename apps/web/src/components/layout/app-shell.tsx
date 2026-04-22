import type { ReactNode } from 'react';
import { useState } from 'react';
import { Drawer, DrawerContent } from '~/components/ui/drawer';
import { TooltipProvider } from '~/components/ui/tooltip';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={180}>
      <div className="flex h-dvh w-full bg-[hsl(var(--background))]">
        {/* Desktop sidebar */}
        <div className="hidden w-64 shrink-0 md:block">
          <Sidebar />
        </div>

        {/* Mobile sidebar as a left drawer */}
        <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
          <DrawerContent side="left" showClose className="w-72 !p-0">
            <Sidebar className="border-r-0" />
          </DrawerContent>
        </Drawer>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenuClick={() => setMobileOpen(true)} />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
