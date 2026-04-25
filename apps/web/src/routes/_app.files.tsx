import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Image as ImageIcon,
  MoreHorizontal,
  Music2,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  UploadCloud,
  Video,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '~/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { api } from '~/lib/api';
import { cn } from '~/lib/cn';
import { type Entry, filesQuery, humanSize, humanTime } from '~/lib/files';
import {
  parseUploadErrorMessage,
  toUploadProgress,
  uploadButtonLabel,
} from '~/lib/upload-progress';

type ListedEntry = Entry & { isParentLink?: boolean };
type SortMode = 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc' | 'date-desc' | 'date-asc';

export const Route = createFileRoute('/_app/files')({
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === 'string' ? search.path : '',
  }),
  component: FilesPage,
});

function FilesPage() {
  const PAGE_SIZE = 200;
  const { path } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name-asc');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const [shareTarget, setShareTarget] = useState<{ path: string; name: string } | null>(null);
  const [shareDays, setShareDays] = useState('7');
  const [sharePassword, setSharePassword] = useState('');
  const [shareMaxDownloads, setShareMaxDownloads] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
    percent: number;
  } | null>(null);
  const list = useQuery(filesQuery(path, offset, PAGE_SIZE));
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Reset paging/selection when folder changes.
    void path;
    setOffset(0);
    setSelectedIndex(0);
  }, [path]);

  const entries = useMemo(() => {
    const all = list.data?.entries ?? [];
    const withParent: ListedEntry[] =
      path && !filter.trim()
        ? [
            {
              kind: 'dir',
              name: '..',
              path: parentPath(path),
              itemCount: 0,
              isParentLink: true,
            },
            ...all,
          ]
        : all;
    if (!filter.trim()) return sortEntries(withParent, sortMode);
    const q = filter.toLowerCase();
    return sortEntries(
      withParent.filter((entry) => entry.name.toLowerCase().includes(q)),
      sortMode,
    );
  }, [filter, list.data?.entries, path, sortMode]);

  const previewEntry = useMemo(() => {
    if (!previewPath) return null;
    const found = list.data?.entries.find((item) => item.path === previewPath);
    return found && found.kind === 'file' ? found : null;
  }, [list.data?.entries, previewPath]);

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((n) => Math.min(Math.max(n, 0), entries.length - 1));
  }, [entries.length]);

  // Live updates: invalidate whenever the server broadcasts a change.
  useEffect(() => {
    const es = new EventSource('/api/files/events');
    es.addEventListener('files-changed', () => {
      qc.invalidateQueries({ queryKey: ['files'] });
    });
    return () => es.close();
  }, [qc]);

  const rescan = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.api.files.rescan.post();
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success('Rescan complete');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Rescan failed');
    },
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const target = path ? `${path}/${file.name}` : file.name;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const fd = new FormData();
          fd.append('file', file);
          fd.append('path', target);
          xhr.upload.onprogress = (e) => {
            const next = toUploadProgress(e, i + 1, files.length);
            if (next) setUploadProgress(next);
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(parseUploadErrorMessage(xhr.responseText)));
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.onabort = () => reject(new Error('Upload aborted'));
          xhr.open('POST', '/api/files/upload');
          xhr.send(fd);
        });
      }
    },
    onSuccess: (_data, files) => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success(
        files.length === 1
          ? `Uploaded ${files[0]?.name ?? 'file'}`
          : `Uploaded ${files.length} files`,
      );
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    },
    onSettled: () => setUploadProgress(null),
  });

  const rename = useMutation({
    mutationFn: async ({ path, newPath }: { path: string; newPath: string }) => {
      const { data, error } = await api.api.files.patch({ path, newPath });
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success(`Moved to ${vars.newPath}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Rename failed');
    },
  });

  const createFolderMutation = useMutation({
    mutationFn: async (folderPath: string) => {
      const { data, error } = await api.api.files.folder.post({ path: folderPath });
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: (_data, folderPath) => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success(`Folder created: ${folderPath}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Folder creation failed');
    },
  });

  const createShareMutation = useMutation({
    mutationFn: async (vars: {
      path: string;
      expiresAtMs?: number;
      password?: string;
      maxDownloads?: number;
    }) => {
      const { data, error } = await api.api.shares.post(vars);
      if (error) throw error;
      if ('error' in data) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      setShareUrl(`${window.location.origin}/s/${data.token}`);
      toast.success('Share link created');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Share creation failed');
    },
  });

  function openPicker() {
    inputRef.current?.click();
  }

  function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.currentTarget.files ?? []);
    if (files.length > 0) upload.mutate(files);
    e.currentTarget.value = '';
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragActive(true);
  }
  function onDragLeave() {
    setDragActive(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) upload.mutate(files);
  }

  useEffect(() => {
    function onGridKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (entries.length === 0) {
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((n) => Math.min(n + 1, entries.length - 1));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((n) => Math.max(n - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = entries[selectedIndex];
        if (!selected) return;
        if (selected.kind === 'dir') {
          navigate({ to: '/files', search: { path: selected.path } });
        } else {
          setPreviewPath(selected.path);
        }
      }
    }

    window.addEventListener('keydown', onGridKeyDown);
    return () => {
      window.removeEventListener('keydown', onGridKeyDown);
    };
  }, [entries, navigate, selectedIndex]);

  function toTargetPath(currentPath: string, rawInput: string): string {
    const trimmed = rawInput.trim().replace(/^\/+/, '');
    if (trimmed.includes('/')) return trimmed;
    const idx = currentPath.lastIndexOf('/');
    const parent = idx === -1 ? '' : currentPath.slice(0, idx);
    return parent ? `${parent}/${trimmed}` : trimmed;
  }

  function toCreateFolderPath(currentPath: string, rawInput: string): string {
    const trimmed = rawInput.trim().replace(/^\/+/, '');
    if (trimmed.includes('/')) return trimmed;
    return currentPath ? `${currentPath}/${trimmed}` : trimmed;
  }

  async function onRename(path: string) {
    const currentName = path.split('/').at(-1) ?? path;
    setRenameTarget({ path, name: currentName });
    setRenameInput(currentName);
  }

  async function submitRename() {
    if (!renameTarget) return;
    if (!renameInput.trim()) return;
    const newPath = toTargetPath(renameTarget.path, renameInput);
    await rename.mutateAsync({ path: renameTarget.path, newPath });
    setRenameTarget(null);
    setRenameInput('');
  }

  async function submitCreateFolder() {
    if (!folderInput.trim()) return;
    const folderPath = toCreateFolderPath(path, folderInput);
    await createFolderMutation.mutateAsync(folderPath);
    setCreateFolderOpen(false);
    setFolderInput('');
  }

  async function submitCreateShare() {
    if (!shareTarget) return;
    const days = Number.parseInt(shareDays, 10);
    const maxDownloads = Number.parseInt(shareMaxDownloads, 10);
    const expiresAtMs =
      Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : undefined;
    const payload: {
      path: string;
      expiresAtMs?: number;
      password?: string;
      maxDownloads?: number;
    } = {
      path: shareTarget.path,
    };
    if (expiresAtMs != null) payload.expiresAtMs = expiresAtMs;
    if (sharePassword.trim()) payload.password = sharePassword;
    if (Number.isFinite(maxDownloads) && maxDownloads > 0) {
      payload.maxDownloads = Math.trunc(maxDownloads);
    }
    await createShareMutation.mutateAsync(payload);
  }

  const isEmpty = !list.isLoading && list.data?.entries.length === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: page-wide drop zone; overlay is announced separately
    <div
      className="relative mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6 lg:px-8"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
          <Breadcrumb path={path} />
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => rescan.mutate()}
                loading={rescan.isPending}
                aria-label="Rescan folder"
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rescan — picks up files added via SSH / rsync</TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            leftIcon={<FolderPlus />}
            onClick={() => setCreateFolderOpen(true)}
          >
            New folder
          </Button>
          <Button
            leftIcon={<UploadCloud />}
            onClick={openPicker}
            loading={upload.isPending && !uploadProgress}
          >
            {uploadButtonLabel(uploadProgress)}
          </Button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={onPicked} />
        </div>
      </header>

      <section
        className={cn(
          'overflow-hidden rounded-xl border bg-[hsl(var(--surface))] transition-colors',
          dragActive
            ? 'border-[hsl(var(--primary))] ring-4 ring-[hsl(var(--primary)/0.15)]'
            : 'border-[hsl(var(--border))]',
        )}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] px-3 py-2">
          <div className="flex items-center gap-2">
            <Input
              ref={searchRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter in current folder (/)"
              leftIcon={<Search />}
              className="max-w-sm"
            />
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                <SelectItem value="date-desc">Date (newest)</SelectItem>
                <SelectItem value="date-asc">Date (oldest)</SelectItem>
                <SelectItem value="size-desc">Size (largest)</SelectItem>
                <SelectItem value="size-asc">Size (smallest)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {list.data && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {list.data.total} total
              {filter ? ` · ${entries.length} shown` : ''}
            </p>
          )}
        </div>
        {list.isLoading && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        )}
        {list.isError && (
          <p className="p-6 text-sm text-[hsl(var(--destructive))]">
            {String((list.error as Error)?.message ?? list.error)}
          </p>
        )}
        {isEmpty && (
          <EmptyState
            onUpload={openPicker}
            onCreateFolder={() => setCreateFolderOpen(true)}
            rootLevel={!path}
          />
        )}
        {entries.length > 0 && (
          <DragDropProvider
            onDragEnd={(event) => {
              if (event.canceled) return;
              const source = parseDndId(event.operation?.source?.id);
              const target = parseDndId(event.operation?.target?.id);
              if (!source || !target) return;
              if (source.kind !== 'file' || target.kind !== 'dir') return;
              const fileName = source.path.split('/').at(-1) ?? source.path;
              const newPath = target.path ? `${target.path}/${fileName}` : fileName;
              if (newPath === source.path) return;
              void rename.mutateAsync({ path: source.path, newPath });
            }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] text-left text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                    <Th className="w-full">Name</Th>
                    <Th>Size</Th>
                    <Th>Modified</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => (
                    <EntryRow
                      key={entry.path}
                      entry={entry}
                      selected={i === selectedIndex}
                      onNavigate={(p) => navigate({ to: '/files', search: { path: p } })}
                      onPreview={setPreviewPath}
                      onRename={onRename}
                      onShare={(filePath) => {
                        const name = filePath.split('/').at(-1) ?? filePath;
                        setShareTarget({ path: filePath, name });
                        setShareDays('7');
                        setSharePassword('');
                        setShareMaxDownloads('');
                        setShareUrl(null);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </DragDropProvider>
        )}
        {!list.isLoading && !isEmpty && entries.length === 0 && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">
            No files match your filter.
          </p>
        )}
      </section>

      {list.data && !filter && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset((n) => Math.max(n - PAGE_SIZE, 0))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!list.data.hasMore}
            onClick={() => setOffset((n) => n + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      )}

      {dragActive && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[hsl(var(--background)/0.75)] backdrop-blur-sm"
        >
          <div className="rounded-2xl border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--surface))] px-10 py-8 text-center shadow-2xl">
            <UploadCloud className="mx-auto size-10 text-[hsl(var(--primary))]" aria-hidden />
            <p className="mt-3 text-lg font-semibold">Drop to upload</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Files will land in <code className="font-mono">/{path || '(root)'}</code>
            </p>
          </div>
        </div>
      )}

      <FilePreviewModal
        path={previewPath}
        entry={previewEntry}
        onOpenChange={(open) => {
          if (!open) setPreviewPath(null);
        }}
      />

      <Modal
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameInput('');
          }
        }}
      >
        <ModalContent size="sm" className="w-full max-w-md overflow-x-hidden">
          <ModalHeader>
            <ModalTitle>Rename or move file</ModalTitle>
            <ModalDescription>
              Enter a new name or path relative to your data root.
            </ModalDescription>
          </ModalHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitRename();
            }}
          >
            <Input
              autoFocus
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder="new-name.txt or folder/new-name.txt"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameInput('');
                }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={rename.isPending}>
                Save
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>

      <Modal
        open={createFolderOpen}
        onOpenChange={(open) => {
          setCreateFolderOpen(open);
          if (!open) setFolderInput('');
        }}
      >
        <ModalContent size="sm">
          <ModalHeader>
            <ModalTitle>Create folder</ModalTitle>
            <ModalDescription>Creates a folder in the current location.</ModalDescription>
          </ModalHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreateFolder();
            }}
          >
            <Input
              autoFocus
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              placeholder="new-folder or nested/path"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateFolderOpen(false);
                  setFolderInput('');
                }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={createFolderMutation.isPending}>
                Create
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>

      <Modal
        open={Boolean(shareTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setShareTarget(null);
            setShareUrl(null);
            setSharePassword('');
            setShareMaxDownloads('');
          }
        }}
      >
        <ModalContent size="sm">
          <ModalHeader>
            <ModalTitle>Share file</ModalTitle>
            <ModalDescription>
              Create a public link for <strong>{shareTarget?.name ?? ''}</strong>.
            </ModalDescription>
          </ModalHeader>
          <form
            className="w-full min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreateShare();
            }}
          >
            <div className="w-full min-w-0 space-y-1">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Expires in (days)</p>
              <Input
                value={shareDays}
                onChange={(e) => setShareDays(e.target.value)}
                placeholder="7"
              />
            </div>
            <div className="w-full min-w-0 space-y-1">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Password (optional)</p>
              <Input
                type="password"
                value={sharePassword}
                onChange={(e) => setSharePassword(e.target.value)}
                placeholder="Optional password"
              />
            </div>
            <div className="w-full min-w-0 space-y-1">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Max downloads (optional)
              </p>
              <Input
                value={shareMaxDownloads}
                onChange={(e) => setShareMaxDownloads(e.target.value)}
                placeholder="Unlimited"
              />
            </div>
            {shareUrl && (
              <div className="flex flex-col items-center gap-3">
                <div className="w-full min-w-0 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-2">
                  <p className="break-all text-xs text-[hsl(var(--muted-foreground))]">
                    {shareUrl}
                  </p>
                </div>
                <div className="rounded-lg border border-[hsl(var(--border))] bg-white p-3">
                  <QRCodeSVG value={shareUrl} size={160} />
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {shareUrl && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    const copied = await copyText(shareUrl);
                    if (copied) {
                      toast.success('Share link copied');
                    } else {
                      toast.error('Failed to copy share link');
                    }
                  }}
                >
                  Copy link
                </Button>
              )}
              <Button type="submit" loading={createShareMutation.isPending}>
                Create link
              </Button>
            </div>
          </form>
        </ModalContent>
      </Modal>
    </div>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))]"
    >
      <Link
        to="/files"
        search={{ path: '' }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
      >
        <Home className="size-3.5" /> Root
      </Link>
      {parts.map((segment, i) => {
        const sub = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-[hsl(var(--muted-foreground))]" />
            {isLast ? (
              <span className="truncate font-medium text-[hsl(var(--foreground))]">{segment}</span>
            ) : (
              <Link
                to="/files"
                search={{ path: sub }}
                className="truncate rounded-md px-1.5 py-0.5 hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-semibold ${className ?? ''}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>;
}

function EntryRow({
  entry,
  onNavigate,
  onPreview,
  onRename,
  onShare,
  selected,
}: {
  entry: ListedEntry;
  onNavigate: (path: string) => void;
  onPreview: (path: string) => void;
  onRename: (path: string) => Promise<void>;
  onShare: (path: string) => void;
  selected: boolean;
}) {
  if (entry.kind === 'dir') {
    return <DirectoryRow entry={entry} selected={selected} onNavigate={onNavigate} />;
  }

  return (
    <FileRow
      entry={entry}
      selected={selected}
      onPreview={onPreview}
      onRename={onRename}
      onShare={onShare}
    />
  );
}

function DirectoryRow({
  entry,
  selected,
  onNavigate,
}: {
  entry: Extract<ListedEntry, { kind: 'dir' }>;
  selected: boolean;
  onNavigate: (path: string) => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.files.folder.delete({ path: entry.path });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success(`Deleted ${entry.name}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    },
  });
  const droppableId = dndId('dir', entry.path);
  const { ref: dropRef, isDropTarget } = useDroppable({ id: droppableId });
  return (
    <tr
      ref={dropRef}
      className={cn(
        'cursor-pointer border-b border-[hsl(var(--border))] transition-colors hover:bg-[hsl(var(--muted)/0.3)]',
        selected && 'bg-[hsl(var(--primary)/0.08)]',
        isDropTarget && 'bg-[hsl(var(--primary)/0.15)]',
      )}
      onClick={() => onNavigate(entry.path)}
    >
      <Td>
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))]">
            <Folder className="size-4" />
          </div>
          <span className="truncate font-medium">{entry.isParentLink ? '..' : entry.name}</span>
        </div>
      </Td>
      <Td className="whitespace-nowrap text-[hsl(var(--muted-foreground))]">
        {entry.isParentLink ? <Badge>Parent folder</Badge> : <Badge>{entry.itemCount} items</Badge>}
      </Td>
      <Td className="whitespace-nowrap text-[hsl(var(--muted-foreground))]">—</Td>
      <Td className="text-right">
        {entry.isParentLink ? (
          <Button variant="ghost" size="icon-sm" aria-label="Open folder">
            <ChevronRight />
          </Button>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open folder"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(entry.path);
              }}
            >
              <ChevronRight />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${entry.name}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <ConfirmDialog
                  trigger={
                    <DropdownMenuItem destructive onSelect={(e) => e.preventDefault()}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  }
                  title={`Delete "${entry.name}"?`}
                  description="The folder and all its contents will be permanently removed. This cannot be undone."
                  confirmLabel="Delete"
                  tone="destructive"
                  onConfirm={() => del.mutateAsync()}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </Td>
    </tr>
  );
}

function FileRow({
  entry,
  selected,
  onPreview,
  onRename,
  onShare,
}: {
  entry: Extract<Entry, { kind: 'file' }>;
  selected: boolean;
  onPreview: (path: string) => void;
  onRename: (path: string) => Promise<void>;
  onShare: (path: string) => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.files.delete({ path: entry.path });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      toast.success(`Deleted ${entry.name}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    },
  });
  const draggableId = dndId('file', entry.path);
  const { ref: dragRef, isDragging } = useDraggable({ id: draggableId });
  const downloadHref = `/api/files/content?path=${encodeURIComponent(entry.path)}`;
  const isThumbnailable = entry.mime.startsWith('image/') || entry.mime === 'application/pdf';
  const regenThumb = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/files/thumbnail?path=${encodeURIComponent(entry.path)}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to regenerate thumbnail');
    },
    onSuccess: () => toast.success('Thumbnail regenerated'),
    onError: () => toast.error('Could not regenerate thumbnail'),
  });
  return (
    <tr
      ref={dragRef}
      className={cn(
        'border-b border-[hsl(var(--border))] last:border-b-0 transition-colors hover:bg-[hsl(var(--muted)/0.3)]',
        selected && 'bg-[hsl(var(--primary)/0.08)]',
        isDragging && 'opacity-50',
      )}
      onDoubleClick={() => onPreview(entry.path)}
    >
      <Td>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
            {entry.mime.startsWith('image/') || entry.mime === 'application/pdf' ? (
              <img
                src={`/api/files/thumbnail?path=${encodeURIComponent(entry.path)}`}
                alt=""
                loading="lazy"
                className="size-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              iconFor(entry.mime, entry.name)
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{entry.name}</p>
            <p className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
              {displayMimeLabel(entry.mime, entry.name)}
            </p>
          </div>
        </div>
      </Td>
      <Td className="whitespace-nowrap text-[hsl(var(--muted-foreground))]">
        {humanSize(entry.size)}
      </Td>
      <Td className="whitespace-nowrap text-[hsl(var(--muted-foreground))]">
        {humanTime(entry.mtimeMs)}
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={downloadHref}
                download={entry.name}
                className="inline-flex size-8 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
                aria-label={`Download ${entry.name}`}
              >
                <Download className="size-4" />
              </a>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${entry.name}`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                onClick={async () => {
                  const copied = await copyText(entry.path);
                  if (copied) {
                    toast.success('Path copied');
                  } else {
                    toast.error('Failed to copy path');
                  }
                }}
              >
                <Copy /> Copy path
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                onClick={() => onShare(entry.path)}
              >
                <Share2 /> Share
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                onClick={() => {
                  void onRename(entry.path);
                }}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              {isThumbnailable && (
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  onClick={() => regenThumb.mutate()}
                  disabled={regenThumb.isPending}
                >
                  <RefreshCw /> Regenerate thumbnail
                </DropdownMenuItem>
              )}
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem destructive onSelect={(e) => e.preventDefault()}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                }
                title={`Delete ${entry.name}?`}
                description="The file is removed from disk. This cannot be undone."
                confirmLabel="Delete"
                tone="destructive"
                onConfirm={() => del.mutateAsync()}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Td>
    </tr>
  );
}

function sortEntries(items: ListedEntry[], mode: SortMode): ListedEntry[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => {
    if (a.isParentLink) return -1;
    if (b.isParentLink) return 1;
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;

    if (mode === 'name-asc') return collator.compare(a.name, b.name);
    if (mode === 'name-desc') return collator.compare(b.name, a.name);

    if (a.kind === 'dir' && b.kind === 'dir') {
      return collator.compare(a.name, b.name);
    }
    if (a.kind === 'dir') return -1;
    if (b.kind === 'dir') return 1;

    if (mode === 'size-desc') return b.size - a.size;
    if (mode === 'size-asc') return a.size - b.size;
    if (mode === 'date-desc') return b.mtimeMs - a.mtimeMs;
    if (mode === 'date-asc') return a.mtimeMs - b.mtimeMs;
    return collator.compare(a.name, b.name);
  });
}

function isExternalFileDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes('Files');
}

function dndId(kind: 'file' | 'dir', path: string) {
  return `${kind}:${path}`;
}

function parseDndId(id: string | number | symbol | null | undefined) {
  if (typeof id !== 'string') return null;
  const sep = id.indexOf(':');
  if (sep <= 0) return null;
  return {
    kind: id.slice(0, sep),
    path: id.slice(sep + 1),
  };
}

function parentPath(path: string) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to legacy copy flow.
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function FilePreviewModal({
  path,
  entry,
  onOpenChange,
}: {
  path: string | null;
  entry: Extract<Entry, { kind: 'file' }> | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [textPreview, setTextPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) {
      setTextPreview(null);
      return;
    }
    if (!entry.mime.startsWith('text/') && entry.mime !== 'application/json') {
      setTextPreview(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/files/content?path=${encodeURIComponent(entry.path)}`)
      .then((res) => res.text())
      .then((text) => {
        if (cancelled) return;
        setTextPreview(text.slice(0, 200_000));
      })
      .catch(() => {
        if (cancelled) return;
        setTextPreview('(Failed to load preview)');
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const open = Boolean(path && entry);
  const src = entry ? `/api/files/content?path=${encodeURIComponent(entry.path)}` : '';

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="xl" className="max-h-[90vh] overflow-hidden">
        <ModalHeader>
          <ModalTitle>{entry?.name ?? 'Preview'}</ModalTitle>
          <ModalDescription>{entry?.mime ?? ''}</ModalDescription>
        </ModalHeader>
        {!entry && null}
        {entry?.mime.startsWith('image/') && (
          <div className="overflow-auto rounded-lg border border-[hsl(var(--border))]">
            <img src={src} alt={entry.name} className="mx-auto max-h-[70vh] object-contain" />
          </div>
        )}
        {entry?.mime === 'application/pdf' && (
          <iframe
            title={entry.name}
            src={src}
            className="h-[70vh] w-full rounded-lg border border-[hsl(var(--border))]"
          />
        )}
        {entry?.mime.startsWith('video/') && (
          <>
            {/* biome-ignore lint/a11y/useMediaCaption: arbitrary uploaded videos do not have caption tracks */}
            <video
              src={src}
              controls
              className="h-[70vh] w-full rounded-lg border border-[hsl(var(--border))] bg-black"
            />
          </>
        )}
        {(entry?.mime.startsWith('text/') || entry?.mime === 'application/json') && (
          <pre className="max-h-[70vh] overflow-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-4 text-xs">
            {textPreview ?? 'Loading preview...'}
          </pre>
        )}
        {entry &&
          !entry.mime.startsWith('image/') &&
          entry.mime !== 'application/pdf' &&
          !entry.mime.startsWith('video/') &&
          !entry.mime.startsWith('text/') &&
          entry.mime !== 'application/json' && (
            <p className="rounded-lg border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--muted-foreground))]">
              No inline preview for this file type yet. Use Download to open it locally.
            </p>
          )}
      </ModalContent>
    </Modal>
  );
}

function iconFor(mime: string, name: string) {
  if (mime.startsWith('image/')) return <ImageIcon className="size-4" />;
  if (mime.startsWith('video/')) return <Video className="size-4" />;
  if (mime.startsWith('audio/')) return <Music2 className="size-4" />;
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/pdf')
    return <FileText className="size-4" />;
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
  if (ext) return <span className="text-[9px] font-bold leading-none tracking-wide">{ext}</span>;
  return <FileIcon className="size-4" />;
}

const KNOWN_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/toml',
  'text/html',
  'text/css',
  'text/javascript',
  'text/typescript',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/heic',
  'audio/mpeg',
  'audio/wav',
  'audio/flac',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/octet-stream',
]);

function displayMimeLabel(mime: string, name: string) {
  if (preferExtensionLabel(mime)) {
    const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
    if (ext) return ext;
  }
  if (KNOWN_MIME_TYPES.has(mime)) return mime;
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
  return ext || mime;
}

function preferExtensionLabel(mime: string) {
  return mime.startsWith('application/vnd.') || mime.startsWith('application/x-');
}

function EmptyState({
  onUpload,
  onCreateFolder,
  rootLevel,
}: {
  onUpload: () => void;
  onCreateFolder: () => void;
  rootLevel: boolean;
}) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
        <UploadCloud className="size-5" />
      </div>
      <p className="mt-4 text-sm font-medium">
        {rootLevel ? 'No files yet' : 'This folder is empty'}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">
        Drop files anywhere on this page, upload from your computer, or drop them in the data folder
        on disk — they'll appear here.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button variant="outline" onClick={onCreateFolder} leftIcon={<FolderPlus />}>
          Create folder
        </Button>
        <Button onClick={onUpload} leftIcon={<UploadCloud />}>
          Upload a file
        </Button>
      </div>
    </div>
  );
}
