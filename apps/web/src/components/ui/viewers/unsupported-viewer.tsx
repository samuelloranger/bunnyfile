import { Download, FileIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';

export function UnsupportedViewer({
  name,
  mime,
  downloadHref,
}: {
  name: string;
  mime: string;
  downloadHref: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-[hsl(var(--border))] p-8 text-center">
      <FileIcon className="size-12 text-[hsl(var(--muted-foreground))]" />
      <div className="space-y-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">{mime}</p>
      </div>
      <Button asChild leftIcon={<Download />}>
        <a href={downloadHref} download={name}>
          Download
        </a>
      </Button>
    </div>
  );
}
