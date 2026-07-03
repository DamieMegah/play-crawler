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
  faEllipsisVertical,
  faCircleInfo,
  faStamp,
  faHdd,
  faClock,
  faCalendar,
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

// ─────────────────────────────────────────────────────────────────────────────
// ADJUSTMENT POINT 1 — Navbar / bottom-bar heights
//
// Set these to match whatever your parent layout uses.
// They are used in TWO places:
//   • S.root height  (subtracts both so the player fits between them)
//   • sidebarStyle bottom offset on mobile (so the sheet sits above the bottom bar)
//
// If your navbar is 56 px and you have no bottom bar, set:
//   NAVBAR_H   = 56
//   BOTTOMBAR_H = 0
//
// If you use CSS variables in your app (e.g. --navbar-height), you can replace
// the pixel values with `"var(--navbar-height)"` etc. — but then also change
// the calc() strings below to match.
// ─────────────────────────────────────────────────────────────────────────────
const NAVBAR_H = 60; // px — height of your top navbar
const BOTTOMBAR_H = 56; // px — height of your bottom tab-bar (0 if none)

const supportsFSAccess =
  typeof window !== "undefined" && "showDirectoryPicker" in window;
const QUALITY_RE = /\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i;

function useWindowWidth() {
  const [w, setW] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  useEffect(() => {
    const fn = () => setW(window.innerWidth);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return w;
}

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

function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
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
  // Cancellation signal for the restore-last-folder flow.
  // Set to a new AbortController at restore start; .abort() kills it mid-flight.
  const restoreAbortRef = useRef(null);

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
  const [showConverter, setShowConverter] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [convertStatus, setConvertStatus] = useState("idle");
  const [convertedUrl, setConvertedUrl] = useState(null);
  const [convertedName, setConvertedName] = useState("");

  // ── Playlist item three-dot menu ──
  const [itemMenuId, setItemMenuId] = useState(null); // playlist entry id with open menu
  const [detailEntry, setDetailEntry] = useState(null); // entry shown in detail modal
  const [shareEntry, setShareEntry] = useState(null); // entry being shared (with watermark)
  const [shareStep, setShareStep] = useState("idle"); // idle | building | done | error
  const [shareUrl, setShareUrl] = useState(null);
  const [watermarkText, setWatermarkText] = useState("My Video Player");

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

  useEffect(() => {
    return () => {
      playlist.forEach((p) => {
        p.sources.forEach((s) => URL.revokeObjectURL(s.url));
        if (p.thumb) URL.revokeObjectURL(p.thumb);
      });
    };
  }, [playlist]);

  const buildPlaylist = async (files, signal) => {
    const sorted = [...files]
      .filter((f) => f.type.startsWith("video/"))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    const groups = new Map();
    for (const file of sorted) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rawName = file.name.replace(/\.[^/.]+$/, "");
      const qMatch = rawName.match(QUALITY_RE);
      const quality = qMatch ? qMatch[0].toLowerCase() : "source";
      const baseTitle =
        rawName
          .replace(QUALITY_RE, "")
          .replace(/[\s._-]+$/, "")
          .trim() || rawName;
      const url = URL.createObjectURL(file);
      if (!groups.has(baseTitle))
        groups.set(baseTitle, {
          id: crypto.randomUUID(),
          title: baseTitle,
          sources: [],
          thumb: null,
        });
      groups
        .get(baseTitle)
        .sources.push({ quality, url, file, size: file.size });
    }
    const entries = [...groups.values()];
    // Generate thumbs one-by-one so we can abort between them
    for (const e of entries) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await generateThumb(e);
    }
    return entries;
  };

  const generateThumb = (entry) =>
    new Promise((resolve) => {
      try {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "metadata";
        v.src = entry.sources[0].url;
        const cleanup = () => {
          v.removeAttribute("src");
          v.load();
        };
        v.addEventListener("loadeddata", () => {
          v.currentTime = Math.min(2, (v.duration || 4) / 4);
        });
        v.addEventListener("seeked", () => {
          try {
            const c = document.createElement("canvas");
            c.width = 320;
            c.height = Math.round(
              (320 * (v.videoHeight || 9)) / (v.videoWidth || 16),
            );
            c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
            c.toBlob(
              (blob) => {
                entry.thumb = blob ? URL.createObjectURL(blob) : null;
                cleanup();
                resolve();
              },
              "image/jpeg",
              0.7,
            );
          } catch {
            cleanup();
            resolve();
          }
        });
        v.addEventListener("error", () => {
          cleanup();
          resolve();
        });
      } catch {
        resolve();
      }
    });

  const readDirHandle = async (handle, signal) => {
    const files = [];
    for await (const entry of handle.values()) {
      // Bail out immediately if user cancelled
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (file.type.startsWith("video/")) files.push(file);
      }
    }
    return files;
  };

  // cancelRestore — called by the "Select New Folder" button shown during restore.
  // Aborts the in-flight async chain instantly; no more file reads or thumb
  // generation will run after this, and all blob URLs created so far are revoked.
  const cancelRestore = () => {
    restoreAbortRef.current?.abort();
    setRestoring(false);
    setNeedsReconnect(false);
    setFolderName("");
    dirHandleRef.current = null;
    // Clear the stored handle so we never auto-restore this folder again
    idbSet(DB_KEY, null).catch(() => {});
  };

  useEffect(() => {
    if (!supportsFSAccess) return setRestoring(false);

    // Fresh controller for this restore attempt
    const ctrl = new AbortController();
    restoreAbortRef.current = ctrl;
    const { signal } = ctrl;

    (async () => {
      try {
        const handle = await idbGet(DB_KEY);
        if (!handle || signal.aborted) return setRestoring(false);

        dirHandleRef.current = handle;
        setFolderName(handle.name);

        const perm = await handle.queryPermission({ mode: "read" });
        if (signal.aborted) return;

        if (perm === "granted") {
          // Pass the signal into every async step so they stop the moment
          // the user clicks "Select New Folder"
          const files = await readDirHandle(handle, signal);
          if (signal.aborted) return;

          if (files.length) {
            const entries = await buildPlaylist(files, signal);
            if (signal.aborted) {
              // Revoke any blob URLs that were created before the abort
              entries.forEach((e) => {
                e.sources.forEach((s) => URL.revokeObjectURL(s.url));
                if (e.thumb) URL.revokeObjectURL(e.thumb);
              });
              return;
            }
            setPlaylist(entries);
            setCurrentIndex(0);
            setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
          }
        } else {
          if (!signal.aborted) setNeedsReconnect(true);
        }
      } catch (err) {
        if (err.name !== "AbortError") console.error("Restore error:", err);
        // AbortError is expected — silently swallow it
      } finally {
        if (!signal.aborted) setRestoring(false);
      }
    })();

    // If the component unmounts mid-restore, abort automatically
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    const t = video.currentTime;
    video.src = currentSource.url;
    video.load();
    if (!autoplayNextRef.current) {
      setPlaying(false);
      setCurrentTime(0);
    } else {
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = t;
        },
        { once: true },
      );
    }
    setDuration(0);
    setBuffered(0);
    setShowConverter(false);
    setConvertStatus("idle");
    setConvertProgress(0);
    if (convertedUrl) {
      URL.revokeObjectURL(convertedUrl);
      setConvertedUrl(null);
    }
  }, [currentSource?.url]);

  useEffect(() => {
    setSubResults([]);
    setSubError("");
  }, [currentIndex]);

  useEffect(() => {
    if (!autoplayNextRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => {
      video.play().catch(() => {});
      autoplayNextRef.current = false;
    };
    video.addEventListener("loadedmetadata", onReady, { once: true });
    return () => video.removeEventListener("loadedmetadata", onReady);
  }, [currentIndex]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      setDuration(video.duration);
      setLoading(false);
    };
    const onWait = () => setLoading(true);
    const onPlay = () => {
      setLoading(false);
      setPlaying(true);
      setShowPlaylist(false);
    };
    const onPause = () => setPlaying(false);
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length)
        setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onEnded = () => {
      setCurrentIndex((prev) => {
        if (prev < playlist.length - 1) {
          autoplayNextRef.current = true;
          return prev + 1;
        }
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

  const loadSingleVideo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const entries = await buildPlaylist([file]);

    setPlaylist(entries);
    setCurrentIndex(0);
    setActiveQuality(entries[0]?.sources[0]?.quality ?? null);
    setFolderName(file.name);
    setNeedsReconnect(false);

    // Allows selecting the same file again later
    e.target.value = "";
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    let alive = true;
    const stop = () => {
      if (recorderRef.current?.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {}
      }
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
          chunkBufferRef.current = chunkBufferRef.current.filter(
            (c) => c.t >= cutoff,
          );
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
    const c = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return c.find((m) => MediaRecorder.isTypeSupported?.(m)) || "video/webm";
  }

  useEffect(() => {
    const fn = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const fn = (e) => {
      if (e.target.tagName === "INPUT") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          playPause();
          break;
        case "ArrowLeft":
          skip(-10);
          break;
        case "ArrowRight":
          skip(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          handleVolume(Math.min(volume + 0.1, 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          handleVolume(Math.max(volume - 0.1, 0));
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "p":
        case "P":
          setShowPlaylist((v) => !v);
          break;
        case "n":
        case "N":
          goNext();
          break;
        case "c":
        case "C":
          takeScreenshot();
          break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [volume, currentIndex, playlist.length, isMobile]);

  // Close the three-dot menu on any outside click
  useEffect(() => {
    if (!itemMenuId) return;
    const fn = () => setItemMenuId(null);
    window.addEventListener("click", fn);
    return () => window.removeEventListener("click", fn);
  }, [itemMenuId]);

  const hideControls = useCallback(() => {
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(
      () => setShowControls(false),
      AUTO_HIDE_DELAY,
    );
  }, []);
  const revealControls = () => {
    setShowControls(true);
    if (playing) hideControls();
  };

  const handleVideoTap = (e) => {
    if (isMobile) {
      e.stopPropagation();
      if (showControls) setShowControls(false);
      else {
        setShowControls(true);
        hideControls();
      }
    } else {
      playPause();
    }
  };

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

  const playPause = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play();
    else video.pause();
  };
  const skip = (s) => {
    if (videoRef.current) videoRef.current.currentTime += s;
  };
  const seek = (p) => {
    if (videoRef.current) videoRef.current.currentTime = p * duration;
  };
  const handleVolume = (v) => {
    if (!videoRef.current) return;
    videoRef.current.volume = v;
    setVolume(v);
    setMuted(v === 0);
  };
  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
  };
  const changeSpeed = (s) => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = s;
    setPlaybackRate(s);
    setShowSettings(false);
  };
  const toggleFullscreen = async () => {
    if (!document.fullscreenElement)
      await playerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };
  const playEntry = (i) => {
    autoplayNextRef.current = true;
    setRotation(0);
    setCurrentIndex(i);
    setActiveQuality(playlist[i]?.sources[0]?.quality ?? null);
  };
  const goNext = () => {
    if (currentIndex < playlist.length - 1) playEntry(currentIndex + 1);
  };
  const goPrev = () => {
    if (currentIndex > 0) playEntry(currentIndex - 1);
  };
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

  const takeScreenshot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const c = canvasRef.current;
    c.width = video.videoWidth;
    c.height = video.videoHeight;
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

  const buildClip = async () => {
    setClipBusy(true);
    try {
      if (recorderRef.current?.state === "recording") {
        await new Promise((resolve) => {
          recorderRef.current.addEventListener("dataavailable", resolve, {
            once: true,
          });
          recorderRef.current.requestData();
        });
      }
      const cutoff = Date.now() - CLIP_SECONDS * 1000;
      const chunks = chunkBufferRef.current
        .filter((c) => c.t >= cutoff)
        .map((c) => c.blob);
      if (!chunks.length) {
        setClipBusy(false);
        return null;
      }
      const blob = new Blob(chunks, { type: chunks[0].type || "video/webm" });
      setClipBlob(blob);
      return blob;
    } finally {
      setClipBusy(false);
    }
  };

  const shareClip = async (target) => {
    const blob = clipBlob || (await buildClip());
    if (!blob) return;
    const fileName = `${(currentEntry?.title || "clip").replace(/\s+/g, "_")}.webm`;
    const file = new File([blob], fileName, { type: blob.type });
    const text = `Check out this clip from "${currentEntry?.title || "this video"}"`;
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          text,
          title: currentEntry?.title,
        });
        return;
      } catch {}
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    if (target === "whatsapp")
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    else if (target === "facebook")
      window.open(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`,
        "_blank",
      );
    else if (target === "tiktok")
      window.open("https://www.tiktok.com/upload", "_blank");
  };

  // ── Watermark helpers ──────────────────────────────────────────────────────
  // Draws watermark text onto every frame of a canvas using OffscreenCanvas +
  // MediaRecorder. Works on the raw video file via a hidden <video> element
  // so it works even when the video is NOT currently playing.
  const buildWatermarkedClip = async (entry, clipBlobIn) => {
    // If a clip blob is provided (last-30s share), watermark that;
    // otherwise watermark the raw source file (full-video share).
    const sourceBlob = clipBlobIn ? clipBlobIn : entry.sources[0].file;

    const url = clipBlobIn
      ? URL.createObjectURL(clipBlobIn)
      : entry.sources[0].url;
    const needRevoke = !!clipBlobIn;

    return new Promise((resolve, reject) => {
      const vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.src = url;
      vid.crossOrigin = "anonymous";

      vid.addEventListener("loadedmetadata", async () => {
        const W = vid.videoWidth || 640;
        const H = vid.videoHeight || 360;

        // OffscreenCanvas for drawing frames + watermark text
        const canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext("2d");

        const stream = canvas.captureStream(30);
        const mime =
          [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ].find((m) => MediaRecorder.isTypeSupported?.(m)) || "video/webm";
        const rec = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
        rec.onstop = () => {
          if (needRevoke) URL.revokeObjectURL(url);
          resolve(new Blob(chunks, { type: mime }));
        };
        rec.onerror = () => {
          if (needRevoke) URL.revokeObjectURL(url);
          reject(new Error("rec error"));
        };

        rec.start(500);

        const drawFrame = () => {
          if (vid.paused || vid.ended) {
            rec.stop();
            return;
          }
          ctx.drawImage(vid, 0, 0, W, H);

          // Watermark — bottom-right corner, semi-transparent
          const fsize = Math.max(14, Math.round(W * 0.03));
          ctx.font = `bold ${fsize}px sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          // Shadow for readability on any background
          ctx.shadowColor = "rgba(0,0,0,0.8)";
          ctx.shadowBlur = 6;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillText(watermarkText, W - 16, H - 14);
          ctx.shadowBlur = 0;

          requestAnimationFrame(drawFrame);
        };

        vid.addEventListener("play", drawFrame, { once: true });
        vid.play().catch(reject);
      });

      vid.addEventListener("error", reject);
    });
  };

  // Share an entry's full video (with watermark) from the three-dot menu
  const shareEntryVideo = async (entry, target) => {
    setShareEntry(entry);
    setShareStep("building");
    setShareUrl(null);
    try {
      const watermarked = await buildWatermarkedClip(entry, null);
      const blobUrl = URL.createObjectURL(watermarked);
      setShareUrl(blobUrl);
      setShareStep("done");

      const fileName = `${(entry.title || "video").replace(/\s+/g, "_")}_watermarked.webm`;
      const file = new File([watermarked], fileName, {
        type: watermarked.type,
      });
      const text = `Check out "${entry.title}"`;

      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text, title: entry.title });
          return;
        } catch {}
      }
      // Desktop fallback: download + open platform
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      if (target === "whatsapp")
        window.open(
          `https://wa.me/?text=${encodeURIComponent(text)}`,
          "_blank",
        );
      else if (target === "facebook")
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`,
          "_blank",
        );
      else if (target === "tiktok")
        window.open("https://www.tiktok.com/upload", "_blank");
    } catch (err) {
      console.error("Watermark share failed:", err);
      setShareStep("error");
    }
  };

  // Share the last-30s clip (with watermark) — upgraded version of shareClip
  const shareClipWatermarked = async (target) => {
    const raw = clipBlob || (await buildClip());
    if (!raw) return;
    setShareEntry(currentEntry);
    setShareStep("building");
    try {
      const watermarked = await buildWatermarkedClip(currentEntry, raw);
      const blobUrl = URL.createObjectURL(watermarked);
      setShareUrl(blobUrl);
      setShareStep("done");

      const fileName = `${(currentEntry?.title || "clip").replace(/\s+/g, "_")}_clip.webm`;
      const file = new File([watermarked], fileName, {
        type: watermarked.type,
      });
      const text = `Check out this clip from "${currentEntry?.title || "this video"}"`;

      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            text,
            title: currentEntry?.title,
          });
          return;
        } catch {}
      }
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      if (target === "whatsapp")
        window.open(
          `https://wa.me/?text=${encodeURIComponent(text)}`,
          "_blank",
        );
      else if (target === "facebook")
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`,
          "_blank",
        );
      else if (target === "tiktok")
        window.open("https://www.tiktok.com/upload", "_blank");
    } catch (err) {
      console.error("Clip watermark share failed:", err);
      setShareStep("error");
    }
  };

  // Audio convert from a specific playlist entry (not just the current one)
  const convertEntryToAudio = async (entry) => {
    // Switch to that entry first so the converter modal shows its name
    const idx = playlist.indexOf(entry);
    if (idx !== -1) setCurrentIndex(idx);
    setShowConverter(true);
    setConvertStatus("decoding");
    setConvertProgress(0);
    if (convertedUrl) {
      URL.revokeObjectURL(convertedUrl);
      setConvertedUrl(null);
    }
    try {
      const src = entry.sources[0];
      const arrayBuf = await src.file.arrayBuffer();
      setConvertProgress(20);
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      audioCtx.close();
      setConvertProgress(60);
      setConvertStatus("encoding");
      const wavBlob = audioBufferToWav(audioBuf);
      setConvertProgress(95);
      const url = URL.createObjectURL(wavBlob);
      setConvertedUrl(url);
      setConvertedName(`${entry.title || "audio"}.wav`);
      setConvertProgress(100);
      setConvertStatus("done");
    } catch (err) {
      console.error("Audio conversion failed:", err);
      setConvertStatus("error");
    }
  };

  const loadLocalSubtitle = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const vtt = file.name.toLowerCase().endsWith(".srt")
      ? srtToVtt(text)
      : text;
    const blob = new Blob([vtt], { type: "text/vtt" });
    if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
    const url = URL.createObjectURL(blob);
    trackUrlRef.current = url;
    setSubtitleUrl(url);
    setSubtitlesOn(true);
    setShowSubMenu(false);
  };

  const searchSubtitles = async () => {
    if (!currentEntry) return;
    if (!osKey) {
      setSubError("OpenSubtitles API key not configured.");
      return;
    }
    setSubSearching(true);
    setSubError("");
    setSubResults([]);
    try {
      const res = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(currentEntry.title)}&languages=en`,
        {
          headers: {
            "Api-Key": osKey,
            "User-Agent": "react-video-player v1.0",
          },
        },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setSubResults((data.data || []).slice(0, 8));
      if (!data.data?.length) setSubError("No subtitles found for this title.");
    } catch {
      setSubError(
        "Could not reach OpenSubtitles. Upload a local .srt/.vtt instead.",
      );
    } finally {
      setSubSearching(false);
    }
  };

  const downloadSubtitle = async (item) => {
    setSubError("");
    try {
      const fileId = item.attributes?.files?.[0]?.file_id;
      if (!fileId) throw new Error("No file id");
      const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
        method: "POST",
        headers: {
          "Api-Key": osKey,
          "Content-Type": "application/json",
          "User-Agent": "react-video-player v1.0",
        },
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      const fileRes = await fetch(json.link);
      const text = await fileRes.text();
      const vtt = json.link.toLowerCase().endsWith(".srt")
        ? srtToVtt(text)
        : text;
      const blob = new Blob([vtt], { type: "text/vtt" });
      if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
      const url = URL.createObjectURL(blob);
      trackUrlRef.current = url;
      setSubtitleUrl(url);
      setSubtitlesOn(true);
      setShowSubMenu(false);
    } catch {
      setSubError(
        "Couldn't download that subtitle. Try another or upload manually.",
      );
    }
  };

  const convertToAudio = async () => {
    if (!currentSource) return;
    setShowConverter(true);
    setConvertStatus("decoding");
    setConvertProgress(0);
    if (convertedUrl) {
      URL.revokeObjectURL(convertedUrl);
      setConvertedUrl(null);
    }
    try {
      const arrayBuf = await currentSource.file.arrayBuffer();
      setConvertProgress(20);
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      setConvertStatus("decoding");
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      audioCtx.close();
      setConvertProgress(60);
      setConvertStatus("encoding");
      const wavBlob = audioBufferToWav(audioBuf);
      setConvertProgress(95);
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
    a.href = convertedUrl;
    a.download = convertedName;
    a.click();
  };

  const FolderPicker = ({ children, style }) =>
    openFolder ? (
      <button style={style} onClick={openFolder} type="button">
        {children}
      </button>
    ) : (
      <label style={style}>
        {children}
        <input
          type="file"
          multiple
          accept="video/*"
          webkitdirectory=""
          directory=""
          hidden
          onChange={loadFolder}
        />
      </label>
    );

  const btnSize = isMobile ? 44 : 36;
  const ctrlFontSize = isMobile ? 20 : 18;
  const playBigSize = isMobile ? 64 : 72;
  const playlistVisible = showPlaylist && playlist.length > 0;

  // ───────────────────────────────────────────────────────────────────────────
  // ADJUSTMENT POINT 2 — Mobile playlist bottom sheet
  //
  // `bottom` is set to BOTTOMBAR_H so the sheet slides up from just above
  // your bottom tab-bar instead of from the very edge of the screen.
  //
  // If you have no bottom bar keep BOTTOMBAR_H = 0.
  // ───────────────────────────────────────────────────────────────────────────
  const sidebarStyle = isMobile
    ? {
        ...S.sidebar,
        position: "fixed",
        bottom: BOTTOMBAR_H, // ← sits above your bottom tab-bar
        left: 0,
        right: 0,
        width: "100%",
        height: playlistVisible ? "52vh" : 0,
        borderLeft: "none",
        borderTop: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "16px 16px 0 0",
        transition: "height 0.35s cubic-bezier(0.25, 1, 0.5, 1)",
        zIndex: 20,
        overflow: "hidden",
      }
    : {
        ...S.sidebar,
        width: isTablet ? 260 : 320,
        ...(playlistVisible
          ? {}
          : {
              marginRight: isTablet ? -260 : -320,
              opacity: 0,
              pointerEvents: "none",
            }),
      };

  const ConverterModal = () => (
    <div style={S.modalBackdrop} onClick={() => setShowConverter(false)}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <FontAwesomeIcon
            icon={faFileAudio}
            style={{ color: "var(--primary-color, #3390ec)", marginRight: 10 }}
          />
          <span style={S.modalTitle}>Video to Audio (WAV)</span>
          <button style={S.modalClose} onClick={() => setShowConverter(false)}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
        <div style={S.modalBody}>
          <div style={S.converterInfo}>
            <FontAwesomeIcon
              icon={faFilm}
              style={{ color: "rgba(255,255,255,0.4)", marginRight: 8 }}
            />
            <span
              style={{
                color: "rgba(255,255,255,0.7)",
                fontSize: 13,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {currentEntry?.title}
            </span>
          </div>
          {convertStatus !== "idle" && (
            <div style={S.converterProgress}>
              <div style={S.converterBar}>
                <div
                  style={{
                    ...S.converterFill,
                    width: `${convertProgress}%`,
                    background:
                      convertStatus === "error"
                        ? "#ef4444"
                        : convertStatus === "done"
                          ? "#22c55e"
                          : "var(--primary-color, #3390ec)",
                  }}
                />
              </div>
              <span
                style={{
                  ...S.converterLabel,
                  color:
                    convertStatus === "error"
                      ? "#ef4444"
                      : convertStatus === "done"
                        ? "#22c55e"
                        : "rgba(255,255,255,0.6)",
                }}
              >
                {convertStatus === "decoding" && (
                  <>
                    <FontAwesomeIcon
                      icon={faSpinner}
                      spin
                      style={{ marginRight: 6 }}
                    />
                    Decoding audio…
                  </>
                )}
                {convertStatus === "encoding" && (
                  <>
                    <FontAwesomeIcon
                      icon={faSpinner}
                      spin
                      style={{ marginRight: 6 }}
                    />
                    Encoding WAV…
                  </>
                )}
                {convertStatus === "done" && (
                  <>
                    <FontAwesomeIcon
                      icon={faCheck}
                      style={{ marginRight: 6 }}
                    />
                    Done! Ready to download.
                  </>
                )}
                {convertStatus === "error" &&
                  "Conversion failed. The video may have no audio track, or the format is unsupported."}
              </span>
            </div>
          )}
          <p style={S.converterNote}>
            Audio is extracted entirely in your browser — no upload, no server.
            The output is a standard WAV file that plays in any music or video
            app.
          </p>
          <div style={S.converterActions}>
            {convertStatus === "idle" || convertStatus === "error" ? (
              <button style={S.converterBtn} onClick={convertToAudio}>
                <FontAwesomeIcon icon={faMusic} style={{ marginRight: 8 }} />
                Extract Audio
              </button>
            ) : convertStatus === "done" ? (
              <>
                <button style={S.converterBtn} onClick={downloadAudio}>
                  <FontAwesomeIcon
                    icon={faDownload}
                    style={{ marginRight: 8 }}
                  />
                  Download Audio
                </button>
                <button
                  style={{
                    ...S.converterBtn,
                    background: "rgba(255,255,255,0.08)",
                  }}
                  onClick={convertToAudio}
                >
                  <FontAwesomeIcon icon={faRepeat} style={{ marginRight: 8 }} />
                  Re-convert
                </button>
              </>
            ) : (
              <button
                style={{
                  ...S.converterBtn,
                  opacity: 0.5,
                  cursor: "not-allowed",
                }}
                disabled
              >
                <FontAwesomeIcon
                  icon={faSpinner}
                  spin
                  style={{ marginRight: 8 }}
                />
                Converting…
              </button>
            )}
            <button
              style={{
                ...S.converterBtn,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.5)",
              }}
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

  return (
    <div style={{ ...S.root, flexDirection: isMobile ? "column" : "row" }}>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {showConverter && <ConverterModal />}

      <div style={S.main}>
        {restoring ? (
          <div style={S.empty}>
            <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
            <p style={S.emptyHint}>
              Reconnecting to "{folderName || "last folder"}"…
            </p>
            {/* Cancel button — aborts file reading + thumbnail generation immediately */}
            <button
              style={S.cancelRestoreBtn}
              onClick={cancelRestore}
              type="button"
            >
              <FontAwesomeIcon icon={faXmark} style={{ marginRight: 8 }} />
              Select New Folder Instead
            </button>
            <p style={{ ...S.emptyHint, fontSize: 11, marginTop: -8 }}>
              Cancels the reconnect and clears the saved folder.
            </p>
          </div>
        ) : needsReconnect ? (
          <div style={S.empty}>
            <button style={S.openBtn} onClick={reconnectFolder} type="button">
              <FontAwesomeIcon icon={faFolder} />
              <span style={{ marginLeft: 10 }}>
                Reconnect to "{folderName}"
              </span>
            </button>
            <p style={S.emptyHint}>
              Your browser needs permission to access this folder again.
            </p>
            <FolderPicker style={S.linkBtn}>
              Or pick a different folder
            </FolderPicker>
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
            <button
              type="button"
              style={{
                ...S.openBtn,
                marginTop: 12,
              }}
              onClick={() => videoInput.current?.click()}
            >
              <FontAwesomeIcon icon={faFilm} />
              <span style={{ marginLeft: 10 }}>Open Video</span>
            </button>

            <input
              ref={videoInput}
              type="file"
              accept="video/*"
              hidden
              onChange={loadSingleVideo}
            />
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
                <track
                  kind="subtitles"
                  src={subtitleUrl}
                  srcLang="en"
                  label="Subtitle"
                  default
                />
              )}
            </video>

            {loading && (
              <div style={S.spinnerWrap}>
                <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
              </div>
            )}

            <button
              style={{
                ...S.playlistToggle,
                opacity: showControls ? 1 : 0,
                width: btnSize,
                height: btnSize,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setShowPlaylist((v) => !v);
              }}
              title="Toggle playlist (P)"
            >
              <FontAwesomeIcon icon={showPlaylist ? faChevronDown : faList} />
            </button>

            <div
              style={{ ...S.overlay, opacity: showControls ? 1 : 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Title bar */}
              <div
                style={{
                  ...S.titleBar,
                  padding: isMobile
                    ? "12px 62px 12px 14px"
                    : "20px 70px 20px 24px",
                }}
              >
                <span style={{ ...S.titleText, fontSize: isMobile ? 13 : 15 }}>
                  {currentEntry?.title ?? ""}
                </span>
                <FolderPicker
                  style={{ ...S.smallBtn, width: btnSize, height: btnSize }}
                >
                  <FontAwesomeIcon icon={faFolder} />
                </FolderPicker>
              </div>

              {/* Centre */}
              <div style={{ ...S.centerRow, gap: isMobile ? 20 : 32 }}>
                <button
                  style={{
                    ...S.iconBtn,
                    fontSize: isMobile ? 13 : 15,
                    padding: isMobile ? "8px 12px" : "10px 16px",
                  }}
                  onClick={() => skip(-10)}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span style={{ marginLeft: 4, fontSize: isMobile ? 11 : 13 }}>
                    10
                  </span>
                </button>
                <button
                  style={{
                    ...S.playBig,
                    width: playBigSize,
                    height: playBigSize,
                    fontSize: isMobile ? 22 : 26,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    playPause();
                  }}
                >
                  <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                </button>
                <button
                  style={{
                    ...S.iconBtn,
                    fontSize: isMobile ? 13 : 15,
                    padding: isMobile ? "8px 12px" : "10px 16px",
                  }}
                  onClick={() => skip(10)}
                >
                  <span
                    style={{ marginRight: 4, fontSize: isMobile ? 11 : 13 }}
                  >
                    10
                  </span>
                  <FontAwesomeIcon icon={faRotateRight} />
                </button>
              </div>

              {/* Bottom bar */}
              <div
                style={{ padding: isMobile ? "0 12px 12px" : "0 24px 24px" }}
              >
                <div
                  style={{
                    ...S.progressWrap,
                    height: isMobile ? 20 : 16,
                    marginBottom: isMobile ? 8 : 10,
                  }}
                >
                  <div style={{ ...S.track, height: isMobile ? 5 : 4 }}>
                    <div
                      style={{
                        ...S.trackFill,
                        width: `${pct(buffered, duration)}%`,
                        background: "rgba(255,255,255,0.3)",
                      }}
                    />
                    <div
                      style={{
                        ...S.trackFill,
                        width: `${pct(currentTime, duration)}%`,
                        background: "#e50914",
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={pct(currentTime, duration)}
                    style={S.rangeOverlay}
                    onChange={(e) => seek(Number(e.target.value) / 100)}
                  />
                </div>

                <div style={{ ...S.ctrlRow, gap: isMobile ? 2 : 6 }}>
                  <div style={{ ...S.ctrlLeft, gap: isMobile ? 4 : 8 }}>
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        playPause();
                      }}
                    >
                      <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                    </button>
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={goPrev}
                    >
                      <FontAwesomeIcon icon={faBackwardStep} />
                    </button>
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={goNext}
                    >
                      <FontAwesomeIcon icon={faForwardStep} />
                    </button>
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={toggleMute}
                    >
                      <FontAwesomeIcon
                        icon={
                          muted || volume === 0
                            ? faVolumeXmark
                            : volume < 0.5
                              ? faVolumeLow
                              : faVolumeHigh
                        }
                      />
                    </button>
                    {!isMobile && (
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.02"
                        value={muted ? 0 : volume}
                        style={{
                          width: 70,
                          accentColor: "#fff",
                          cursor: "pointer",
                        }}
                        onChange={(e) => handleVolume(Number(e.target.value))}
                      />
                    )}
                    <span
                      style={{ ...S.timeText, fontSize: isMobile ? 10 : 12 }}
                    >
                      {fmt(currentTime)} / {fmt(duration)}
                    </span>
                  </div>

                  <div style={{ ...S.ctrlRight, gap: isMobile ? 2 : 6 }}>
                    {/* Screenshot */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{
                          ...S.ctrlBtn,
                          fontSize: ctrlFontSize,
                          width: btnSize,
                          height: btnSize,
                        }}
                        onClick={takeScreenshot}
                        title="Screenshot"
                      >
                        <FontAwesomeIcon icon={faCamera} />
                      </button>
                      {shotUrl && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <img
                            src={shotUrl}
                            alt="screenshot"
                            style={S.shotPreview}
                          />
                          <button style={S.popItem} onClick={downloadShot}>
                            <FontAwesomeIcon icon={faDownload} />
                            <span style={{ marginLeft: 8 }}>Download</span>
                          </button>
                          <button
                            style={S.popItem}
                            onClick={() => setShotUrl(null)}
                          >
                            <FontAwesomeIcon icon={faXmark} />
                            <span style={{ marginLeft: 8 }}>Close</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Share */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{
                          ...S.ctrlBtn,
                          fontSize: ctrlFontSize,
                          width: btnSize,
                          height: btnSize,
                        }}
                        onClick={() => setShowShareMenu((v) => !v)}
                        title="Share last 30s"
                      >
                        <FontAwesomeIcon icon={faShareNodes} />
                      </button>
                      {showShareMenu && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <div style={S.popLabel}>
                            Share last {CLIP_SECONDS}s
                          </div>
                          {clipBusy && (
                            <div
                              style={{
                                ...S.popLabel,
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              <FontAwesomeIcon icon={faSpinner} spin />
                              Preparing clip…
                            </div>
                          )}
                          <button
                            style={S.popItem}
                            onClick={() => shareClipWatermarked("whatsapp")}
                          >
                            <FontAwesomeIcon icon={faWhatsapp} />
                            <span style={{ marginLeft: 8 }}>WhatsApp</span>
                          </button>
                          <button
                            style={S.popItem}
                            onClick={() => shareClipWatermarked("facebook")}
                          >
                            <FontAwesomeIcon icon={faFacebook} />
                            <span style={{ marginLeft: 8 }}>Facebook</span>
                          </button>
                          <button
                            style={S.popItem}
                            onClick={() => shareClipWatermarked("tiktok")}
                          >
                            <FontAwesomeIcon icon={faTiktok} />
                            <span style={{ marginLeft: 8 }}>TikTok</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Subtitles */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{
                          ...S.ctrlBtn,
                          fontSize: ctrlFontSize,
                          width: btnSize,
                          height: btnSize,
                          opacity: subtitleUrl ? 1 : 0.55,
                        }}
                        onClick={() => setShowSubMenu((v) => !v)}
                        title="Subtitles"
                      >
                        <FontAwesomeIcon icon={faClosedCaptioning} />
                      </button>
                      {showSubMenu && (
                        <div
                          style={{
                            ...(isMobile ? S.popMenuMobile : S.popMenu),
                            width: isMobile ? "auto" : 280,
                          }}
                        >
                          <div style={S.popLabel}>Subtitles</div>
                          {subtitleUrl && (
                            <button
                              style={S.popItem}
                              onClick={() => setSubtitlesOn((v) => !v)}
                            >
                              <FontAwesomeIcon
                                icon={
                                  subtitlesOn ? faCheck : faClosedCaptioning
                                }
                              />
                              <span style={{ marginLeft: 8 }}>
                                {subtitlesOn ? "Enabled" : "Disabled"}
                              </span>
                            </button>
                          )}
                          <label style={S.popItem}>
                            <FontAwesomeIcon icon={faFilm} />
                            <span style={{ marginLeft: 8 }}>
                              Upload .srt / .vtt
                            </span>
                            <input
                              type="file"
                              accept=".srt,.vtt"
                              hidden
                              onChange={loadLocalSubtitle}
                            />
                          </label>
                          <div style={S.popDivider} />
                          <div style={S.popLabel}>OpenSubtitles Search</div>
                          <button
                            style={S.popItem}
                            onClick={searchSubtitles}
                            disabled={subSearching}
                          >
                            <FontAwesomeIcon
                              icon={
                                subSearching ? faSpinner : faMagnifyingGlass
                              }
                              spin={subSearching}
                            />
                            <span style={{ marginLeft: 8 }}>
                              Search "{currentEntry?.title}"
                            </span>
                          </button>
                          {subError && <div style={S.subError}>{subError}</div>}
                          {subResults.map((r) => (
                            <button
                              key={r.id}
                              style={S.popItem}
                              onClick={() => downloadSubtitle(r)}
                            >
                              <FontAwesomeIcon icon={faDownload} />
                              <span style={{ marginLeft: 8 }}>
                                {r.attributes?.release ||
                                  r.attributes?.feature_details?.title ||
                                  "Subtitle"}
                                <span style={{ opacity: 0.5, marginLeft: 4 }}>
                                  ({r.attributes?.language})
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Rotate */}
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={rotate}
                      title="Rotate"
                    >
                      <FontAwesomeIcon icon={faRepeat} />
                    </button>

                    {/* Audio converter */}
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={() => setShowConverter(true)}
                      title="Extract Audio (WAV)"
                    >
                      <FontAwesomeIcon icon={faMusic} />
                    </button>

                    {/* Quality */}
                    {currentEntry?.sources.length > 1 && (
                      <div style={{ position: "relative" }}>
                        <button
                          style={{
                            ...S.ctrlBtn,
                            fontSize: isMobile ? 9 : 10,
                            width: btnSize,
                            height: btnSize,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                          }}
                          onClick={() => setShowQualityMenu((v) => !v)}
                        >
                          {activeQuality}
                        </button>
                        {showQualityMenu && (
                          <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                            <div style={S.popLabel}>Quality</div>
                            {currentEntry.sources.map((s) => (
                              <button
                                key={s.quality}
                                style={{
                                  ...S.popItem,
                                  fontWeight:
                                    s.quality === activeQuality ? 700 : 400,
                                }}
                                onClick={() => {
                                  autoplayNextRef.current = playing;
                                  setActiveQuality(s.quality);
                                  setShowQualityMenu(false);
                                }}
                              >
                                <FontAwesomeIcon
                                  icon={
                                    s.quality === activeQuality
                                      ? faCheck
                                      : faFilm
                                  }
                                />
                                <span style={{ marginLeft: 8 }}>
                                  {s.quality}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Speed */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{
                          ...S.ctrlBtn,
                          fontSize: isMobile ? 9 : 11,
                          width: btnSize,
                          height: btnSize,
                        }}
                        onClick={() => setShowSettings((v) => !v)}
                      >
                        <FontAwesomeIcon icon={faGear} />
                      </button>
                      {showSettings && (
                        <div style={isMobile ? S.popMenuMobile : S.popMenu}>
                          <div style={S.popLabel}>Playback Speed</div>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                            <button
                              key={s}
                              style={{
                                ...S.popItem,
                                fontWeight: playbackRate === s ? 700 : 400,
                              }}
                              onClick={() => changeSpeed(s)}
                            >
                              <FontAwesomeIcon
                                icon={playbackRate === s ? faCheck : faGear}
                              />
                              <span style={{ marginLeft: 8 }}>{s}×</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Fullscreen */}
                    <button
                      style={{
                        ...S.ctrlBtn,
                        fontSize: ctrlFontSize,
                        width: btnSize,
                        height: btnSize,
                      }}
                      onClick={toggleFullscreen}
                      title="Fullscreen (F)"
                    >
                      <FontAwesomeIcon
                        icon={fullscreen ? faCompress : faExpand}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Playlist / bottom sheet */}
      {playlist.length > 0 && (
        <div style={sidebarStyle}>
          {isMobile && (
            <div
              style={S.dragHandle}
              onClick={() => setShowPlaylist((v) => !v)}
            >
              <div style={S.dragHandlePill} />
            </div>
          )}
          <div
            style={{
              ...S.sidebarHead,
              padding: isMobile ? "10px 16px" : "24px 20px 16px",
            }}
          >
            <FontAwesomeIcon
              icon={faList}
              style={{ color: "rgba(255,255,255,0.4)", marginRight: 8 }}
            />
            <span style={S.sidebarTitle}>Playlist</span>
            <span style={S.sidebarCount}>{playlist.length} videos</span>
            <button
              style={S.sidebarClose}
              onClick={() => setShowPlaylist(false)}
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
          <div style={S.sidebarList}>
            {playlist.map((p, i) => (
              <div
                key={p.id}
                style={{
                  ...S.item,
                  ...(i === currentIndex ? S.itemActive : {}),
                  padding: isMobile ? "8px 14px" : "10px 20px",
                  gap: isMobile ? 10 : 12,
                  position: "relative",
                }}
                onClick={() => {
                  playEntry(i);
                  if (isMobile) setShowPlaylist(false);
                }}
              >
                {/* Thumbnail */}
                <div
                  style={{
                    ...S.thumbWrap,
                    width: isMobile ? 64 : 80,
                    height: isMobile ? 36 : 45,
                  }}
                >
                  {p.thumb ? (
                    <img src={p.thumb} alt={p.title} style={S.thumbImg} />
                  ) : (
                    <div style={S.thumbPlaceholder}>
                      <FontAwesomeIcon icon={faFilm} />
                    </div>
                  )}
                  {i === currentIndex && (
                    <div style={S.nowPlayingBadge}>
                      <FontAwesomeIcon
                        icon={playing ? faPause : faPlay}
                        style={{ fontSize: 9 }}
                      />
                    </div>
                  )}
                </div>

                {/* Title + meta */}
                <div style={S.itemBody}>
                  <div
                    style={{
                      ...S.itemTitle,
                      color: i === currentIndex ? "#e50914" : "#eee",
                      fontSize: isMobile ? 12 : 13,
                    }}
                  >
                    {p.title}
                  </div>
                  <div style={S.itemMeta}>
                    {p.sources.map((s) => s.quality).join(" · ")} ·{" "}
                    {(p.sources[0].size / 1048576).toFixed(1)} MB
                  </div>
                </div>

                {/* Three-dot button */}
                <button
                  style={S.dotBtn}
                  title="More options"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemMenuId((prev) => (prev === p.id ? null : p.id));
                  }}
                >
                  <FontAwesomeIcon icon={faEllipsisVertical} />
                </button>

                {/* Context menu */}
                {itemMenuId === p.id && (
                  <div style={S.itemMenu} onClick={(e) => e.stopPropagation()}>
                    {/* Convert to audio */}
                    <button
                      style={S.itemMenuItem}
                      onClick={() => {
                        setItemMenuId(null);
                        convertEntryToAudio(p);
                      }}
                    >
                      <FontAwesomeIcon icon={faMusic} style={S.itemMenuIcon} />
                      <div>
                        <div style={S.itemMenuLabel}>Convert to Audio</div>
                        <div style={S.itemMenuSub}>Extract WAV from video</div>
                      </div>
                    </button>

                    <div style={S.itemMenuDivider} />

                    {/* Video details */}
                    <button
                      style={S.itemMenuItem}
                      onClick={() => {
                        setItemMenuId(null);
                        setDetailEntry(p);
                      }}
                    >
                      <FontAwesomeIcon
                        icon={faCircleInfo}
                        style={S.itemMenuIcon}
                      />
                      <div>
                        <div style={S.itemMenuLabel}>Video Details</div>
                        <div style={S.itemMenuSub}>Size, quality, format</div>
                      </div>
                    </button>

                    <div style={S.itemMenuDivider} />

                    {/* Share video — sub-items inline */}
                    <div style={{ padding: "8px 14px 4px" }}>
                      <div
                        style={{
                          ...S.itemMenuLabel,
                          marginBottom: 6,
                          opacity: 0.5,
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.7px",
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faShareNodes}
                          style={{ marginRight: 6 }}
                        />
                        Share (with watermark)
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          style={S.shareChip}
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "whatsapp");
                          }}
                        >
                          <FontAwesomeIcon
                            icon={faWhatsapp}
                            style={{ marginRight: 5 }}
                          />
                          WhatsApp
                        </button>
                        <button
                          style={S.shareChip}
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "facebook");
                          }}
                        >
                          <FontAwesomeIcon
                            icon={faFacebook}
                            style={{ marginRight: 5 }}
                          />
                          Facebook
                        </button>
                        <button
                          style={S.shareChip}
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "tiktok");
                          }}
                        >
                          <FontAwesomeIcon
                            icon={faTiktok}
                            style={{ marginRight: 5 }}
                          />
                          TikTok
                        </button>
                      </div>
                    </div>

                    {/* Watermark label editor */}
                    <div style={{ padding: "8px 14px 10px" }}>
                      <div style={{ ...S.itemMenuSub, marginBottom: 4 }}>
                        <FontAwesomeIcon
                          icon={faStamp}
                          style={{ marginRight: 5 }}
                        />
                        Watermark text
                      </div>
                      <input
                        style={S.wmInput}
                        value={watermarkText}
                        maxLength={40}
                        onChange={(e) => setWatermarkText(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Your watermark…"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <FolderPicker
            style={{
              ...S.changeFolder,
              margin: isMobile ? "8px 14px 14px" : "12px 20px 20px",
            }}
          >
            <FontAwesomeIcon icon={faFolder} />
            <span style={{ marginLeft: 8 }}>Change Folder</span>
          </FolderPicker>
        </div>
      )}

      {/* ── Video Detail Modal ── */}
      {detailEntry && (
        <div style={S.modalBackdrop} onClick={() => setDetailEntry(null)}>
          <div
            style={{ ...S.modal, maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={S.modalHead}>
              <FontAwesomeIcon
                icon={faCircleInfo}
                style={{
                  color: "var(--primary-color,#3390ec)",
                  marginRight: 10,
                }}
              />
              <span style={S.modalTitle}>Video Details</span>
              <button style={S.modalClose} onClick={() => setDetailEntry(null)}>
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
            <div style={S.modalBody}>
              {detailEntry.thumb && (
                <img
                  src={detailEntry.thumb}
                  alt={detailEntry.title}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    marginBottom: 16,
                    objectFit: "cover",
                    maxHeight: 160,
                  }}
                />
              )}
              <div style={S.detailGrid}>
                <div style={S.detailRow}>
                  <FontAwesomeIcon icon={faFilm} style={S.detailIcon} />
                  <div>
                    <div style={S.detailLabel}>Title</div>
                    <div style={S.detailValue}>{detailEntry.title}</div>
                  </div>
                </div>
                {detailEntry.sources.map((s, si) => (
                  <div key={si} style={S.detailRow}>
                    <FontAwesomeIcon icon={faHdd} style={S.detailIcon} />
                    <div>
                      <div style={S.detailLabel}>
                        Source {si + 1} — {s.quality.toUpperCase()}
                      </div>
                      <div style={S.detailValue}>
                        {(s.size / 1048576).toFixed(2)} MB &nbsp;·&nbsp;{" "}
                        {s.file.type || "unknown"}
                      </div>
                    </div>
                  </div>
                ))}
                <div style={S.detailRow}>
                  <FontAwesomeIcon icon={faCalendar} style={S.detailIcon} />
                  <div>
                    <div style={S.detailLabel}>Last Modified</div>
                    <div style={S.detailValue}>
                      {detailEntry.sources[0].file.lastModified
                        ? new Date(
                            detailEntry.sources[0].file.lastModified,
                          ).toLocaleString()
                        : "—"}
                    </div>
                  </div>
                </div>
                <div style={S.detailRow}>
                  <FontAwesomeIcon icon={faStamp} style={S.detailIcon} />
                  <div>
                    <div style={S.detailLabel}>Watermark Text</div>
                    <input
                      style={{ ...S.wmInput, marginTop: 4, width: "100%" }}
                      value={watermarkText}
                      maxLength={40}
                      onChange={(e) => setWatermarkText(e.target.value)}
                      placeholder="Your watermark…"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Share Progress Modal (watermark encoding in progress) ── */}
      {shareEntry && shareStep !== "idle" && (
        <div
          style={S.modalBackdrop}
          onClick={() => {
            if (shareStep !== "building") {
              setShareEntry(null);
              setShareStep("idle");
              if (shareUrl) {
                URL.revokeObjectURL(shareUrl);
                setShareUrl(null);
              }
            }
          }}
        >
          <div
            style={{ ...S.modal, maxWidth: 380 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={S.modalHead}>
              <FontAwesomeIcon
                icon={faStamp}
                style={{
                  color: "var(--primary-color,#3390ec)",
                  marginRight: 10,
                }}
              />
              <span style={S.modalTitle}>Preparing Watermarked Video</span>
              {shareStep !== "building" && (
                <button
                  style={S.modalClose}
                  onClick={() => {
                    setShareEntry(null);
                    setShareStep("idle");
                    if (shareUrl) {
                      URL.revokeObjectURL(shareUrl);
                      setShareUrl(null);
                    }
                  }}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              )}
            </div>
            <div style={S.modalBody}>
              <div style={S.converterInfo}>
                <FontAwesomeIcon
                  icon={faFilm}
                  style={{ color: "rgba(255,255,255,0.4)", marginRight: 8 }}
                />
                <span
                  style={{
                    color: "rgba(255,255,255,0.7)",
                    fontSize: 13,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {shareEntry.title}
                </span>
              </div>
              <div style={{ textAlign: "center", padding: "12px 0 8px" }}>
                {shareStep === "building" && (
                  <>
                    <FontAwesomeIcon
                      icon={faSpinner}
                      spin
                      size="2x"
                      style={{
                        color: "var(--primary-color,#3390ec)",
                        marginBottom: 12,
                      }}
                    />
                    <div
                      style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}
                    >
                      Rendering frames with watermark… this may take a moment.
                    </div>
                  </>
                )}
                {shareStep === "done" && (
                  <>
                    <FontAwesomeIcon
                      icon={faCheck}
                      size="2x"
                      style={{ color: "#22c55e", marginBottom: 12 }}
                    />
                    <div style={{ color: "#22c55e", fontSize: 13 }}>
                      Done! File downloaded and share dialog opened.
                    </div>
                  </>
                )}
                {shareStep === "error" && (
                  <>
                    <FontAwesomeIcon
                      icon={faXmark}
                      size="2x"
                      style={{ color: "#ef4444", marginBottom: 12 }}
                    />
                    <div style={{ color: "#ef4444", fontSize: 13 }}>
                      Failed to render watermark. The video format may not be
                      supported by your browser's encoder.
                    </div>
                  </>
                )}
              </div>
              <p style={S.converterNote}>
                The watermark "
                <strong style={{ color: "#fff" }}>{watermarkText}</strong>" is
                burned into the bottom-right corner of every frame. No data is
                uploaded — everything happens in your browser.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  root: {
    display: "flex",
    width: "100%",

    // ─────────────────────────────────────────────────────────────────────
    // ADJUSTMENT POINT 3 — Root container height
    //
    // We subtract both NAVBAR_H and BOTTOMBAR_H so the player occupies only
    // the space between your top navbar and bottom tab-bar.
    //
    // `100dvh` = dynamic viewport height (accounts for mobile browser chrome
    // collapsing/expanding). Falls back to `100vh` in older browsers.
    //
    // If you use `100%` height on your parent div instead, change this to:
    //   height: `calc(100% - ${NAVBAR_H + BOTTOMBAR_H}px)`
    //
    // Or if your layout already constrains the height of the parent:
    //   height: "100%"   ← and delete the calc entirely
    // ─────────────────────────────────────────────────────────────────────
    height: `calc(100dvh - ${NAVBAR_H + BOTTOMBAR_H}px)`,

    background: "var(--bg-main, #0f0f0f)",
    fontFamily: "var(--font-body, system-ui, sans-serif)",
    overflow: "hidden",
    color: "var(--text-main, #fff)",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  main: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#000",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 20,
    padding: "0 24px",
    textAlign: "center",
  },
  openBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "14px 32px",
    borderRadius: "var(--radius-md, 10px)",
    background: "var(--primary-color, #3390ec)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    boxShadow: "0 4px 14px rgba(51,144,236,0.3)",
    WebkitTapHighlightColor: "transparent",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.45)",
    fontSize: 13,
    textDecoration: "underline",
    cursor: "pointer",
  },
  cancelRestoreBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "11px 24px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    marginTop: 4,
  },
  emptyHint: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 13,
    margin: 0,
    maxWidth: 260,
  },
  player: {
    position: "relative",
    width: "100%",
    height: "100%",
    background: "#000",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    background: "#000",
    display: "block",
    zIndex: 1,
    transition: "transform 0.3s ease",
  },
  spinnerWrap: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    pointerEvents: "none",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 3,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    background:
      "linear-gradient(to bottom,rgba(0,0,0,0.55) 0%,transparent 25%,transparent 75%,rgba(0,0,0,0.78) 100%)",
    transition: "opacity 0.3s cubic-bezier(0.25,1,0.5,1)",
    cursor: "default",
  },
  playlistToggle: {
    position: "absolute",
    top: 12,
    right: 14,
    zIndex: 4,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    transition: "opacity 0.3s, background 0.2s",
    WebkitTapHighlightColor: "transparent",
  },
  titleBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  titleText: {
    color: "#fff",
    fontWeight: 500,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  smallBtn: {
    borderRadius: "50%",
    background: "rgba(255,255,255,0.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    border: "1px solid rgba(255,255,255,0.1)",
    WebkitTapHighlightColor: "transparent",
  },
  centerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    borderRadius: 8,
    WebkitTapHighlightColor: "transparent",
  },
  playBig: {
    borderRadius: "50%",
    background: "rgba(255,255,255,0.18)",
    border: "1px solid rgba(255,255,255,0.28)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
    WebkitTapHighlightColor: "transparent",
    flexShrink: 0,
  },
  progressWrap: { position: "relative", cursor: "pointer" },
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    transform: "translateY(-50%)",
    borderRadius: 3,
    overflow: "hidden",
    background: "rgba(255,255,255,0.2)",
  },
  trackFill: {
    position: "absolute",
    left: 0,
    top: 0,
    height: "100%",
    borderRadius: 3,
    transition: "width 0.1s linear",
  },
  rangeOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
    margin: 0,
  },
  ctrlRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  ctrlLeft: { display: "flex", alignItems: "center" },
  ctrlRight: { display: "flex", alignItems: "center" },
  ctrlBtn: {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    lineHeight: 1,
    WebkitTapHighlightColor: "transparent",
    flexShrink: 0,
  },
  timeText: {
    color: "rgba(255,255,255,0.65)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  popMenu: {
    position: "absolute",
    bottom: "115%",
    right: 0,
    background: "rgba(14,20,32,0.96)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "8px 0",
    zIndex: 20,
    minWidth: 180,
    maxWidth: "90vw",
    boxShadow: "0 12px 40px rgba(0,0,0,0.65)",
  },
  popMenuMobile: {
    position: "absolute",
    bottom: "115%",
    right: 0,
    background: "rgba(14,20,32,0.97)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "8px 0",
    zIndex: 20,
    minWidth: 210,
    maxWidth: "88vw",
    maxHeight: "42vh",
    overflowY: "auto",
    boxShadow: "0 12px 40px rgba(0,0,0,0.75)",
  },
  popItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "12px 16px",
    textAlign: "left",
    background: "none",
    border: "none",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  popLabel: {
    padding: "4px 16px 6px",
    fontSize: 10,
    color: "rgba(255,255,255,0.4)",
    textTransform: "uppercase",
    letterSpacing: "0.8px",
  },
  popDivider: {
    height: 1,
    background: "rgba(255,255,255,0.07)",
    margin: "4px 0",
  },
  shotPreview: { width: "100%", borderRadius: "8px 8px 0 0", display: "block" },
  subError: {
    padding: "6px 16px",
    fontSize: 11,
    color: "#f87171",
    lineHeight: 1.5,
  },
  sidebar: {
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-nav, #111)",
    borderLeft: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0,
    transition: "margin-right 0.3s cubic-bezier(0.25,1,0.5,1), opacity 0.3s",
  },
  dragHandle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 10,
    paddingBottom: 4,
    cursor: "pointer",
  },
  dragHandlePill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    background: "rgba(255,255,255,0.2)",
  },
  sidebarHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0,
  },
  sidebarTitle: { color: "#fff", fontWeight: 600, fontSize: 14, flex: 1 },
  sidebarCount: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 11,
    fontWeight: 500,
  },
  sidebarClose: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.4)",
    fontSize: 14,
    cursor: "pointer",
    padding: 6,
    WebkitTapHighlightColor: "transparent",
  },
  sidebarList: { flex: 1, overflowY: "auto", padding: "8px 0" },
  item: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    borderLeftWidth: 3,
    borderLeftStyle: "solid",
    borderLeftColor: "transparent",
    WebkitTapHighlightColor: "transparent",
  },
  itemActive: {
    background: "rgba(51,144,236,0.1)",
    borderLeftColor: "var(--primary-color, #3390ec)",
  },
  thumbWrap: {
    position: "relative",
    borderRadius: 6,
    overflow: "hidden",
    flexShrink: 0,
    background: "rgba(255,255,255,0.06)",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  thumbPlaceholder: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(255,255,255,0.25)",
    fontSize: 16,
  },
  nowPlayingBadge: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.52)",
    color: "#e50914",
  },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: {
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginBottom: 3,
  },
  itemMeta: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 10,
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.3px",
  },
  changeFolder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "rgba(255,255,255,0.45)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    flexShrink: 0,
    WebkitTapHighlightColor: "transparent",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    background: "rgba(0,0,0,0.72)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modal: {
    width: "100%",
    maxWidth: 480,
    background: "rgba(14,20,32,0.98)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
  },
  modalHead: {
    display: "flex",
    alignItems: "center",
    padding: "18px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
  },
  modalTitle: { flex: 1, fontSize: 15, fontWeight: 600, color: "#fff" },
  modalClose: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.45)",
    fontSize: 16,
    cursor: "pointer",
    padding: 4,
    WebkitTapHighlightColor: "transparent",
  },
  modalBody: { padding: "20px" },
  converterInfo: {
    display: "flex",
    alignItems: "center",
    padding: "10px 14px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.07)",
    marginBottom: 16,
    overflow: "hidden",
  },
  converterProgress: { marginBottom: 16 },
  converterBar: {
    height: 6,
    borderRadius: 3,
    background: "rgba(255,255,255,0.1)",
    overflow: "hidden",
    marginBottom: 8,
  },
  converterFill: {
    height: "100%",
    borderRadius: 3,
    transition: "width 0.4s ease, background 0.3s ease",
  },
  converterLabel: { fontSize: 12, display: "flex", alignItems: "center" },
  converterNote: {
    fontSize: 12,
    color: "rgba(255,255,255,0.4)",
    lineHeight: 1.6,
    margin: "0 0 20px",
    padding: 0,
  },
  converterActions: { display: "flex", flexWrap: "wrap", gap: 10 },
  converterBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "11px 20px",
    borderRadius: 8,
    background: "var(--primary-color, #3390ec)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },

  // ── Three-dot button on playlist item ──
  dotBtn: {
    flexShrink: 0,
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.35)",
    fontSize: 16,
    cursor: "pointer",
    padding: "6px 8px",
    borderRadius: 6,
    WebkitTapHighlightColor: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Item context menu ──
  itemMenu: {
    position: "absolute",
    right: 8,
    top: "100%",
    zIndex: 30,
    background: "rgba(14,20,32,0.98)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    padding: "6px 0",
    minWidth: 230,
    boxShadow: "0 16px 48px rgba(0,0,0,0.75)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
  },
  itemMenuItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    width: "100%",
    padding: "10px 14px",
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    textAlign: "left",
    WebkitTapHighlightColor: "transparent",
  },
  itemMenuIcon: {
    color: "var(--primary-color,#3390ec)",
    fontSize: 15,
    marginTop: 2,
    flexShrink: 0,
  },
  itemMenuLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    lineHeight: 1.3,
  },
  itemMenuSub: { fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 },
  itemMenuDivider: {
    height: 1,
    background: "rgba(255,255,255,0.07)",
    margin: "4px 0",
  },

  // ── Share platform chips (compact) ──
  shareChip: {
    display: "inline-flex",
    alignItems: "center",
    padding: "5px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    whiteSpace: "nowrap",
  },

  // ── Watermark text input ──
  wmInput: {
    width: "100%",
    padding: "7px 10px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box",
  },

  // ── Video detail modal ──
  detailGrid: { display: "flex", flexDirection: "column", gap: 12 },
  detailRow: { display: "flex", alignItems: "flex-start", gap: 12 },
  detailIcon: {
    color: "var(--primary-color,#3390ec)",
    fontSize: 14,
    marginTop: 3,
    flexShrink: 0,
    width: 16,
  },
  detailLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.4)",
    textTransform: "uppercase",
    letterSpacing: "0.6px",
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 13,
    color: "#fff",
    fontWeight: 500,
    wordBreak: "break-all",
  },
};
