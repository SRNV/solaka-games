import { useEffect, useRef } from 'react';

/**
 * Hook to prevent the device from going to sleep using the Screen Wake Lock API
 * and a fallback invisible video loop.
 */
export function useWakeLock(enabled: boolean = true) {
  const wakeLockRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // 1. Screen Wake Lock API
    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        if (wakeLockRef.current) return;
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      } catch (err) {}
    }

    // 2. Persistent Video Hack
    function startVideoHack() {
      if (videoRef.current) {
        videoRef.current.play().catch(() => {});
        return;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.setAttribute('webkit-playsinline', 'true');
      video.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-1';
      
      // Blank mp4
      video.src = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAAZptb292AAAAbG12aGQAAAAA36Ym2t+mJtoAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAGWlvZHMAAAAAEAAfQBUAAf///8AAAAAem10cmEAAABcdGtoZAAAAAPfpiba36Ym2gAAAAEAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAZtZGlhAAAAIG1kaGQAAAAA36Ym2t+mJtoAAAPoAAAAKAABAAAAAAAAAABoZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAG9pbmYAAAAUcmVjdiB2aWRlAG1wNHYAAAAAbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAccmRefAAAAAByZWxmAAAAAAAAAAZhcGJsAAAAZ3N0YmwAAABMc3RzZAAAAAAAAAABAAAAPGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAKAAoAEgAAABIAAAAAAAAAAAVhdmNDAAAAAAAAAAAAMHBhc3AAAAAOc3R0cwAAAAAAAAAAAAAACHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAF0AAAABAAAACHN0Y28AAAAAAAAAAAAAAAEAAAAU';
      
      document.body.appendChild(video);
      video.play().catch(() => {});
      videoRef.current = video;
    }

    // Try immediately
    requestWakeLock();
    startVideoHack();

    // Re-trigger on ANY interaction to bypass browser restrictions
    const forceActive = () => {
      requestWakeLock();
      if (videoRef.current && videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') forceActive();
    };

    // Listen to all interaction types
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('touchstart', forceActive, { passive: true });
    window.addEventListener('mousedown', forceActive, { passive: true });
    window.addEventListener('pointerdown', forceActive, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('touchstart', forceActive);
      window.removeEventListener('mousedown', forceActive);
      window.removeEventListener('pointerdown', forceActive);
      
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.remove();
        videoRef.current = null;
      }
    };
  }, [enabled]);
}
