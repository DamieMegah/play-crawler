import { useEffect, useRef, useState, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faFolder,
  faVolumeXmark,
  faVolumeHigh,
  faVolumeLow,
  faForwardStep,
  faBackwardStep,
  faRotateLeft,
  faRotateRight,
  faList,
  faXmark,
  faCamera,
  faShareNodes,
  faClosedCaptioning,
  faGear,
  faRepeat,
  faSpinner,
  faMagnifyingGlass,
  faPlay,
  faPause,
  faExpand,
  faCompress,
  faDownload,
  faFilm,
  faChevronDown,
  faCheck,
  faMusic,
  faFileAudio,
} from "@fortawesome/free-solid-svg-icons";
import {
  faFacebook,
  faWhatsapp,
  faTiktok,
} from "@fortawesome/free-brands-svg-icons";

const AUTO_HIDE_DELAY = 3000;
const DB_NAME = "video-player-db";
const DB_STORE = "handles";
const DB_KEY = "lastFolder";
const CLIP_SECONDS = 30;
const CHUNK_MS = 1000;

const supportsFSAccess =
  typeof window !== "undefined" && "showDirectoryPicker" in window;
const QUALITY_RE = /\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i;

// ── Responsive hook ──
function useWindowWidth() {
  const [w, setW] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280
  );
  useEffect(() => {
    const fn = () => setW(window.innerWidth);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return w;
}

// ── IndexedDB helpers ──
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── SRT → VTT ──
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}

