import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';

export function ImageViewer({ src, name }: { src: string; name: string }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[hsl(var(--border))]"
      style={{
        backgroundImage:
          'repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%) 0 / 20px 20px',
      }}
    >
      <TransformWrapper initialScale={1} minScale={0.1} maxScale={10} centerOnInit>
        {({ zoomIn, zoomOut, resetTransform, state }) => (
          <>
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '70vh' }}
              contentStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img
                src={src}
                alt={name}
                style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            </TransformComponent>
            <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface)/0.9)] px-2 py-1.5 backdrop-blur-sm">
              <button
                type="button"
                onClick={() => zoomOut()}
                aria-label="Zoom out"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <ZoomOut className="size-3.5" />
              </button>
              <span className="min-w-[3rem] text-center text-xs tabular-nums">
                {Math.round(state.scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => zoomIn()}
                aria-label="Zoom in"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <ZoomIn className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => resetTransform()}
                aria-label="Reset zoom"
                className="rounded p-1 hover:bg-[hsl(var(--muted))]"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
