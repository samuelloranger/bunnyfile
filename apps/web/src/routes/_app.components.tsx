import { createFileRoute } from '@tanstack/react-router';
import {
  Copy,
  Download,
  Folder,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  User,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '~/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Kbd } from '~/components/ui/kbd';
import { Label } from '~/components/ui/label';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '~/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';

export const Route = createFileRoute('/_app/components')({
  component: ComponentsPage,
});

function ComponentsPage() {
  const [visibility, setVisibility] = useState<string>('public');

  return (
    <div className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Design system
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Components</h1>
        <p className="max-w-2xl text-sm text-[hsl(var(--muted-foreground))]">
          The BunnyFile base library — Radix UI primitives wrapped in Tailwind v4 design tokens.
        </p>
      </header>

      <Section title="Buttons" description="Variants, sizes, loading and icon-only states.">
        <div className="flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="accent">Accent</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link button</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add">
            <Plus />
          </Button>
          <Button loading>Saving…</Button>
          <Button leftIcon={<Download />}>Download</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Inputs" description="Text input with optional icons and invalid state.">
        <div className="grid max-w-xl gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="demo-search">Search</Label>
            <Input
              id="demo-search"
              placeholder="Search anything…"
              leftIcon={<Search />}
              rightIcon={<Kbd>⌘K</Kbd>}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-email">Email</Label>
            <Input id="demo-email" type="email" placeholder="you@example.com" leftIcon={<Mail />} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-invalid">Invalid</Label>
            <Input id="demo-invalid" defaultValue="not-an-email" invalid />
            <p className="text-xs text-[hsl(var(--destructive))]">Please enter a valid email.</p>
          </div>
        </div>
      </Section>

      <Section title="Select" description="Radix Select, fully keyboard accessible.">
        <div className="max-w-xs space-y-1.5">
          <Label>Link visibility</Label>
          <Select value={visibility} onValueChange={setVisibility}>
            <SelectTrigger>
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public — anyone with the link</SelectItem>
              <SelectItem value="password">Password protected</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Dropdown menu" description="Context actions, shortcuts, destructive items.">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" rightIcon={<MoreHorizontal />}>
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem>
              <Pencil /> Rename
              <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Share2 /> Share
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy /> Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive>
              <Trash2 /> Delete
              <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section title="Avatar" description="Image with text fallback.">
        <div className="flex items-center gap-4">
          <Avatar size="sm">
            <AvatarImage src="https://api.dicebear.com/9.x/notionists/svg?seed=sam" alt="" />
            <AvatarFallback>SL</AvatarFallback>
          </Avatar>
          <Avatar size="md">
            <AvatarImage src="https://api.dicebear.com/9.x/notionists/svg?seed=ana" alt="" />
            <AvatarFallback>AN</AvatarFallback>
          </Avatar>
          <Avatar size="lg">
            <AvatarFallback>
              <User className="size-5" />
            </AvatarFallback>
          </Avatar>
          <Avatar size="xl">
            <AvatarFallback>🐰</AvatarFallback>
          </Avatar>
        </div>
      </Section>

      <Section title="Tooltip" description="Delayed, accessible, follows Radix conventions.">
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="New folder">
                <Folder />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Share">
                <Share2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Share a link</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      <Section title="Badges" description="Semantic pill labels.">
        <div className="flex flex-wrap gap-2">
          <Badge>neutral</Badge>
          <Badge variant="primary">primary</Badge>
          <Badge variant="accent">accent</Badge>
          <Badge variant="success">success</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="destructive">destructive</Badge>
          <Badge variant="outline">outline</Badge>
        </div>
      </Section>

      <Separator />

      <Section title="Modal" description="Dialog for structured forms and flows.">
        <Modal>
          <ModalTrigger asChild>
            <Button>Create folder</Button>
          </ModalTrigger>
          <ModalContent>
            <ModalHeader>
              <ModalTitle>Create new folder</ModalTitle>
              <ModalDescription>
                Organize your files by creating a folder in the current directory.
              </ModalDescription>
            </ModalHeader>
            <div className="space-y-2">
              <Label htmlFor="folder-name">Folder name</Label>
              <Input id="folder-name" placeholder="My new folder" leftIcon={<Folder />} />
            </div>
            <ModalFooter>
              <ModalClose asChild>
                <Button variant="outline">Cancel</Button>
              </ModalClose>
              <Button>Create</Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </Section>

      <Section
        title="Confirm dialog"
        description="Pre-built destructive confirmation with loading state."
      >
        <div className="flex gap-3">
          <ConfirmDialog
            trigger={<Button variant="outline">Unshare file</Button>}
            title="Stop sharing this file?"
            description="People with the link will immediately lose access."
            confirmLabel="Stop sharing"
            onConfirm={() => new Promise((r) => setTimeout(r, 800))}
          />
          <ConfirmDialog
            trigger={
              <Button variant="destructive" leftIcon={<Trash2 />}>
                Delete file
              </Button>
            }
            title="Delete this file?"
            description="This action cannot be undone. The file will be permanently removed."
            confirmLabel="Delete"
            tone="destructive"
            onConfirm={() => new Promise((r) => setTimeout(r, 800))}
          />
        </div>
      </Section>

      <Section
        title="Drawer"
        description="Side panel for file details, settings, or upload queues."
      >
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="secondary">Open details</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>File details</DrawerTitle>
              <DrawerDescription>quarterly-report.pdf</DrawerDescription>
            </DrawerHeader>
            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Size" value="2.4 MB" />
              <Row label="Uploaded" value="2 hours ago" />
              <Row label="Owner" value="Samuel Loranger" />
              <Row label="Shared with" value={<Badge variant="primary">3 people</Badge>} />
            </dl>
            <DrawerFooter>
              <Button variant="outline" leftIcon={<Download />}>
                Download
              </Button>
              <Button leftIcon={<Share2 />}>Share</Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Section>

      <Section title="Color tokens" description="Semantic CSS vars, light and dark.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {[
            { token: 'primary', label: 'Primary' },
            { token: 'secondary', label: 'Secondary' },
            { token: 'accent', label: 'Accent' },
            { token: 'muted', label: 'Muted' },
            { token: 'destructive', label: 'Destructive' },
            { token: 'success', label: 'Success' },
            { token: 'warning', label: 'Warning' },
            { token: 'surface', label: 'Surface' },
            { token: 'surface-2', label: 'Surface 2' },
            { token: 'background', label: 'Background' },
            { token: 'foreground', label: 'Foreground' },
            { token: 'border', label: 'Border' },
          ].map((c) => (
            <div
              key={c.token}
              className="overflow-hidden rounded-lg border border-[hsl(var(--border))]"
            >
              <div className="h-14 w-full" style={{ backgroundColor: `hsl(var(--${c.token}))` }} />
              <div className="px-3 py-2">
                <p className="text-xs font-medium">{c.label}</p>
                <p className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                  --{c.token}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-5">
        {children}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[hsl(var(--muted-foreground))]">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
