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
  LayoutGrid,
  List,
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
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { FilePreviewModal } from '~/components/ui/file-preview-modal';
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
import {
  type Entry,
  type FileEntry,
  filesQuery,
  filesSearchQuery,
  humanSize,
  humanTime,
} from '~/lib/files';
import {
  buildFilesSearch,
  type FilesSearchMode,
  parseFilesSearch,
  resolveFilesSearch,
  shouldUseGlobalSearch,
} from '~/lib/files-search';
import { pushNotification } from '~/lib/notifications';
import {
  parseUploadErrorMessage,
  toUploadProgress,
  uploadButtonLabel,
} from '~/lib/upload-progress';
import { useUploadTrigger } from '~/lib/upload-trigger';

type ListedEntry = Entry & { isParentLink?: boolean };
type SortMode = 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc' | 'date-desc' | 'date-asc';

export const Route = createFileRoute('/_app/files')({
  validateSearch: parseFilesSearch,
  component: FilesPage,
});

// Debounce a value so rapid changes (e.g. per-keystroke search input) don't
// fire a request on every change.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function FilesPage() {
  const PAGE_SIZE = 200;
  const { path, q, mode, upload: uploadTrigger } = resolveFilesSearch(Route.useSearch());
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
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
  const globalQuery = shouldUseGlobalSearch(mode, q) ? q.trim() : '';
  // Debounce the value sent to the server search so typing doesn't storm the API.
  const debouncedGlobalQuery = useDebounced(globalQuery, 250);
  const globalSearch = useQuery(filesSearchQuery(debouncedGlobalQuery));
  const folderFilter = mode === 'folder' ? q.trim().toLowerCase() : '';
  const isGlobalSearch = Boolean(globalQuery);
  const allModePrompt = mode === 'all' && !globalQuery;
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Reset paging/selection when folder or search mode changes.
    void path;
    void mode;
    void q;
    setOffset(0);
    setSelectedIndex(0);
  }, [path, mode, q]);

  useEffect(() => {
    if (q) searchRef.current?.focus();
  }, [q]);

  const entries = useMemo(() => {
    if (globalQuery) {
      return (globalSearch.data?.entries ?? []).map(
        (hit): ListedEntry => ({
          kind: 'file',
          name: hit.name,
          path: hit.path,
          size: hit.size,
          mime: hit.mime,
          mtimeMs: hit.mtimeMs,
          sha256: null,
        }),
      );
    }
    if (mode === 'all') return [];
    const all = list.data?.entries ?? [];
    const withParent: ListedEntry[] =
      path && !folderFilter
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
    if (!folderFilter) return sortEntries(withParent, sortMode);
    return sortEntries(
      withParent.filter((entry) => entry.name.toLowerCase().includes(folderFilter)),
      sortMode,
    );
  }, [
    folderFilter,
    globalQuery,
    globalSearch.data?.entries,
    list.data?.entries,
    mode,
    path,
    sortMode,
  ]);

  const previewEntry = useMemo((): FileEntry | null => {
    if (!previewPath) return null;
    const found = entries.find((item) => item.path === previewPath);
    return found?.kind === 'file' ? found : null;
  }, [entries, previewPath]);

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
      qc.invalidateQueries({ queryKey: ['files-search'] });
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
      qc.invalidateQueries({ queryKey: ['files-search'] });
      pushNotification({ kind: 'success', title: 'Rescan complete' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Rescan failed',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // Upload each file independently: one failure must not abort the rest of
      // the batch. Collect failures and surface them together at the end.
      const failures: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const target = path ? `${path}/${file.name}` : file.name;
        try {
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
        } catch (err) {
          failures.push(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} of ${files.length} upload(s) failed:\n${failures.join('\n')}`,
        );
      }
    },
    onSuccess: (_data, files) => {
      pushNotification({
        kind: 'success',
        title:
          files.length === 1
            ? `Uploaded ${files[0]?.name ?? 'file'}`
            : `Uploaded ${files.length} files`,
      });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Upload failed',
        body: err instanceof Error ? err.message : undefined,
      });
    },
    // Some files may have uploaded even if others failed — refresh either way.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['files-search'] });
      setUploadProgress(null);
    },
  });

  const rename = useMutation({
    mutationFn: async ({ path, newPath }: { path: string; newPath: string }) => {
      const { data, error } = await api.api.files.patch({ path, newPath });
      if (error) throw error;
      if (data && 'error' in data) throw new Error(data.error);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['files-search'] });
      pushNotification({ kind: 'success', title: `Moved to ${vars.newPath}` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Rename failed',
        body: err instanceof Error ? err.message : undefined,
      });
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
      qc.invalidateQueries({ queryKey: ['files-search'] });
      pushNotification({ kind: 'success', title: `Folder created: ${folderPath}` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Folder creation failed',
        body: err instanceof Error ? err.message : undefined,
      });
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
      pushNotification({ kind: 'success', title: 'Share link created' });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: 'Share creation failed',
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const { registerOpener } = useUploadTrigger();
  useEffect(() => registerOpener(openPicker), [registerOpener, openPicker]);

  useEffect(() => {
    if (!uploadTrigger) return;
    inputRef.current?.click();
    navigate({
      to: '/files',
      search: buildFilesSearch({ path, q, mode, upload: false }),
      replace: true,
    });
  }, [uploadTrigger, path, q, mode, navigate]);

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
      // Don't drive grid navigation from inside an open modal/dialog (e.g.
      // Enter on a dialog button shouldn't also open a preview behind it).
      if (target.closest('[role="dialog"]')) {
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
          navigate({ to: '/files', search: buildFilesSearch({ path: selected.path, q, mode }) });
        } else {
          setPreviewPath(selected.path);
        }
      }
    }

    window.addEventListener('keydown', onGridKeyDown);
    return () => {
      window.removeEventListener('keydown', onGridKeyDown);
    };
  }, [entries, navigate, selectedIndex, q, mode]);

  // Names are always interpreted relative to the current folder, even when they
  // contain a `/` (e.g. renaming to `archive/old.txt` inside `docs/work` →
  // `docs/work/archive/old.txt`), so input never silently jumps to the root.
  function toTargetPath(currentPath: string, rawInput: string): string {
    const trimmed = rawInput.trim().replace(/^\/+/, '');
    const idx = currentPath.lastIndexOf('/');
    const parent = idx === -1 ? '' : currentPath.slice(0, idx);
    return parent ? `${parent}/${trimmed}` : trimmed;
  }

  function toCreateFolderPath(currentPath: string, rawInput: string): string {
    const trimmed = rawInput.trim().replace(/^\/+/, '');
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

  const isEmpty =
    !isGlobalSearch &&
    !allModePrompt &&
    !folderFilter &&
    !list.isLoading &&
    list.data?.entries.length === 0;

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
          <Breadcrumb path={path} q={q} mode={mode} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-0.5 mr-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setViewMode('grid')}
              className={cn(
                'size-8 !p-0 rounded-md transition-all duration-150',
                viewMode === 'grid'
                  ? 'bg-[hsl(var(--surface))] shadow-sm text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
              )}
              aria-label="Grid view"
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setViewMode('list')}
              className={cn(
                'size-8 !p-0 rounded-md transition-all duration-150',
                viewMode === 'list'
                  ? 'bg-[hsl(var(--surface))] shadow-sm text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
              )}
              aria-label="List view"
            >
              <List className="size-4" />
            </Button>
          </div>
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
          'overflow-hidden rounded-2xl border bg-[hsl(var(--surface)/0.4)] backdrop-blur-md transition-all duration-300',
          dragActive
            ? 'border-[hsl(var(--primary))] ring-4 ring-[hsl(var(--primary)/0.15)] bg-[hsl(var(--surface)/0.65)]'
            : 'border-[hsl(var(--border)/0.5)] shadow-md shadow-black/5 hover:shadow-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border)/0.5)] bg-[hsl(var(--surface-2)/0.3)] px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) =>
                navigate({
                  to: '/files',
                  search: buildFilesSearch({ path, q: e.target.value, mode }),
                  replace: true,
                })
              }
              placeholder={
                mode === 'all' ? 'Search all files (2+ characters)' : 'Filter current folder'
              }
              leftIcon={<Search />}
              className="max-w-sm"
            />
            <Select
              value={mode}
              onValueChange={(v) =>
                navigate({
                  to: '/files',
                  search: buildFilesSearch({ path, q, mode: v as FilesSearchMode }),
                  replace: true,
                })
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="folder">Current folder</SelectItem>
                <SelectItem value="all">All files</SelectItem>
              </SelectContent>
            </Select>
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
          {isGlobalSearch ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {globalSearch.isLoading
                ? 'Searching…'
                : `${globalSearch.data?.entries.length ?? 0} matches`}
            </p>
          ) : (
            !allModePrompt &&
            list.data && (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {list.data.total} total
                {folderFilter ? ` · ${entries.length} shown` : ''}
              </p>
            )
          )}
        </div>
        {!isGlobalSearch && !allModePrompt && list.isLoading && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
        )}
        {isGlobalSearch && globalSearch.isLoading && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">Searching…</p>
        )}
        {!isGlobalSearch && !allModePrompt && list.isError && (
          <p className="p-6 text-sm text-[hsl(var(--destructive))]">
            {String((list.error as Error)?.message ?? list.error)}
          </p>
        )}
        {isGlobalSearch && globalSearch.isError && (
          <p className="p-6 text-sm text-[hsl(var(--destructive))]">
            {String((globalSearch.error as Error)?.message ?? globalSearch.error)}
          </p>
        )}
        {allModePrompt && (
          <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">
            {q.trim().length === 0
              ? 'Type at least 2 characters to search all files.'
              : 'Keep typing — searches require at least 2 characters.'}
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
            {viewMode === 'list' ? (
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
                        onNavigate={(p) =>
                          navigate({ to: '/files', search: buildFilesSearch({ path: p, q, mode }) })
                        }
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
            ) : (
              <div className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 bg-transparent">
                {entries.map((entry, i) => (
                  <EntryCard
                    key={entry.path}
                    entry={entry}
                    selected={i === selectedIndex}
                    onNavigate={(p) =>
                      navigate({ to: '/files', search: buildFilesSearch({ path: p, q, mode }) })
                    }
                    onPreview={setPreviewPath}
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
              </div>
            )}
          </DragDropProvider>
        )}
        {!list.isLoading &&
          !globalSearch.isLoading &&
          !isEmpty &&
          !allModePrompt &&
          entries.length === 0 && (
            <p className="p-6 text-sm text-[hsl(var(--muted-foreground))]">
              No files match your search.
            </p>
          )}
      </section>

      {list.data && !isGlobalSearch && !allModePrompt && (
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
        entries={entries}
        onOpenChange={(open) => {
          if (!open) setPreviewPath(null);
        }}
        onNavigate={setPreviewPath}
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

function Breadcrumb({ path, q, mode }: { path: string; q: string; mode: FilesSearchMode }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))]"
    >
      <Link
        to="/files"
        search={buildFilesSearch({ path: '', q, mode })}
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
                search={buildFilesSearch({ path: sub, q, mode })}
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
    return (
      <DirectoryRow entry={entry} selected={selected} onNavigate={onNavigate} onShare={onShare} />
    );
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
  onShare,
}: {
  entry: Extract<ListedEntry, { kind: 'dir' }>;
  selected: boolean;
  onNavigate: (path: string) => void;
  onShare: (path: string) => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.files.folder.delete({ path: entry.path });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['files-search'] });
      qc.invalidateQueries({ queryKey: ['trash'] });
      qc.invalidateQueries({ queryKey: ['storage-usage'] });
      pushNotification({ kind: 'success', title: `Moved ${entry.name} to trash` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: `Could not move ${entry.name} to trash`,
        body: err instanceof Error ? err.message : undefined,
      });
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
                <DropdownMenuItem asChild>
                  <a
                    href={`/api/files/archive?path=${encodeURIComponent(entry.path)}`}
                    download={`${entry.name}.zip`}
                  >
                    <Download /> Download .zip
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  onClick={() => onShare(entry.path)}
                >
                  <Share2 /> Share
                </DropdownMenuItem>
                <ConfirmDialog
                  trigger={
                    <DropdownMenuItem destructive onSelect={(e) => e.preventDefault()}>
                      <Trash2 /> Move to trash
                    </DropdownMenuItem>
                  }
                  title={`Move "${entry.name}" to trash?`}
                  description="The folder and all its contents will leave My files until restored or permanently deleted."
                  confirmLabel="Move to trash"
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
      qc.invalidateQueries({ queryKey: ['files-search'] });
      qc.invalidateQueries({ queryKey: ['trash'] });
      qc.invalidateQueries({ queryKey: ['storage-usage'] });
      pushNotification({ kind: 'success', title: `Moved ${entry.name} to trash` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: `Could not move ${entry.name} to trash`,
        body: err instanceof Error ? err.message : undefined,
      });
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
    onSuccess: () =>
      pushNotification({ kind: 'success', title: `Thumbnail regenerated for ${entry.name}` }),
    onError: () =>
      pushNotification({
        kind: 'error',
        title: `Could not regenerate thumbnail for ${entry.name}`,
      }),
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
                src={`/api/files/thumbnail?path=${encodeURIComponent(entry.path)}&v=${entry.mtimeMs}`}
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
                    <Trash2 /> Move to trash
                  </DropdownMenuItem>
                }
                title={`Move ${entry.name} to trash?`}
                description="The file will leave My files until restored or permanently deleted."
                confirmLabel="Move to trash"
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
        Drop files anywhere on this page or upload from your computer.
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

function EntryCard({
  entry,
  onNavigate,
  onPreview,
  onShare,
  selected,
}: {
  entry: ListedEntry;
  onNavigate: (path: string) => void;
  onPreview: (path: string) => void;
  onShare: (path: string) => void;
  selected: boolean;
}) {
  if (entry.kind === 'dir') {
    return (
      <DirectoryCard entry={entry} selected={selected} onNavigate={onNavigate} onShare={onShare} />
    );
  }

  return <FileCard entry={entry} selected={selected} onPreview={onPreview} onShare={onShare} />;
}

function DirectoryCard({
  entry,
  selected,
  onNavigate,
  onShare,
}: {
  entry: Extract<ListedEntry, { kind: 'dir' }>;
  selected: boolean;
  onNavigate: (path: string) => void;
  onShare: (path: string) => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.files.folder.delete({ path: entry.path });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['files-search'] });
      qc.invalidateQueries({ queryKey: ['trash'] });
      qc.invalidateQueries({ queryKey: ['storage-usage'] });
      pushNotification({ kind: 'success', title: `Moved ${entry.name} to trash` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: `Could not move ${entry.name} to trash`,
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });
  const droppableId = dndId('dir', entry.path);
  const { ref: dropRef, isDropTarget } = useDroppable({ id: droppableId });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clickable dashboard folder card
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler is for visual dashboard card
    <div
      ref={dropRef}
      onClick={() => onNavigate(entry.path)}
      className={cn(
        'cursor-pointer relative flex flex-col rounded-2xl border p-5 transition-all duration-200',
        'bg-[hsl(var(--surface-2)/0.35)] border-[hsl(var(--border)/0.4)] hover:border-[hsl(var(--primary)/0.4)]',
        'hover:shadow-lg hover:-translate-y-0.5',
        selected && 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)]',
        isDropTarget && 'bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary))]',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex size-10 items-center justify-center rounded-xl bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))]">
          <Folder className="size-5" />
        </div>
        {!entry.isParentLink && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-8"
                aria-label={`More actions for ${entry.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem asChild>
                <a
                  href={`/api/files/archive?path=${encodeURIComponent(entry.path)}`}
                  download={`${entry.name}.zip`}
                >
                  <Download /> Download .zip
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                onClick={() => onShare(entry.path)}
              >
                <Share2 /> Share
              </DropdownMenuItem>
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem destructive onSelect={(e) => e.preventDefault()}>
                    <Trash2 /> Move to trash
                  </DropdownMenuItem>
                }
                title={`Move "${entry.name}" to trash?`}
                description="The folder and all its contents will leave My files until restored or permanently deleted."
                confirmLabel="Move to trash"
                tone="destructive"
                onConfirm={() => del.mutateAsync()}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="mt-4 min-w-0">
        <h3 className="truncate font-semibold text-sm leading-snug">
          {entry.isParentLink ? '..' : entry.name}
        </h3>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
          {entry.isParentLink ? 'Parent folder' : `${entry.itemCount} items`}
        </p>
      </div>
    </div>
  );
}

function FileCard({
  entry,
  selected,
  onPreview,
  onShare,
}: {
  entry: Extract<ListedEntry, { kind: 'file' }>;
  selected: boolean;
  onPreview: (path: string) => void;
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
      qc.invalidateQueries({ queryKey: ['files-search'] });
      qc.invalidateQueries({ queryKey: ['trash'] });
      qc.invalidateQueries({ queryKey: ['storage-usage'] });
      pushNotification({ kind: 'success', title: `Moved ${entry.name} to trash` });
    },
    onError: (err: unknown) => {
      pushNotification({
        kind: 'error',
        title: `Could not move ${entry.name} to trash`,
        body: err instanceof Error ? err.message : undefined,
      });
    },
  });
  const draggableId = dndId('file', entry.path);
  const { ref: dragRef, isDragging } = useDraggable({ id: draggableId });
  const downloadHref = `/api/files/content?path=${encodeURIComponent(entry.path)}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clickable dashboard file card
    <div
      ref={dragRef}
      onDoubleClick={() => onPreview(entry.path)}
      className={cn(
        'cursor-pointer relative flex flex-col rounded-2xl border p-5 transition-all duration-200',
        'bg-[hsl(var(--surface-2)/0.35)] border-[hsl(var(--border)/0.4)] hover:border-[hsl(var(--primary)/0.4)]',
        'hover:shadow-lg hover:-translate-y-0.5',
        selected && 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)]',
        isDragging && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex size-10 items-center justify-center overflow-hidden rounded-xl bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
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
        <div className="flex items-center gap-1">
          <a
            href={downloadHref}
            download={entry.name}
            className="inline-flex size-8 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
            aria-label={`Download ${entry.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="size-4" />
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-8"
                aria-label={`More actions for ${entry.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
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
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem destructive onSelect={(e) => e.preventDefault()}>
                    <Trash2 /> Move to trash
                  </DropdownMenuItem>
                }
                title={`Move "${entry.name}" to trash?`}
                description="The file will leave My files until restored or permanently deleted."
                confirmLabel="Move to trash"
                tone="destructive"
                onConfirm={() => del.mutateAsync()}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-4 min-w-0 flex-1">
        <h3 className="truncate font-semibold text-sm leading-snug">{entry.name}</h3>
        <p className="mt-1 truncate text-[11px] text-[hsl(var(--muted-foreground))]">
          {displayMimeLabel(entry.mime, entry.name)}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[hsl(var(--border)/0.5)] pt-3 text-[11px] text-[hsl(var(--muted-foreground))]">
        <span>{humanSize(entry.size)}</span>
        <span>{humanTime(entry.mtimeMs)}</span>
      </div>
    </div>
  );
}
