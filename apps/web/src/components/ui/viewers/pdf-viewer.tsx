import { ExternalLink } from 'lucide-react';
import { Button } from '~/components/ui/button';

export function PdfViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" asChild leftIcon={<ExternalLink />}>
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
        </Button>
      </div>
      <iframe
        title={name}
        src={src}
        className="h-[calc(90vh_-_12rem)] w-full rounded-lg border border-[hsl(var(--border))]"
      />
    </div>
  );
}
