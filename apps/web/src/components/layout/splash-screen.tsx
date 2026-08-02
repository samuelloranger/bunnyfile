import logo from '~/assets/logo-transparent.svg';

export function SplashScreen({ message = 'Loading…' }: { message?: string }) {
  return (
    <div
      className="flex h-dvh w-full items-center justify-center bg-[hsl(var(--background))]"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 text-[hsl(var(--muted-foreground))]">
        <img src={logo} alt="" className="size-12 shrink-0 animate-pulse" />
        <p className="text-xs">{message}</p>
      </div>
    </div>
  );
}
