import { Music, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, name }: { src: string; name: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(a.currentTime);
    const onDurationChange = () => setDuration(a.duration);
    const onError = () => setUnsupported(true);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTimeUpdate);
    a.addEventListener('durationchange', onDurationChange);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTimeUpdate);
      a.removeEventListener('durationchange', onDurationChange);
      a.removeEventListener('error', onError);
    };
  }, []);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  function seek(e: ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Number(e.target.value);
  }

  function changeVolume(e: ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const val = Number(e.target.value);
    a.volume = val;
    // Keep muted in sync so raising the slider while muted actually plays.
    a.muted = val === 0;
    setVolume(val);
    setMuted(val === 0);
  }

  function toggleMute() {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  }

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-2))] p-6">
      {/* biome-ignore lint/a11y/useMediaCaption: audio files do not have caption tracks */}
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-20 items-center justify-center rounded-full bg-[hsl(var(--muted))]">
          <Music className="size-8 text-[hsl(var(--muted-foreground))]" />
        </div>
        <p className="max-w-sm truncate text-sm font-medium">{name}</p>
        {unsupported ? (
          <div className="text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              This format cannot be played in your browser.
            </p>
            <a href={src} download={name} className="text-sm text-[hsl(var(--primary))] underline">
              Download instead
            </a>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={seek}
              aria-label="Seek"
              className="w-full accent-[hsl(var(--primary))]"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? 'Pause' : 'Play'}
                  className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
                >
                  {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                </button>
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="size-4" />
                  ) : (
                    <Volume2 className="size-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={changeVolume}
                  aria-label="Volume"
                  className="w-20 accent-[hsl(var(--primary))]"
                />
              </div>
              <span className="w-24 text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