// ── WAV encoder (pure JS – no external lib needed) ──
// Converts a decoded AudioBuffer into a 16-bit PCM WAV Blob.
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channel data and clamp to [-1, 1] → int16
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export default function VideoPlayer() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const controlsTimer = useRef(null);
  const canvasRef = useRef(null);
  const recorderRef = useRef(null);
  const chunkBufferRef = useRef([]);
  const trackUrlRef = useRef(null);
  const autoplayNextRef = useRef(false);

  const winW = useWindowWidth();
  const isMobile = winW < 640;
  const isTablet = winW >= 640 && winW < 1024;

  const [currentIndex, setCurrentIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [playlist, setPlaylist] = useState([]);
  const [showPlaylist, setShowPlaylist] = useState(true);
  const [folderName, setFolderName] = useState("");
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [restoring, setRestoring] = useState(supportsFSAccess);
  const [rotation, setRotation] = useState(0);
  const [activeQuality, setActiveQuality] = useState(null);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [clipBlob, setClipBlob] = useState(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [shotUrl, setShotUrl] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const [showSubMenu, setShowSubMenu] = useState(false);
  const [subSearching, setSubSearching] = useState(false);
  const [subResults, setSubResults] = useState([]);
  const [subError, setSubError] = useState("");
  // Audio converter state
  const [showConverter, setShowConverter] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0); // 0–100
  const [convertStatus, setConvertStatus] = useState("idle"); // idle | decoding | encoding | done | error
  const [convertedUrl, setConvertedUrl] = useState(null);
  const [convertedName, setConvertedName] = useState("");

  // API key – injected at build time, never shown in UI
  // Vite: VITE_OPENSUBTITLES_API_KEY=xxx in .env
  // CRA:  REACT_APP_OPENSUBTITLES_API_KEY=xxx in .env
  const osKey =
    (typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_OPENSUBTITLES_API_KEY) ||
    (typeof process !== "undefined" &&
      process.env?.REACT_APP_OPENSUBTITLES_API_KEY) ||
    "";

  const dirHandleRef = useRef(null);
  const currentEntry = playlist[currentIndex] ?? null;
  const currentSource = currentEntry
    ? currentEntry.sources.find((s) => s.quality === activeQuality) ||
      currentEntry.sources[0]
    : null;

  // Cleanup blobs
  useEffect(() => {
    return () => {
      playlist.forEach((p) => {
        p.sources.forEach((s) => URL.revokeObjectURL(s.url));
        if (p.thumb) URL.revokeObjectURL(p.thumb);
      });
    };
  }, [playlist]);

  // ── Build playlist from File[] ──
  const buildPlaylist = async (files) => {
    const sorted = [...files]
      .filter((f) => f.type.startsWith("video/"))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );
    const groups = new Map();
    for (const file of sorted) {
      const rawName = file.name.replace(/\.[^/.]+$/, "");
      const qMatch = rawName.match(QUALITY_RE);
      const quality = qMatch ? qMatch[0].toLowerCase() : "source";
      const baseTitle =
        rawName.replace(QUALITY_RE, "").replace(/[\s._-]+$/, "").trim() ||
        rawName;
      const url = URL.createObjectURL(file);
      if (!groups.has(baseTitle))
        groups.set(baseTitle, {
          id: crypto.randomUUID(),
          title: baseTitle,
          sources: [],
          thumb: null,
        });
      groups.get(baseTitle).sources.push({ quality, url, file, size: file.size });
    }
    const entries = [...groups.values()];
    await Promise.all(entries.map((e) => generateThumb(e)));
    return entries;
  };

  const generateThumb = (entry) =>
    new Promise((resolve) => {
      try {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "metadata";
        v.src = entry.sources[0].url;
        const cleanup = () => { v.removeAttribute("src"); v.load(); };
        v.addEventListener("loadeddata", () => {
          v.currentTime = Math.min(2, (v.duration || 4) / 4);
        });
        v.addEventListener("seeked", () => {
          try {
            const c = document.createElement("canvas");
            c.width = 320;
            c.height = Math.round((320 * (v.videoHeight || 9)) / (v.videoWidth || 16));
            c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
            c.toBlob((blob) => {
              entry.thumb = blob ? URL.createObjectURL(blob) : null;
              cleanup();
              resolve();
            }, "image/jpeg", 0.7);
          } catch { cleanup(); resolve(); }
        });
        v.addEventListener("error", () => { cleanup(); resolve(); });
      } catch { resolve(); }
    });

  const readDirHandle = async (handle) => {
    const files = [];
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (file.type.startsWith("video/")) files.push(file);
      }
    }
    return files;
  };

  // ── Restore last folder ──
  useEffect(() => {
    if (!supportsFSAccess) return setRestoring(false);
    (async () => {
      try {
        const handle = await idbGet(DB_KEY);
        if (!handle) return setRestoring(false);
        dirHandleRef.current = handle;
        setFolderName(handle.name);
        const perm = await handle.queryPermission({ mode: "read" });
        if (perm === "granted") {
          const files = await readDirHandle(handle);
          if (files.length) {
            const entries = await buildPlaylist(files);
            setPlaylist(entries);
            setCurrentIndex(0);
            setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
          }
        } else {
          setNeedsReconnect(true);
        }
      } catch { /* stale */ } finally { setRestoring(false); }
    })();
  }, []);

  // ── Load source ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    const t = video.currentTime;
    video.src = currentSource.url;
    video.load();
    if (!autoplayNextRef.current) {
      setPlaying(false); setCurrentTime(0);
    } else {
      video.addEventListener("loadedmetadata", () => { video.currentTime = t; }, { once: true });
    }
    setDuration(0); setBuffered(0);
    // Reset converter state on track change
    setShowConverter(false);
    setConvertStatus("idle");
    setConvertProgress(0);
    if (convertedUrl) { URL.revokeObjectURL(convertedUrl); setConvertedUrl(null); }
  }, [currentSource?.url]);

  // Clear subtitle results on track change
  useEffect(() => { setSubResults([]); setSubError(""); }, [currentIndex]);

  // Autoplay on index change (when triggered explicitly)
  useEffect(() => {
    if (!autoplayNextRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => { video.play().catch(() => {}); autoplayNextRef.current = false; };
    video.addEventListener("loadedmetadata", onReady, { once: true });
    return () => video.removeEventListener("loadedmetadata", onReady);
  }, [currentIndex]);

  // ── Video events ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => { setDuration(video.duration); setLoading(false); };
    const onWait = () => setLoading(true);
    const onPlay = () => { setLoading(false); setPlaying(true); setShowPlaylist(false); };
    const onPause = () => setPlaying(false);
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onEnded = () => {
      setCurrentIndex((prev) => {
        if (prev < playlist.length - 1) { autoplayNextRef.current = true; return prev + 1; }
        return prev;
      });
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("waiting", onWait);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("waiting", onWait);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [playlist.length]);

  // ── Rolling 30s recorder ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    let alive = true;
    const stop = () => {
      if (recorderRef.current?.state !== "inactive") { try { recorderRef.current.stop(); } catch {} }
    };
    const start = () => {
      try {
        const stream = video.captureStream?.();
        if (!stream) return;
        const recorder = new MediaRecorder(stream, { mimeType: pickMime() });
        chunkBufferRef.current = [];
        recorder.ondataavailable = (e) => {
          if (!e.data?.size) return;
          chunkBufferRef.current.push({ blob: e.data, t: Date.now() });
          const cutoff = Date.now() - (CLIP_SECONDS + 2) * 1000;
          chunkBufferRef.current = chunkBufferRef.current.filter((c) => c.t >= cutoff);
        };
        recorder.start(CHUNK_MS);
        recorderRef.current = recorder;
      } catch {}
    };
    const onPlay = () => alive && start();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", stop);
    video.addEventListener("ended", stop);
    return () => {
      alive = false;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", stop);
      video.removeEventListener("ended", stop);
      stop();
    };
  }, [currentSource?.url]);

  function pickMime() {
    const c = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return c.find((m) => MediaRecorder.isTypeSupported?.(m)) || "video/webm";
  }

  // ── Fullscreen ──
  useEffect(() => {
    const fn = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (isMobile) return;
    const fn = (e) => {
      if (e.target.tagName === "INPUT") return;
      switch (e.key) {
        case " ": e.preventDefault(); playPause(); break;
        case "ArrowLeft": skip(-10); break;
        case "ArrowRight": skip(10); break;
        case "ArrowUp": e.preventDefault(); handleVolume(Math.min(volume + 0.1, 1)); break;
        case "ArrowDown": e.preventDefault(); handleVolume(Math.max(volume - 0.1, 0)); break;
        case "m": case "M": toggleMute(); break;
        case "f": case "F": toggleFullscreen(); break;
        case "p": case "P": setShowPlaylist((v) => !v); break;
        case "n": case "N": goNext(); break;
        case "c": case "C": takeScreenshot(); break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [volume, currentIndex, playlist.length, isMobile]);

  // ── Controls auto-hide ──
  const hideControls = useCallback(() => {
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), AUTO_HIDE_DELAY);
  }, []);
  const revealControls = () => {
    setShowControls(true);
    if (playing) hideControls();
  };

  // Mobile: tap toggles controls
  const handleVideoTap = (e) => {
    if (isMobile) {
      e.stopPropagation();
      if (showControls) setShowControls(false);
      else { setShowControls(true); hideControls(); }
    } else {
      playPause();
    }
  };

  // ── Folder loading ──
  const loadFolder = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const entries = await buildPlaylist(files);
    setPlaylist(entries);
    setCurrentIndex(0);
    setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
    setFolderName(files[0]?.webkitRelativePath?.split("/")[0] ?? "");
    setNeedsReconnect(false);
  };
  const pickFolderFSAccess = async () => {
    try {
      const handle = await window.showDirectoryPicker();
      dirHandleRef.current = handle;
      await idbSet(DB_KEY, handle);
      setFolderName(handle.name);
      const files = await readDirHandle(handle);
      const entries = await buildPlaylist(files);
      setPlaylist(entries);
      setCurrentIndex(0);
      setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
      setNeedsReconnect(false);
    } catch {}
  };
  const reconnectFolder = async () => {
    const handle = dirHandleRef.current;
    if (!handle) return;
    const perm = await handle.requestPermission({ mode: "read" });
    if (perm === "granted") {
      const files = await readDirHandle(handle);
      const entries = await buildPlaylist(files);
      setPlaylist(entries);
      setCurrentIndex(0);
      setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
      setNeedsReconnect(false);
    }
  };
  const openFolder = supportsFSAccess ? pickFolderFSAccess : null;

  // ── Playback ──
  const playPause = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play(); else video.pause();
  };
  const skip = (s) => { if (videoRef.current) videoRef.current.currentTime += s; };
  const seek = (p) => { if (videoRef.current) videoRef.current.currentTime = p * duration; };
  const handleVolume = (v) => {
    if (!videoRef.current) return;
    videoRef.current.volume = v; setVolume(v); setMuted(v === 0);
  };
  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
  };
  const changeSpeed = (s) => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = s; setPlaybackRate(s); setShowSettings(false);
  };
  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await playerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };
  const playEntry = (i) => {
    autoplayNextRef.current = true;
    setRotation(0);
    setCurrentIndex(i);
    setActiveQuality(playlist[i]?.sources[0]?.quality ?? null);
  };
  const goNext = () => { if (currentIndex < playlist.length - 1) playEntry(currentIndex + 1); };
  const goPrev = () => { if (currentIndex > 0) playEntry(currentIndex - 1); };
  const rotate = () => setRotation((r) => (r + 90) % 360);

  const fmt = (t) => {
    if (!t || isNaN(t)) return "0:00";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  };
  const pct = (n, d) => (d ? Math.min((n / d) * 100, 100) : 0);

  // ── Screenshot ──
  const takeScreenshot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const c = canvasRef.current;
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    c.toBlob((blob) => {
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      setShotUrl(URL.createObjectURL(blob));
    }, "image/png");
  };
  const downloadShot = () => {
    if (!shotUrl) return;
    const a = document.createElement("a");
    a.href = shotUrl;
    a.download = `${currentEntry?.title || "screenshot"}.png`;
    a.click();
  };

  // ── Clip sharing – downloads the last 30 s as a WebM file.
  //    On mobile with native share sheet, the OS may offer apps like WhatsApp / Facebook directly.
  //    On desktop the file is downloaded; the share link opens the platform's web uploader.
  const buildClip = async () => {
    setClipBusy(true);
    try {
      if (recorderRef.current?.state === "recording") {
        await new Promise((resolve) => {
          recorderRef.current.addEventListener("dataavailable", resolve, { once: true });
          recorderRef.current.requestData();
        });
      }
      const cutoff = Date.now() - CLIP_SECONDS * 1000;
      const chunks = chunkBufferRef.current.filter((c) => c.t >= cutoff).map((c) => c.blob);
      if (!chunks.length) { setClipBusy(false); return null; }
      const blob = new Blob(chunks, { type: chunks[0].type || "video/webm" });
      setClipBlob(blob); return blob;
    } finally { setClipBusy(false); }
  };

  const shareClip = async (target) => {
    const blob = clipBlob || (await buildClip());
    if (!blob) return;
    const fileName = `${(currentEntry?.title || "clip").replace(/\s+/g, "_")}.webm`;
    const file = new File([blob], fileName, { type: blob.type });
    const text = `Check out this clip from "${currentEntry?.title || "this video"}"`;
    // Try native share sheet (works on Android/iOS – may offer WhatsApp/Facebook/TikTok)
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text, title: currentEntry?.title }); return; }
      catch {}
    }
    // Desktop fallback: download the clip, then open the platform's web uploader
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName; a.click();
    if (target === "whatsapp") window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    else if (target === "facebook") window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`, "_blank");
    else if (target === "tiktok") window.open("https://www.tiktok.com/upload", "_blank");
  };

  // ── Subtitles: local ──
  const loadLocalSubtitle = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    const vtt = file.name.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
    const blob = new Blob([vtt], { type: "text/vtt" });
    if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
    const url = URL.createObjectURL(blob); trackUrlRef.current = url;
    setSubtitleUrl(url); setSubtitlesOn(true); setShowSubMenu(false);
  };

  // ── Subtitles: OpenSubtitles ──
  const searchSubtitles = async () => {
    if (!currentEntry) return;
    if (!osKey) { setSubError("OpenSubtitles API key not configured. Contact the app administrator."); return; }
    setSubSearching(true); setSubError(""); setSubResults([]);
    try {
      const res = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(currentEntry.title)}&languages=en`,
        { headers: { "Api-Key": osKey, "User-Agent": "react-video-player v1.0" } }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setSubResults((data.data || []).slice(0, 8));
      if (!data.data?.length) setSubError("No subtitles found for this title.");
    } catch {
      setSubError("Could not reach OpenSubtitles (CORS / invalid key). Upload a local .srt/.vtt instead.");
    } finally { setSubSearching(false); }
  };

  const downloadSubtitle = async (item) => {
    setSubError("");
    try {
      const fileId = item.attributes?.files?.[0]?.file_id;
      if (!fileId) throw new Error("No file id");
      const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
        method: "POST",
        headers: { "Api-Key": osKey, "Content-Type": "application/json", "User-Agent": "react-video-player v1.0" },
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      const fileRes = await fetch(json.link);
      const text = await fileRes.text();
      const vtt = json.link.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
      const blob = new Blob([vtt], { type: "text/vtt" });
      if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
      const url = URL.createObjectURL(blob); trackUrlRef.current = url;
      setSubtitleUrl(url); setSubtitlesOn(true); setShowSubMenu(false);
    } catch {
      setSubError("Couldn't download that subtitle. Try another or upload manually.");
    }
  };

  // ── Audio converter (Video → WAV) ──
  // Uses Web Audio API – fully client-side, no server or external library.
  // Produces a standard 16-bit PCM WAV file that plays in every audio app.
  const convertToAudio = async () => {
    if (!currentSource) return;
    setShowConverter(true);
    setConvertStatus("decoding");
    setConvertProgress(0);
    if (convertedUrl) { URL.revokeObjectURL(convertedUrl); setConvertedUrl(null); }

    try {
      // 1. Read the video file as an ArrayBuffer
      const arrayBuf = await currentSource.file.arrayBuffer();
      setConvertProgress(20);

      // 2. Decode audio using the Web Audio API
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      setConvertStatus("decoding");
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      audioCtx.close();
      setConvertProgress(60);

      // 3. Encode to WAV
      setConvertStatus("encoding");
      const wavBlob = audioBufferToWav(audioBuf);
      setConvertProgress(95);

      // 4. Create download URL
      const url = URL.createObjectURL(wavBlob);
      const name = `${currentEntry?.title || "audio"}.wav`;
      setConvertedUrl(url);
      setConvertedName(name);
      setConvertProgress(100);
      setConvertStatus("done");
    } catch (err) {
      console.error("Audio conversion failed:", err);
      setConvertStatus("error");
    }
  };

  const downloadAudio = () => {
    if (!convertedUrl) return;
    const a = document.createElement("a");
    a.href = convertedUrl; a.download = convertedName; a.click();
  };

  const FolderPicker = ({ children, style }) =>
    openFolder ? (
      <button style={style} onClick={openFolder} type="button">{children}</button>
    ) : (
      <label style={style}>
        {children}
        <input type="file" multiple accept="video/*" webkitdirectory="" directory="" hidden onChange={loadFolder} />
      </label>
    );

  // ── Sizes ──
  const btnSize = isMobile ? 44 : 36;
  const ctrlFontSize = isMobile ? 20 : 18;
  const playBigSize = isMobile ? 64 : 72;

  // ── Playlist sidebar vs bottom sheet ──
  const playlistVisible = showPlaylist && playlist.length > 0;
  const sidebarStyle = isMobile
    ? {
        ...S.sidebar,
        position: "fixed",
        bottom: 0, left: 0, right: 0,
        width: "100%",
        height: playlistVisible ? "52vh" : 0,
        borderLeft: "none",
        borderTop: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "16px 16px 0 0",
        transition: "height 0.35s cubic-bezier(0.25, 1, 0.5, 1)",
        zIndex: 20, overflow: "hidden",
      }
    : {
        ...S.sidebar,
        width: isTablet ? 260 : 320,
        ...(playlistVisible ? {} : {
          marginRight: isTablet ? -260 : -320,
          opacity: 0, pointerEvents: "none",
        }),
      };

  // ── Converter modal ──
  const ConverterModal = () => (
    <div style={S.modalBackdrop} onClick={() => setShowConverter(false)}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <FontAwesomeIcon icon={faFileAudio} style={{ color: "var(--primary-color, #3390ec)", marginRight: 10 }} />
          <span style={S.modalTitle}>Video to Audio (WAV)</span>
          <button style={S.modalClose} onClick={() => setShowConverter(false)}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div style={S.modalBody}>
          {/* Source info */}
          <div style={S.converterInfo}>
            <FontAwesomeIcon icon={faFilm} style={{ color: "rgba(255,255,255,0.4)", marginRight: 8 }} />
            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentEntry?.title}
            </span>
          </div>

          {/* Progress */}
          {convertStatus !== "idle" && (
            <div style={S.converterProgress}>
              <div style={S.converterBar}>
                <div style={{ ...S.converterFill, width: `${convertProgress}%`,
                  background: convertStatus === "error" ? "#ef4444"
                    : convertStatus === "done" ? "#22c55e"
                    : "var(--primary-color, #3390ec)" }} />
              </div>
              <span style={{ ...S.converterLabel,
                color: convertStatus === "error" ? "#ef4444"
                  : convertStatus === "done" ? "#22c55e"
                  : "rgba(255,255,255,0.6)" }}>
                {convertStatus === "decoding" && <><FontAwesomeIcon icon={faSpinner} spin style={{ marginRight: 6 }} />Decoding audio…</>}
                {convertStatus === "encoding" && <><FontAwesomeIcon icon={faSpinner} spin style={{ marginRight: 6 }} />Encoding WAV…</>}
                {convertStatus === "done" && <><FontAwesomeIcon icon={faCheck} style={{ marginRight: 6 }} />Done! Ready to download.</>}
                {convertStatus === "error" && "Conversion failed. The video may have no audio track, or the format is unsupported."}
              </span>
            </div>
          )}

          {/* Note */}
          <p style={S.converterNote}>
            Audio is extracted entirely in your browser — no upload, no server.
            The output is a standard WAV file that plays in any music or video app.
            Large files may take a few seconds to decode.
          </p>

          {/* Actions */}
          <div style={S.converterActions}>
            {convertStatus === "idle" || convertStatus === "error" ? (
              <button style={S.converterBtn} onClick={convertToAudio}>
                <FontAwesomeIcon icon={faMusic} style={{ marginRight: 8 }} />
                Extract Audio
              </button>
            ) : convertStatus === "done" ? (
              <>
                <button style={S.converterBtn} onClick={downloadAudio}>
                  <FontAwesomeIcon icon={faDownload} style={{ marginRight: 8 }} />
                  Download WAV
                </button>
                <button style={{ ...S.converterBtn, background: "rgba(255,255,255,0.08)" }} onClick={convertToAudio}>
                  <FontAwesomeIcon icon={faRepeat} style={{ marginRight: 8 }} />
                  Re-convert
                </button>
              </>
            ) : (
              <button style={{ ...S.converterBtn, opacity: 0.5, cursor: "not-allowed" }} disabled>
                <FontAwesomeIcon icon={faSpinner} spin style={{ marginRight: 8 }} />
                Converting…
              </button>
            )}
            <button
              style={{ ...S.converterBtn, background: "transparent", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.5)" }}
              onClick={() => setShowConverter(false)}
            >
              <FontAwesomeIcon icon={faXmark} style={{ marginRight: 8 }} />
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // ── Render ──
  return (
    <div style={{ ...S.root, flexDirection: isMobile ? "column" : "row" }}>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {showConverter && <ConverterModal />}

      {/* ── Video area ── */}
      <div style={S.main}>
        {restoring ? (
          <div style={S.empty}>
            <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
            <p style={S.emptyHint}>Reconnecting to your last folder…</p>
          </div>
        ) : needsReconnect ? (
          <div style={S.empty}>
            <button style={S.openBtn} onClick={reconnectFolder} type="button">
              <FontAwesomeIcon icon={faFolder} />
              <span style={{ marginLeft: 10 }}>Reconnect to "{folderName}"</span>
            </button>
            <p style={S.emptyHint}>Your browser needs permission to access this folder again.</p>
            <FolderPicker style={S.linkBtn}>Or pick a different folder</FolderPicker>
          </div>
        ) : playlist.length === 0 ? (
          <div style={S.empty}>
            <FolderPicker style={S.openBtn}>
              <FontAwesomeIcon icon={faFolder} />
              <span style={{ marginLeft: 10 }}>Open Folder</span>
            </FolderPicker>
            <p style={S.emptyHint}>
              {supportsFSAccess
                ? "This folder will be remembered next time."
                : "Select a folder containing video files"}
            </p>
          </div>
        ) : (
          <div
            ref={playerRef}
            style={{ ...S.player, cursor: showControls ? "default" : "none" }}
            onMouseMove={!isMobile ? revealControls : undefined}
            onMouseLeave={() => !isMobile && playing && hideControls()}
            onClick={handleVideoTap}
          >
            <video
              ref={videoRef}
              style={{ ...S.video, transform: `rotate(${rotation}deg)` }}
              preload="metadata"
              crossOrigin="anonymous"
              playsInline
            >
              {subtitleUrl && subtitlesOn && (
                <track kind="subtitles" src={subtitleUrl} srcLang="en" label="Subtitle" default />
              )}
            </video>

            {loading && (
              <div style={S.spinnerWrap}>
                <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
              </div>
            )}

            {/* Playlist toggle */}
            <button
              style={{ ...S.playlistToggle, opacity: showControls ? 1 : 0, width: btnSize, height: btnSize }}
              onClick={(e) => { e.stopPropagation(); setShowPlaylist((v) => !v); }}
              title="Toggle playlist (P)"
            >
              <FontAwesomeIcon icon={showPlaylist ? faChevronDown : faList} />
            </button>

            {/* Controls overlay */}
            <div style={{ ...S.overlay, opacity: showControls ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>

              {/* Title bar */}
              <div style={{ ...S.titleBar, padding: isMobile ? "12px 62px 12px 14px" : "20px 70px 20px 24px" }}>
                <span style={{ ...S.titleText, fontSize: isMobile ? 13 : 15 }}>
                  {currentEntry?.title ?? ""}
                </span>
                <FolderPicker style={{ ...S.smallBtn, width: btnSize, height: btnSize }}>
                  <FontAwesomeIcon icon={faFolder} />
                </FolderPicker>
              </div>

              {/* Centre row */}
              <div style={{ ...S.centerRow, gap: isMobile ? 20 : 32 }}>
                <button
                  style={{ ...S.iconBtn, fontSize: isMobile ? 13 : 15, padding: isMobile ? "8px 12px" : "10px 16px" }}
                  onClick={() => skip(-10)}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span style={{ marginLeft: 4, fontSize: isMobile ? 11 : 13 }}>10</span>
                </button>
                <button
                  style={{ ...S.playBig, width: playBigSize, height: playBigSize, fontSize: isMobile ? 22 : 26 }}
                  onClick={(e) => { e.stopPropagation(); playPause(); }}
                >
                  <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                </button>
                <button
                  style={{ ...S.iconBtn, fontSize: isMobile ? 13 : 15, padding: isMobile ? "8px 12px" : "10px 16px" }}
                  onClick={() => skip(10)}
                >
                  <span style={{ marginRight: 4, fontSize: isMobile ? 11 : 13 }}>10</span>
                  <FontAwesomeIcon icon={faRotateRight} />
                </button>
              </div>

              {/* Bottom bar */}
              <div style={{ padding: isMobile ? "0 12px 12px" : "0 24px 24px" }}>

                {/* Progress */}
                <div style={{ ...S.progressWrap, height: isMobile ? 20 : 16, marginBottom: isMobile ? 8 : 10 }}>
                  <div style={{ ...S.track, height: isMobile ? 5 : 4 }}>
                    <div style={{ ...S.trackFill, width: `${pct(buffered, duration)}%`, background: "rgba(255,255,255,0.3)" }} />
                    <div style={{ ...S.trackFill, width: `${pct(currentTime, duration)}%`, background: "#e50914" }} />
                  </div>
                  <input
                    type="range" min="0" max="100" step="0.1"
                    value={pct(currentTime, duration)}
                    style={S.rangeOverlay}
                    onChange={(e) => seek(Number(e.target.value) / 100)}
                  />
                </div>

                {/* Control row */}
                <div style={{ ...S.ctrlRow, gap: isMobile ? 2 : 6 }}>

                  {/* Left */}
                  <div style={{ ...S.ctrlLeft, gap: isMobile ? 4 : 8 }}>
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={(e) => { e.stopPropagation(); playPause(); }}>
                      <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                    </button>
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={goPrev}>
                      <FontAwesomeIcon icon={faBackwardStep} />
                    </button>
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={goNext}>
                      <FontAwesomeIcon icon={faForwardStep} />
                    </button>
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={toggleMute}>
                      <FontAwesomeIcon icon={muted || volume === 0 ? faVolumeXmark : volume < 0.5 ? faVolumeLow : faVolumeHigh} />
                    </button>
                    {!isMobile && (
                      <input
                        type="range" min="0" max="1" step="0.02"
                        value={muted ? 0 : volume}
                        style={{ width: 70, accentColor: "#fff", cursor: "pointer" }}
                        onChange={(e) => handleVolume(Number(e.target.value))}
                      />
                    )}
                    <span style={{ ...S.timeText, fontSize: isMobile ? 10 : 12 }}>
                      {fmt(currentTime)} / {fmt(duration)}
                    </span>
                  </div>

                  {/* Right */}
                  <div style={{ ...S.ctrlRight, gap: isMobile ? 2 : 6 }}>

                    {/* Screenshot */}
                    <div style={{ position: "relative" }}>
                      <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={takeScreenshot} title="Screenshot">
                        <FontAwesomeIcon icon={faCamera} />
                      </button>
                      {shotUrl && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <img src={shotUrl} alt="screenshot" style={S.shotPreview} />
                          <button style={S.popItem} onClick={downloadShot}>
                            <FontAwesomeIcon icon={faDownload} /><span style={{ marginLeft: 8 }}>Download</span>
                          </button>
                          <button style={S.popItem} onClick={() => setShotUrl(null)}>
                            <FontAwesomeIcon icon={faXmark} /><span style={{ marginLeft: 8 }}>Close</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Share last 30s */}
                    <div style={{ position: "relative" }}>
                      <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={() => setShowShareMenu((v) => !v)} title="Share last 30s">
                        <FontAwesomeIcon icon={faShareNodes} />
                      </button>
                      {showShareMenu && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <div style={S.popLabel}>Share last {CLIP_SECONDS}s</div>
                          {clipBusy && (
                            <div style={{ ...S.popLabel, display: "flex", alignItems: "center", gap: 6 }}>
                              <FontAwesomeIcon icon={faSpinner} spin />Preparing clip…
                            </div>
                          )}
                          <button style={S.popItem} onClick={() => shareClip("whatsapp")}>
                            <FontAwesomeIcon icon={faWhatsapp} /><span style={{ marginLeft: 8 }}>WhatsApp</span>
                          </button>
                          <button style={S.popItem} onClick={() => shareClip("facebook")}>
                            <FontAwesomeIcon icon={faFacebook} /><span style={{ marginLeft: 8 }}>Facebook</span>
                          </button>
                          <button style={S.popItem} onClick={() => shareClip("tiktok")}>
                            <FontAwesomeIcon icon={faTiktok} /><span style={{ marginLeft: 8 }}>TikTok</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Subtitles */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize, opacity: subtitleUrl ? 1 : 0.55 }}
                        onClick={() => setShowSubMenu((v) => !v)}
                        title="Subtitles"
                      >
                        <FontAwesomeIcon icon={faClosedCaptioning} />
                      </button>
                      {showSubMenu && (
                        <div style={{ ...(isMobile ? S.popMenuMobile : S.popMenu), width: isMobile ? "auto" : 280 }}>
                          <div style={S.popLabel}>Subtitles</div>
                          {subtitleUrl && (
                            <button style={S.popItem} onClick={() => setSubtitlesOn((v) => !v)}>
                              <FontAwesomeIcon icon={subtitlesOn ? faCheck : faClosedCaptioning} />
                              <span style={{ marginLeft: 8 }}>{subtitlesOn ? "Enabled" : "Disabled"}</span>
                            </button>
                          )}
                          <label style={S.popItem}>
                            <FontAwesomeIcon icon={faFilm} />
                            <span style={{ marginLeft: 8 }}>Upload .srt / .vtt</span>
                            <input type="file" accept=".srt,.vtt" hidden onChange={loadLocalSubtitle} />
                          </label>
                          <div style={S.popDivider} />
                          <div style={S.popLabel}>OpenSubtitles Search</div>
                          <button style={S.popItem} onClick={searchSubtitles} disabled={subSearching}>
                            <FontAwesomeIcon icon={subSearching ? faSpinner : faMagnifyingGlass} spin={subSearching} />
                            <span style={{ marginLeft: 8 }}>Search "{currentEntry?.title}"</span>
                          </button>
                          {subError && <div style={S.subError}>{subError}</div>}
                          {subResults.map((r) => (
                            <button key={r.id} style={S.popItem} onClick={() => downloadSubtitle(r)}>
                              <FontAwesomeIcon icon={faDownload} />
                              <span style={{ marginLeft: 8 }}>
                                {r.attributes?.release || r.attributes?.feature_details?.title || "Subtitle"}
                                <span style={{ opacity: 0.5, marginLeft: 4 }}>({r.attributes?.language})</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Rotate */}
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={rotate} title="Rotate">
                      <FontAwesomeIcon icon={faRepeat} />
                    </button>

                    {/* Audio converter */}
                    <button
                      style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }}
                      onClick={() => { setShowConverter(true); if (convertStatus === "idle") {} }}
                      title="Extract Audio (WAV)"
                    >
                      <FontAwesomeIcon icon={faMusic} />
                    </button>

                    {/* Quality */}
                    {currentEntry?.sources.length > 1 && (
                      <div style={{ position: "relative" }}>
                        <button
                          style={{ ...S.ctrlBtn, fontSize: isMobile ? 9 : 10, width: btnSize, height: btnSize, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}
                          onClick={() => setShowQualityMenu((v) => !v)}
                          title="Quality"
                        >
                          {activeQuality}
                        </button>
                        {showQualityMenu && (
                          <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                            <div style={S.popLabel}>Quality</div>
                            {currentEntry.sources.map((s) => (
                              <button
                                key={s.quality}
                                style={{ ...S.popItem, fontWeight: s.quality === activeQuality ? 700 : 400 }}
                                onClick={() => { autoplayNextRef.current = playing; setActiveQuality(s.quality); setShowQualityMenu(false); }}
                              >
                                <FontAwesomeIcon icon={s.quality === activeQuality ? faCheck : faFilm} />
                                <span style={{ marginLeft: 8 }}>{s.quality}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Speed */}
                    <div style={{ position: "relative" }}>
                      <button style={{ ...S.ctrlBtn, fontSize: isMobile ? 9 : 11, width: btnSize, height: btnSize }} onClick={() => setShowSettings((v) => !v)}>
                        <FontAwesomeIcon icon={faGear} />
                      </button>
                      {showSettings && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <div style={S.popLabel}>Playback Speed</div>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                            <button key={s} style={{ ...S.popItem, fontWeight: playbackRate === s ? 700 : 400 }} onClick={() => changeSpeed(s)}>
                              <FontAwesomeIcon icon={playbackRate === s ? faCheck : faGear} />
                              <span style={{ marginLeft: 8 }}>{s}×</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Fullscreen */}
                    <button style={{ ...S.ctrlBtn, fontSize: ctrlFontSize, width: btnSize, height: btnSize }} onClick={toggleFullscreen} title="Fullscreen (F)">
                      <FontAwesomeIcon icon={fullscreen ? faCompress : faExpand} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Playlist ── */}
      {playlist.length > 0 && (
        <div style={sidebarStyle}>
          {isMobile && (
            <div style={S.dragHandle} onClick={() => setShowPlaylist((v) => !v)}>
              <div style={S.dragHandlePill} />
            </div>
          )}
          <div style={{ ...S.sidebarHead, padding: isMobile ? "10px 16px" : "24px 20px 16px" }}>
            <FontAwesomeIcon icon={faList} style={{ color: "rgba(255,255,255,0.4)", marginRight: 8 }} />
            <span style={S.sidebarTitle}>Playlist</span>
            <span style={S.sidebarCount}>{playlist.length} videos</span>
            <button style={S.sidebarClose} onClick={() => setShowPlaylist(false)}>
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
          <div style={S.sidebarList}>
            {playlist.map((p, i) => (
              <div
                key={p.id}
                style={{ ...S.item, ...(i === currentIndex ? S.itemActive : {}), padding: isMobile ? "8px 14px" : "10px 20px", gap: isMobile ? 10 : 12 }}
                onClick={() => { playEntry(i); if (isMobile) setShowPlaylist(false); }}
              >
                <div style={{ ...S.thumbWrap, width: isMobile ? 64 : 80, height: isMobile ? 36 : 45 }}>
                  {p.thumb
                    ? <img src={p.thumb} alt={p.title} style={S.thumbImg} />
                    : <div style={S.thumbPlaceholder}><FontAwesomeIcon icon={faFilm} /></div>
                  }
                  {i === currentIndex && (
                    <div style={S.nowPlayingBadge}>
                      <FontAwesomeIcon icon={playing ? faPause : faPlay} style={{ fontSize: 9 }} />
                    </div>
                  )}
                </div>
                <div style={S.itemBody}>
                  <div style={{ ...S.itemTitle, color: i === currentIndex ? "#e50914" : "#eee", fontSize: isMobile ? 12 : 13 }}>
                    {p.title}
                  </div>
                  <div style={S.itemMeta}>
                    {p.sources.map((s) => s.quality).join(" · ")} · {(p.sources[0].size / 1048576).toFixed(1)} MB
                  </div>
                </div>
              </div>
            ))}
          </div>
          <FolderPicker style={{ ...S.changeFolder, margin: isMobile ? "8px 14px 14px" : "12px 20px 20px" }}>
            <FontAwesomeIcon icon={faFolder} />
            <span style={{ marginLeft: 8 }}>Change Folder</span>
          </FolderPicker>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────
const S = {
  root: {
    display: "flex", width: "100%", height: "100dvh",
    background: "var(--bg-main, #0f0f0f)",
    fontFamily: "var(--font-body, system-ui, sans-serif)",
    overflow: "hidden", color: "var(--text-main, #fff)",
    userSelect: "none", WebkitUserSelect: "none",
  },
  main: {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    background: "#000", position: "relative", minWidth: 0, minHeight: 0,
  },
  empty: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 20, padding: "0 24px", textAlign: "center",
  },
  openBtn: {
    display: "inline-flex", alignItems: "center",
    padding: "14px 32px", borderRadius: "var(--radius-md, 10px)",
    background: "var(--primary-color, #3390ec)", color: "#fff",
    fontSize: 15, fontWeight: 600, cursor: "pointer", border: "none",
    boxShadow: "0 4px 14px rgba(51,144,236,0.3)",
    WebkitTapHighlightColor: "transparent",
  },
  linkBtn: {
    background: "none", border: "none", color: "rgba(255,255,255,0.45)",
    fontSize: 13, textDecoration: "underline", cursor: "pointer",
  },
  emptyHint: { color: "rgba(255,255,255,0.4)", fontSize: 13, margin: 0, maxWidth: 260 },
  player: {
    position: "relative", width: "100%", height: "100%",
    background: "#000", overflow: "hidden",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  video: {
    position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
    objectFit: "contain", background: "#000", display: "block",
    zIndex: 1, transition: "transform 0.3s ease",
  },
  spinnerWrap: {
    position: "absolute", inset: 0, display: "flex",
    alignItems: "center", justifyContent: "center",
    zIndex: 2, pointerEvents: "none",
  },
  overlay: {
    position: "absolute", inset: 0, zIndex: 3,
    display: "flex", flexDirection: "column", justifyContent: "space-between",
    background: "linear-gradient(to bottom,rgba(0,0,0,0.55) 0%,transparent 25%,transparent 75%,rgba(0,0,0,0.78) 100%)",
    transition: "opacity 0.3s cubic-bezier(0.25,1,0.5,1)", cursor: "default",
  },
  playlistToggle: {
    position: "absolute", top: 12, right: 14, zIndex: 4,
    borderRadius: "50%", background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.1)", color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
    transition: "opacity 0.3s, background 0.2s",
    WebkitTapHighlightColor: "transparent",
  },
  titleBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
  },
  titleText: {
    color: "#fff", fontWeight: 500, flex: 1,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  smallBtn: {
    borderRadius: "50%", background: "rgba(255,255,255,0.12)",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", flexShrink: 0,
    backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
    border: "1px solid rgba(255,255,255,0.1)",
    WebkitTapHighlightColor: "transparent",
  },
  centerRow: {
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  iconBtn: {
    background: "none", border: "none", color: "#fff",
    cursor: "pointer", display: "flex", alignItems: "center",
    borderRadius: 8, WebkitTapHighlightColor: "transparent",
  },
  playBig: {
    borderRadius: "50%", background: "rgba(255,255,255,0.18)",
    border: "1px solid rgba(255,255,255,0.28)", color: "#fff",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
    WebkitTapHighlightColor: "transparent", flexShrink: 0,
  },
  progressWrap: { position: "relative", cursor: "pointer" },
  track: {
    position: "absolute", left: 0, right: 0, top: "50%",
    transform: "translateY(-50%)", borderRadius: 3, overflow: "hidden",
    background: "rgba(255,255,255,0.2)",
  },
  trackFill: {
    position: "absolute", left: 0, top: 0, height: "100%",
    borderRadius: 3, transition: "width 0.1s linear",
  },
  rangeOverlay: {
    position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
    opacity: 0, cursor: "pointer", margin: 0,
  },
  ctrlRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  ctrlLeft: { display: "flex", alignItems: "center" },
  ctrlRight: { display: "flex", alignItems: "center" },
  ctrlBtn: {
    background: "none", border: "none", color: "#fff",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 8, lineHeight: 1,
    WebkitTapHighlightColor: "transparent", flexShrink: 0,
  },
  timeText: {
    color: "rgba(255,255,255,0.65)", fontVariantNumeric: "tabular-nums",
    fontWeight: 500, whiteSpace: "nowrap",
  },
  popMenu: {
    position: "absolute", bottom: "115%", right: 0,
    background: "rgba(14,20,32,0.96)", backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12, padding: "8px 0", zIndex: 20, minWidth: 180, maxWidth: "90vw",
    boxShadow: "0 12px 40px rgba(0,0,0,0.65)",
  },
  popMenuMobile: {
    position: "absolute", bottom: "115%", right: 0,
    background: "rgba(14,20,32,0.97)", backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12, padding: "8px 0", zIndex: 20,
    minWidth: 210, maxWidth: "88vw", maxHeight: "42vh", overflowY: "auto",
    boxShadow: "0 12px 40px rgba(0,0,0,0.75)",
  },
  popItem: {
    display: "flex", alignItems: "center",
    width: "100%", padding: "12px 16px", textAlign: "left",
    background: "none", border: "none", color: "#fff",
    fontSize: 13, fontWeight: 500, cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  popLabel: {
    padding: "4px 16px 6px", fontSize: 10,
    color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.8px",
  },
  popDivider: { height: 1, background: "rgba(255,255,255,0.07)", margin: "4px 0" },
  shotPreview: { width: "100%", borderRadius: "8px 8px 0 0", display: "block" },
  subError: { padding: "6px 16px", fontSize: 11, color: "#f87171", lineHeight: 1.5 },
  // Sidebar / bottom sheet
  sidebar: {
    display: "flex", flexDirection: "column",
    background: "var(--bg-nav, #111)",
    borderLeft: "1px solid rgba(255,255,255,0.06)", flexShrink: 0,
    transition: "margin-right 0.3s cubic-bezier(0.25,1,0.5,1), opacity 0.3s",
  },
  dragHandle: {
    display: "flex", alignItems: "center", justifyContent: "center",
    paddingTop: 10, paddingBottom: 4, cursor: "pointer",
  },
  dragHandlePill: {
    width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)",
  },
  sidebarHead: {
    display: "flex", alignItems: "center", gap: 8,
    borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0,
  },
  sidebarTitle: { color: "#fff", fontWeight: 600, fontSize: 14, flex: 1 },
  sidebarCount: { color: "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 500 },
  sidebarClose: {
    background: "none", border: "none", color: "rgba(255,255,255,0.4)",
    fontSize: 14, cursor: "pointer", padding: 6,
    WebkitTapHighlightColor: "transparent",
  },
  sidebarList: { flex: 1, overflowY: "auto", padding: "8px 0" },
  item: {
    display: "flex", alignItems: "center", cursor: "pointer",
    borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: "transparent",
    WebkitTapHighlightColor: "transparent",
  },
  itemActive: {
    background: "rgba(51,144,236,0.1)",
    borderLeftColor: "var(--primary-color, #3390ec)",
  },
  thumbWrap: {
    position: "relative", borderRadius: 6, overflow: "hidden",
    flexShrink: 0, background: "rgba(255,255,255,0.06)",
  },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbPlaceholder: {
    width: "100%", height: "100%",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "rgba(255,255,255,0.25)", fontSize: 16,
  },
  nowPlayingBadge: {
    position: "absolute", inset: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,0.52)", color: "#e50914",
  },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: {
    fontWeight: 500, overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3,
  },
  itemMeta: {
    color: "rgba(255,255,255,0.35)", fontSize: 10,
    fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.3px",
  },
  changeFolder: {
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 12, borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "rgba(255,255,255,0.45)", fontSize: 13, fontWeight: 500,
    cursor: "pointer", flexShrink: 0,
    WebkitTapHighlightColor: "transparent",
  },
  // ── Audio converter modal ──
  modalBackdrop: {
    position: "fixed", inset: 0, zIndex: 100,
    background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 16,
  },
  modal: {
    width: "100%", maxWidth: 480,
    background: "rgba(14,20,32,0.98)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 16, overflow: "hidden",
    boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
  },
  modalHead: {
    display: "flex", alignItems: "center",
    padding: "18px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)",
  },
  modalTitle: { flex: 1, fontSize: 15, fontWeight: 600, color: "#fff" },
  modalClose: {
    background: "none", border: "none", color: "rgba(255,255,255,0.45)",
    fontSize: 16, cursor: "pointer", padding: 4,
    WebkitTapHighlightColor: "transparent",
  },
  modalBody: { padding: "20px" },
  converterInfo: {
    display: "flex", alignItems: "center",
    padding: "10px 14px", borderRadius: 8,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.07)",
    marginBottom: 16, overflow: "hidden",
  },
  converterProgress: { marginBottom: 16 },
  converterBar: {
    height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)",
    overflow: "hidden", marginBottom: 8,
  },
  converterFill: {
    height: "100%", borderRadius: 3,
    transition: "width 0.4s ease, background 0.3s ease",
  },
  converterLabel: {
    fontSize: 12, display: "flex", alignItems: "center",
  },
  converterNote: {
    fontSize: 12, color: "rgba(255,255,255,0.4)",
    lineHeight: 1.6, margin: "0 0 20px", padding: 0,
  },
  converterActions: {
    display: "flex", flexWrap: "wrap", gap: 10,
  },
  converterBtn: {
    display: "inline-flex", alignItems: "center",
    padding: "11px 20px", borderRadius: 8,
    background: "var(--primary-color, #3390ec)", color: "#fff",
    fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
};