import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Button } from '~/components/ui/button';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '~/components/ui/modal';
import { AudioPlayer } from '~/components/ui/viewers/audio-player';
import { CodeViewer } from '~/components/ui/viewers/code-viewer';
import { ImageViewer } from '~/components/ui/viewers/image-viewer';
import { MarkdownViewer } from '~/components/ui/viewers/markdown-viewer';
import { PdfViewer } from '~/components/ui/viewers/pdf-viewer';
import { UnsupportedViewer } from '~/components/ui/viewers/unsupported-viewer';
import { VideoViewer } from '~/components/ui/viewers/video-viewer';
import type { Entry, FileEntry } from '~/lib/files';

function viewerFor(entry: FileEntry, src: string) {
  const { mime, name } = entry;
  if (mime.startsWith('image/')) return <ImageViewer src={src} name={name} />;
  if (mime.startsWith('video/')) return <VideoViewer src={src} name={name} />;
  if (mime.startsWith('audio/')) return <AudioPlayer src={src} name={name} />;
  if (mime === 'application/pdf') return <PdfViewer src={src} name={name} />;
  if (mime === 'text/markdown') return <MarkdownViewer src={src} />;
  if (mime.startsWith('text/') || mime === 'application/json')
    return <CodeViewer src={src} name={name} mime={mime} />;
  return <UnsupportedViewer name={name} mime={mime} downloadHref={src} />;
}

export function FilePreviewModal({
  path,
  entry,
  entries,
  onOpenChange,
  onNavigate,
}: {
  path: string | null;
  entry: FileEntry | null;
  entries: Entry[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const fileEntries = useMemo(
    () => entries.filter((e): e is FileEntry => e.kind === 'file'),
    [entries],
  );

  const currentIndex = useMemo(
    () => fileEntries.findIndex((e) => e.path === path),
    [fileEntries, path],
  );

  const hasSiblings = fileEntries.length > 1;
  const prevEntry = hasSiblings
    ? fileEntries[(currentIndex - 1 + fileEntries.length) % fileEntries.length]
    : null;
  const nextEntry = hasSiblings ? fileEntries[(currentIndex + 1) % fileEntries.length] : null;

  useEffect(() => {
    if (!path) return;
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (['input', 'textarea', 'video', 'audio'].includes(tag)) return;
      if (e.key === 'ArrowLeft' && prevEntry) onNavigate(prevEntry.path);
      if (e.key === 'ArrowRight' && nextEntry) onNavigate(nextEntry.path);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [path, prevEntry, nextEntry, onNavigate]);

  const open = Boolean(path && entry);
  const src = entry ? `/api/files/content?path=${encodeURIComponent(entry.path)}` : '';

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        size="xl"
        className="flex max-h-[90vh] max-w-4xl flex-col gap-3 overflow-hidden"
      >
        <div className="flex items-start gap-3 pr-8">
          <ModalHeader className="min-w-0 flex-1">
            <ModalTitle className="truncate">{entry?.name ?? 'Preview'}</ModalTitle>
            <ModalDescription>{entry?.mime ?? ''}</ModalDescription>
          </ModalHeader>
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            {hasSiblings && (
              <>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!prevEntry}
                  onClick={() => prevEntry && onNavigate(prevEntry.path)}
                  aria-label="Previous file"
                >
                  <ChevronLeft />
                </Button>
                <span className="min-w-[3rem] text-center text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {currentIndex + 1} / {fileEntries.length}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!nextEntry}
                  onClick={() => nextEntry && onNavigate(nextEntry.path)}
                  aria-label="Next file"
                >
                  <ChevronRight />
                </Button>
              </>
            )}
            <Button variant="outline" size="icon-sm" asChild aria-label="Download">
              <a href={src} download={entry?.name}>
                <Download />
              </a>
            </Button>
          </div>
        </div>
        <div key={entry?.path} className="overflow-auto">
          {entry && viewerFor(entry, src)}
        </div>
      </ModalContent>
    </Modal>
  );
}
