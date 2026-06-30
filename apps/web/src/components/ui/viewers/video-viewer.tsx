import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function VideoViewer({ src, name }: { src: string; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    const onDurationChange = () => setDuration(v.duration);
    const onError = () => setUnsupported(true);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('error', onError);
    };
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function seek(e: ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  }

  function changeVolume(e: ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current;
    if (!v) return;
    const val = Number(e.target.value);
    v.volume = val;
    setVolume(val);
    setMuted(val === 0);
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }

  function requestFullscreen() {
    void videoRef.current?.requestFullscreen();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-black">
      {/* biome-ignore lint/a11y/useMediaCaption: arbitrary uploaded videos do not have caption tracks */}
      <video
        ref={videoRef}
        src={src}
        className="max-h-[calc(90vh_-_15rem)] w-full object-contain"
      />
      {unsupported ? (
        <div className="flex flex-col items-center gap-2 p-4 text-center">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            This format cannot be played in your browser.
          </p>
          <a href={src} download={name} className="text-sm text-[hsl(var(--primary))] underline">
            Download instead
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-2 bg-[hsl(var(--surface-2)/0.9)] px-4 py-3">
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
              <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <button
              type="button"
              onClick={requestFullscreen}
              aria-label="Fullscreen"
              className="rounded-md p-1 hover:bg-[hsl(var(--muted))]"
            >
              <Maximize className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
