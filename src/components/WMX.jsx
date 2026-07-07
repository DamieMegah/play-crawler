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
import "../css/WMX.css";

const AUTO_HIDE_DELAY = 3000;
const DB_NAME = "video-player-db";
const DB_STORE = "handles";
const DB_KEY = "lastFolder";
const CLIP_SECONDS = 30;
const CHUNK_MS = 1000;
const WATERMARK_SAFE_TIMEOUT = 120_000; // 2 minutes max for watermark encoding

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

// Module-level store: lives outside React's component lifecycle, so it
// survives the VideoPlayer unmounting and remounting (navigating to another
// tab/route in the app and coming back). Only a hard page reload clears it.
// This is what lets "leaving the page" just pause playback instead of
// wiping the playlist, position, and settings.
const sessionStore = {
  playlist: [],
  currentIndex: -1,
  currentTime: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  activeQuality: null,
  rotation: 0,
  folderName: "",
  subtitleUrl: null,
  subtitlesOn: true,
  watermarkCustom: "Reels ",
  dirHandle: null,
};

const revokeEntries = (entries) => {
  entries.forEach((p) => {
    p.sources.forEach((s) => URL.revokeObjectURL(s.url));
    if (p.thumb) URL.revokeObjectURL(p.thumb);
  });
};

export default function VideoPlayer() {
  const videoInput = useRef(null);
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const controlsTimer = useRef(null);
  const canvasRef = useRef(null);
  const recorderRef = useRef(null);
  const chunkBufferRef = useRef([]);
  const trackUrlRef = useRef(null);
  const autoplayNextRef = useRef(false);
  const restoreAbortRef = useRef(null);
  const hasResumedRef = useRef(false);

  const winW = useWindowWidth();
  const isMobile = winW < 640;

  const hasSession = sessionStore.playlist.length > 0;

  const [currentIndex, setCurrentIndex] = useState(sessionStore.currentIndex);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(sessionStore.currentTime);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(sessionStore.volume);
  const [muted, setMuted] = useState(sessionStore.muted);
  const [playbackRate, setPlaybackRate] = useState(sessionStore.playbackRate);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [playlist, setPlaylist] = useState(sessionStore.playlist);
  const [showPlaylist, setShowPlaylist] = useState(!hasSession);
  const [folderName, setFolderName] = useState(sessionStore.folderName);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [restoring, setRestoring] = useState(supportsFSAccess && !hasSession);
  const [rotation, setRotation] = useState(sessionStore.rotation);
  const [activeQuality, setActiveQuality] = useState(
    sessionStore.activeQuality,
  );
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [clipBlob, setClipBlob] = useState(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [shotUrl, setShotUrl] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(sessionStore.subtitleUrl);
  const [subtitlesOn, setSubtitlesOn] = useState(sessionStore.subtitlesOn);
  const [showSubMenu, setShowSubMenu] = useState(false);
  const [subSearching, setSubSearching] = useState(false);
  const [subQuery, setSubQuery] = useState("");
  const [subResults, setSubResults] = useState([]);
  const [downloadingSubId, setDownloadingSubId] = useState(null);
  const [subError, setSubError] = useState("");
  const [showConverter, setShowConverter] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [convertStatus, setConvertStatus] = useState("idle");
  const [convertedUrl, setConvertedUrl] = useState(null);
  const [convertedName, setConvertedName] = useState("");
  const trackRef = useRef(null);
  const [activeCueText, setActiveCueText] = useState("");

  // Playlist item menu + detail modal + share
  const [itemMenuId, setItemMenuId] = useState(null);
  const [detailEntry, setDetailEntry] = useState(null);
  const [shareEntry, setShareEntry] = useState(null);
  const [shareStep, setShareStep] = useState("idle");
  const [shareUrl, setShareUrl] = useState(null);
  const [watermarkCustom, setWatermarkCustom] = useState(
    sessionStore.watermarkCustom,
  );

  const dirHandleRef = useRef(sessionStore.dirHandle);
  const currentEntry = playlist[currentIndex] ?? null;
  const currentSource = currentEntry
    ? currentEntry.sources.find((s) => s.quality === activeQuality) ||
      currentEntry.sources[0]
    : null;

  // Full watermark = custom text + immutable " | via impx" suffix
  const fullWatermark = (custom) => {
    const trimmed = custom.trim();
    return trimmed ? `${trimmed} | via WMX` : "via WMX";
  };

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
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (file.type.startsWith("video/")) files.push(file);
      }
    }
    return files;
  };

  const cancelRestore = () => {
    restoreAbortRef.current?.abort();
    setRestoring(false);
    setNeedsReconnect(false);
    setFolderName("");
    dirHandleRef.current = null;
    idbSet(DB_KEY, null).catch(() => {});
  };

  // NEW — drives the custom-subtitle-overlay div
  useEffect(() => {
    const trackEl = trackRef.current;
    if (!trackEl || !subtitleUrl || !subtitlesOn) {
      setActiveCueText("");
      return;
    }

    const textTrack = trackEl.track;
    if (!textTrack) return;

    const updateCues = () => {
      const cues = textTrack.activeCues;
      if (!cues || cues.length === 0) {
        setActiveCueText("");
        return;
      }
      setActiveCueText(
        Array.from(cues)
          .map((c) => c.text)
          .join("\n"),
      );
    };

    textTrack.mode = "hidden"; // cues still fire, browser still never draws them
    textTrack.addEventListener("cuechange", updateCues);
    return () => {
      textTrack.removeEventListener("cuechange", updateCues);
      setActiveCueText("");
    };
  }, [subtitleUrl, subtitlesOn]);

  useEffect(() => {
    if (hasSession) return setRestoring(false);
    if (!supportsFSAccess) return setRestoring(false);
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
          const files = await readDirHandle(handle, signal);
          if (signal.aborted) return;
          if (files.length) {
            const entries = await buildPlaylist(files, signal);
            if (signal.aborted) {
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
      } finally {
        if (!signal.aborted) setRestoring(false);
      }
    })();

    return () => ctrl.abort();
  }, []);

  // Keep the module-level store in sync so a later remount can pick up
  // exactly where this one left off.
  useEffect(() => {
    sessionStore.playlist = playlist;
    sessionStore.currentIndex = currentIndex;
    sessionStore.volume = volume;
    sessionStore.muted = muted;
    sessionStore.playbackRate = playbackRate;
    sessionStore.activeQuality = activeQuality;
    sessionStore.rotation = rotation;
    sessionStore.folderName = folderName;
    sessionStore.subtitleUrl = subtitleUrl;
    sessionStore.subtitlesOn = subtitlesOn;
    sessionStore.watermarkCustom = watermarkCustom;
    sessionStore.dirHandle = dirHandleRef.current;
  }, [
    playlist,
    currentIndex,
    volume,
    muted,
    playbackRate,
    activeQuality,
    rotation,
    folderName,
    subtitleUrl,
    subtitlesOn,
    watermarkCustom,
  ]);

  // Leaving the page (switching tabs) should only pause — never reset.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) videoRef.current?.pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Unmounting (navigating away within the app) should also just pause —
  // the playlist/position live in sessionStore, not in this component, so
  // there's nothing to tear down here.
  useEffect(() => {
    return () => {
      videoRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    const t = video.currentTime;
    video.src = currentSource.url;
    video.load();
    if (!hasResumedRef.current && sessionStore.currentTime > 0) {
      // First load after a remount with a live session: resume position,
      // but stay paused — leaving the page should only pause, not restart.
      hasResumedRef.current = true;
      const resumeTime = sessionStore.currentTime;
      setPlaying(false);
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = resumeTime;
          setCurrentTime(resumeTime);
        },
        { once: true },
      );
    } else if (!autoplayNextRef.current) {
      hasResumedRef.current = true;
      setPlaying(false);
      setCurrentTime(0);
    } else {
      hasResumedRef.current = true;
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
    setSubQuery(currentEntry?.title ?? "");
  }, [currentIndex, currentEntry]);

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

  const loadSingleVideo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const entries = await buildPlaylist([file]);

    revokeEntries(playlist);
    hasResumedRef.current = true;
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
      sessionStore.currentTime = video.currentTime;
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
    revokeEntries(playlist);
    hasResumedRef.current = true;
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
      revokeEntries(playlist);
      hasResumedRef.current = true;
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
      revokeEntries(playlist);
      hasResumedRef.current = true;
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

  // ────────────────────────────────────────────────────────────────────────
  // WATERMARK HELPERS — Fixed for Android + immutable "via impx" suffix
  // ────────────────────────────────────────────────────────────────────────
  const buildWatermarkedClip = (entry, clipBlobIn) => {
    const url = clipBlobIn
      ? URL.createObjectURL(clipBlobIn)
      : entry.sources[0].url;
    const needRevoke = !!clipBlobIn;

    return new Promise((resolve, reject) => {
      // Regular <canvas>, not OffscreenCanvas (Android support)
      const canvas = document.createElement("canvas");
      canvas.className = "vp-offscreen-canvas";
      document.body.appendChild(canvas);
      const ctx = canvas.getContext("2d");

      const vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.src = url;
      vid.crossOrigin = "anonymous";

      let rec = null;
      let running = false;
      const chunks = [];

      const cleanup = () => {
        running = false;
        if (needRevoke) URL.revokeObjectURL(url);
        try {
          canvas.remove();
        } catch {}
        try {
          vid.pause();
          vid.removeAttribute("src");
          vid.load();
        } catch {}
      };

      const finish = () => {
        if (!running) return;
        running = false;
        if (rec && rec.state !== "inactive") {
          rec.stop(); // onstop will handle resolve
        } else {
          cleanup();
          resolve(new Blob(chunks, { type: "video/webm" }));
        }
      };

      // 2-minute safety timeout — prevents forever-stuck on very long videos
      const safetyTimer = setTimeout(() => {
        console.warn(
          "Watermark: safety timeout fired after",
          WATERMARK_SAFE_TIMEOUT / 1000,
          "seconds",
        );
        finish();
      }, WATERMARK_SAFE_TIMEOUT);

      vid.addEventListener("loadedmetadata", () => {
        canvas.width = vid.videoWidth || 640;
        canvas.height = vid.videoHeight || 360;
        const W = canvas.width;
        const H = canvas.height;

        const mime =
          [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ].find((m) => MediaRecorder.isTypeSupported?.(m)) || "video/webm";

        let stream;
        try {
          const canvasStream = canvas.captureStream(30);
          // vid.muted only silences local playback — the captured stream
          // still carries the real decoded audio, so grab its audio
          // track(s) and merge them with the canvas's video track.
          let audioTracks = [];
          try {
            const audioSourceStream =
              typeof vid.captureStream === "function"
                ? vid.captureStream()
                : typeof vid.mozCaptureStream === "function"
                  ? vid.mozCaptureStream()
                  : null;
            if (audioSourceStream)
              audioTracks = audioSourceStream.getAudioTracks();
          } catch {
            // No audio track available (e.g. silent video or unsupported
            // browser) — fall back to video-only, same as before.
          }
          stream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioTracks,
          ]);
        } catch (err) {
          cleanup();
          clearTimeout(safetyTimer);
          reject(new Error("captureStream not supported: " + err.message));
          return;
        }

        rec = new MediaRecorder(stream, { mimeType: mime });
        rec.ondataavailable = (e) => {
          if (e.data?.size) chunks.push(e.data);
        };
        rec.onstop = () => {
          clearTimeout(safetyTimer);
          cleanup();
          resolve(new Blob(chunks, { type: mime }));
        };
        rec.onerror = () => {
          clearTimeout(safetyTimer);
          cleanup();
          reject(new Error("MediaRecorder error"));
        };

        rec.start(200);
        running = true;

        const wm = fullWatermark(watermarkCustom);

        const drawFrame = () => {
          if (!running) return;
          if (vid.ended || vid.paused) {
            finish();
            return;
          }

          ctx.drawImage(vid, 0, 0, W, H);

          // Watermark: bottom-right, shadow + white text
          const fsize = Math.max(13, Math.round(W * 0.028));
          ctx.save();
          ctx.font = `bold ${fsize}px sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          // Shadow
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillText(wm, W - 14, H - 12);
          // White text
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fillText(wm, W - 15, H - 13);
          ctx.restore();

          requestAnimationFrame(drawFrame);
        };

        vid.addEventListener(
          "playing",
          () => requestAnimationFrame(drawFrame),
          { once: true },
        );
        vid.addEventListener("ended", finish, { once: true });

        vid.play().catch((err) => {
          clearTimeout(safetyTimer);
          cleanup();
          reject(err);
        });
      });

      vid.addEventListener("error", (e) => {
        clearTimeout(safetyTimer);
        cleanup();
        reject(new Error("Video load error: " + (e.message || "unknown")));
      });
    });
  };

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

  const convertEntryToAudio = async (entry) => {
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
    if (!subQuery.trim()) return;
    setSubSearching(true);
    setSubError("");
    setSubResults([]);
    try {
      const res = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(subQuery.trim())}&languages=en`,
        {
          headers: {
            "Api-Key": import.meta.env.VITE_OPENSUBTITLES_API_KEY,
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
    setDownloadingSubId(item.id); //  show spinner on this item
    try {
      const fileId = item.attributes?.files?.[0]?.file_id;
      if (!fileId) throw new Error("No file id");
      const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
        method: "POST",
        headers: {
          "Api-Key": import.meta.env.VITE_OPENSUBTITLES_API_KEY,
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
      setSubResults([]);
      setShowSubMenu(false);
    } catch {
      setSubError(
        "Couldn't download that subtitle. Try another or upload manually.",
      );
    } finally {
      setDownloadingSubId(null);
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
      setConvertedUrl(url);
      setConvertedName(`${currentEntry?.title || "audio"}.wav`);
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

  const FolderPicker = ({ children, className }) =>
    openFolder ? (
      <button className={className} onClick={openFolder} type="button">
        {children}
      </button>
    ) : (
      <label className={className}>
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

  const playlistVisible = showPlaylist && playlist.length > 0;

  const ConverterModal = () => (
    <div className="vp-modal-backdrop" onClick={() => setShowConverter(false)}>
      <div className="vp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vp-modal-head">
          <FontAwesomeIcon icon={faFileAudio} className="vp-modal-head-icon" />
          <span className="vp-modal-title">Video to Audio (WAV)</span>
          <button
            className="vp-modal-close"
            onClick={() => setShowConverter(false)}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
        <div className="vp-modal-body">
          <div className="vp-converter-info">
            <FontAwesomeIcon icon={faFilm} className="vp-converter-info-icon" />
            <span className="vp-converter-info-title">
              {currentEntry?.title}
            </span>
          </div>
          {convertStatus !== "idle" && (
            <div className="vp-converter-progress">
              <div className="vp-converter-bar">
                <div
                  className={`vp-converter-fill ${
                    convertStatus === "error"
                      ? "status-error"
                      : convertStatus === "done"
                        ? "status-done"
                        : ""
                  }`}
                  style={{ "--vp-convert-progress": `${convertProgress}%` }}
                />
              </div>
              <span
                className={`vp-converter-label ${
                  convertStatus === "error"
                    ? "status-error"
                    : convertStatus === "done"
                      ? "status-done"
                      : ""
                }`}
              >
                {convertStatus === "decoding" && (
                  <>
                    <FontAwesomeIcon icon={faSpinner} spin />
                    Decoding audio…
                  </>
                )}
                {convertStatus === "encoding" && (
                  <>
                    <FontAwesomeIcon icon={faSpinner} spin />
                    Encoding WAV…
                  </>
                )}
                {convertStatus === "done" && (
                  <>
                    <FontAwesomeIcon icon={faCheck} />
                    Done! Ready to download.
                  </>
                )}
                {convertStatus === "error" &&
                  "Conversion failed. The video may have no audio track, or the format is unsupported."}
              </span>
            </div>
          )}
          <p className="vp-converter-note">
            Audio is extracted entirely in your browser — no upload, no server.
            The output is a standard WAV file that plays in any music or video
            app.
          </p>
          <div className="vp-converter-actions">
            {convertStatus === "idle" || convertStatus === "error" ? (
              <button className="vp-converter-btn" onClick={convertToAudio}>
                <FontAwesomeIcon icon={faMusic} />
                Extract Audio
              </button>
            ) : convertStatus === "done" ? (
              <>
                <button className="vp-converter-btn" onClick={downloadAudio}>
                  <FontAwesomeIcon icon={faDownload} />
                  Download Audio
                </button>
                <button
                  className="vp-converter-btn vp-converter-btn--secondary"
                  onClick={convertToAudio}
                >
                  <FontAwesomeIcon icon={faRepeat} />
                  Re-convert
                </button>
              </>
            ) : (
              <button
                className="vp-converter-btn vp-converter-btn--disabled"
                disabled
              >
                <FontAwesomeIcon icon={faSpinner} spin />
                Converting…
              </button>
            )}
            <button
              className="vp-converter-btn vp-converter-btn--ghost"
              onClick={() => setShowConverter(false)}
            >
              <FontAwesomeIcon icon={faXmark} />
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="vp-root">
      <canvas ref={canvasRef} className="vp-hidden-canvas" />
      {showConverter && <ConverterModal />}

      <div className="vp-main">
        {restoring ? (
          <div className="vp-empty">
            <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
            <p className="vp-empty-hint">
              Reconnecting to "{folderName || "last folder"}"…
            </p>
            <button
              className="vp-cancel-restore-btn"
              onClick={cancelRestore}
              type="button"
            >
              <FontAwesomeIcon icon={faXmark} />
              Select New Folder Instead
            </button>
            <p className="vp-empty-hint vp-empty-hint--small">
              Cancels the reconnect and clears the saved folder.
            </p>
          </div>
        ) : needsReconnect ? (
          <div className="vp-empty">
            <button
              className="vp-open-btn"
              onClick={reconnectFolder}
              type="button"
            >
              <FontAwesomeIcon icon={faFolder} />
              <span>Reconnect to "{folderName}"</span>
            </button>
            <p className="vp-empty-hint">
              Your browser needs permission to access this folder again.
            </p>
            <FolderPicker className="vp-link-btn">
              Or pick a different folder
            </FolderPicker>
          </div>
        ) : playlist.length === 0 ? (
          <div className="vp-empty">
            <button
              type="button"
              className="vp-open-btn vp-open-btn--top-margin"
              onClick={() => videoInput.current?.click()}
            >
              <FontAwesomeIcon icon={faFilm} />
              <span>Select A Video</span>
            </button>

            <input
              ref={videoInput}
              type="file"
              accept="video/*"
              hidden
              onChange={loadSingleVideo}
            />
            <FolderPicker className="vp-open-btn">
              <FontAwesomeIcon icon={faFolder} />
              <span>Open Folder</span>
            </FolderPicker>
            <p className="vp-empty-hint">
              {supportsFSAccess
                ? "This folder will be remembered next time."
                : "Select a folder containing video files"}
            </p>
          </div>
        ) : (
          <div
            ref={playerRef}
            className={`vp-player ${showControls ? "controls-visible" : "controls-hidden"}`}
            onMouseMove={!isMobile ? revealControls : undefined}
            onMouseLeave={() => !isMobile && playing && hideControls()}
            onClick={handleVideoTap}
          >
            <video
              ref={videoRef}
              className="vp-video"
              style={{ "--vp-rotation": `${rotation}deg` }}
              preload="metadata"
              crossOrigin="anonymous"
              playsInline
            >
              {subtitleUrl && subtitlesOn && (
                <track
                  ref={trackRef} // NEW
                  kind="metadata"
                  src={subtitleUrl}
                  srcLang="en"
                  label="Subtitle"
                  default
                />
              )}
            </video>

            {loading && (
              <div className="vp-spinner-wrap">
                <FontAwesomeIcon icon={faSpinner} spin size="2x" color="#fff" />
              </div>
            )}

            <button
              className={`vp-playlist-toggle ${showControls ? "visible" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setShowPlaylist((v) => !v);
              }}
              title="Toggle playlist (P)"
            >
              <FontAwesomeIcon icon={showPlaylist ? faChevronDown : faList} />
            </button>

            <div
              className={`vp-overlay ${showControls ? "visible" : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="vp-title-bar">
                <span className="vp-title-text">
                  {currentEntry?.title ?? ""}
                </span>
                <FolderPicker className="vp-small-btn">
                  <FontAwesomeIcon icon={faFolder} />
                </FolderPicker>
              </div>

              <div className="vp-center-row">
                <button className="vp-icon-btn" onClick={() => skip(-10)}>
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span className="vp-icon-btn__label">10</span>
                </button>
                <button
                  className="vp-play-big"
                  onClick={(e) => {
                    e.stopPropagation();
                    playPause();
                  }}
                >
                  <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                </button>
                <button className="vp-icon-btn" onClick={() => skip(10)}>
                  <span className="vp-icon-btn__label">10</span>
                  <FontAwesomeIcon icon={faRotateRight} />
                </button>
              </div>

              <div className="vp-overlay-bottom">
                <div className="vp-progress-wrap">
                  <div className="vp-track">
                    <div
                      className="vp-track-fill vp-track-fill--buffered"
                      style={{
                        "--vp-buffered-pct": `${pct(buffered, duration)}%`,
                      }}
                    />
                    <div
                      className="vp-track-fill vp-track-fill--played"
                      style={{
                        "--vp-played-pct": `${pct(currentTime, duration)}%`,
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={pct(currentTime, duration)}
                    className="vp-range-overlay"
                    onChange={(e) => seek(Number(e.target.value) / 100)}
                  />
                </div>

                <div className="vp-ctrl-row">
                  <div className="vp-ctrl-left">
                    <button
                      className="vp-ctrl-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        playPause();
                      }}
                    >
                      <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                    </button>
                    <button className="vp-ctrl-btn" onClick={goPrev}>
                      <FontAwesomeIcon icon={faBackwardStep} />
                    </button>
                    <button className="vp-ctrl-btn" onClick={goNext}>
                      <FontAwesomeIcon icon={faForwardStep} />
                    </button>
                    <button className="vp-ctrl-btn" onClick={toggleMute}>
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
                        className="vp-volume-range"
                        onChange={(e) => handleVolume(Number(e.target.value))}
                      />
                    )}
                    <span className="vp-time-text">
                      {fmt(currentTime)} / {fmt(duration)}
                    </span>
                  </div>

                  <div className="vp-ctrl-right">
                    <div className="vp-dropdown-wrap">
                      <button
                        className="vp-ctrl-btn"
                        onClick={takeScreenshot}
                        title="Screenshot"
                      >
                        <FontAwesomeIcon icon={faCamera} />
                      </button>
                      {shotUrl && (
                        <div className="vp-pop-menu">
                          <img
                            src={shotUrl}
                            alt="screenshot"
                            className="vp-shot-preview"
                          />
                          <button
                            className="vp-pop-item"
                            onClick={downloadShot}
                          >
                            <FontAwesomeIcon icon={faDownload} />
                            <span>Download</span>
                          </button>
                          <button
                            className="vp-pop-item"
                            onClick={() => setShotUrl(null)}
                          >
                            <FontAwesomeIcon icon={faXmark} />
                            <span>Close</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="vp-dropdown-wrap">
                      <button
                        className="vp-ctrl-btn"
                        onClick={() => setShowShareMenu((v) => !v)}
                        title="Share last 30s as reels"
                      >
                        <FontAwesomeIcon icon={faShareNodes} />
                      </button>
                      {showShareMenu && (
                        <div className="vp-pop-menu">
                          <div className="vp-pop-label">
                            Share last {CLIP_SECONDS}s
                            <button
                              className="vp-pop-close"
                              onClick={() => setShowShareMenu((v) => !v)}
                            >
                              X
                            </button>
                          </div>
                          {clipBusy && (
                            <div className="vp-pop-label">
                              <FontAwesomeIcon icon={faSpinner} spin />
                              Preparing clip…
                            </div>
                          )}
                          <button
                            className="vp-pop-item"
                            onClick={() => shareClipWatermarked("whatsapp")}
                          >
                            <FontAwesomeIcon icon={faWhatsapp} />
                            <span>WhatsApp</span>
                          </button>
                          <button
                            className="vp-pop-item"
                            onClick={() => shareClipWatermarked("facebook")}
                          >
                            <FontAwesomeIcon icon={faFacebook} />
                            <span>Facebook</span>
                          </button>
                          <button
                            className="vp-pop-item"
                            onClick={() => shareClipWatermarked("tiktok")}
                          >
                            <FontAwesomeIcon icon={faTiktok} />
                            <span>TikTok</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="vp-dropdown-wrap">
                      <button
                        className={`vp-ctrl-btn vp-ctrl-btn--subtitle ${subtitleUrl ? "has-subtitle" : ""}`}
                        onClick={() => setShowSubMenu((v) => !v)}
                        title="Subtitles"
                      >
                        <FontAwesomeIcon icon={faClosedCaptioning} />
                      </button>
                      {showSubMenu && (
                        <div className="vp-pop-menu vp-pop-menu--wide">
                          <div className="vp-pop-label">
                            Subtitles
                            <button
                              className="vp-pop-close vp-pop-close--wide"
                              onClick={() => setShowSubMenu((v) => !v)}
                            >
                              X
                            </button>
                          </div>
                          {subtitleUrl && (
                            <button
                              className="vp-pop-item"
                              onClick={() => setSubtitlesOn((v) => !v)}
                            >
                              <FontAwesomeIcon
                                icon={
                                  subtitlesOn ? faCheck : faClosedCaptioning
                                }
                              />
                              <span>
                                {subtitlesOn ? "Enabled" : "Disabled"}
                              </span>
                            </button>
                          )}
                          <label className="vp-pop-item">
                            <FontAwesomeIcon icon={faFilm} />
                            <span style={{ textDecoration: "underline" }}>
                              Upload subtitle .srt / .vtt
                            </span>
                            <input
                              type="file"
                              accept=".srt,.vtt"
                              hidden
                              onChange={loadLocalSubtitle}
                            />
                          </label>
                          <div className="vp-pop-divider" />
                          <div className="vp-pop-label">
                            OpenSubtitles Search
                          </div>
                          <button
                            className="vp-pop-item"
                            onClick={searchSubtitles}
                            disabled={subSearching}
                          >
                            <FontAwesomeIcon
                              icon={
                                subSearching ? faSpinner : faMagnifyingGlass
                              }
                              spin={subSearching}
                            />
                            <span>Search "{currentEntry?.title}"</span>
                          </button>

                          {/* Search Input field element wrapper */}
                          <div
                            style={{
                              display: "flex",
                              gap: "6px",
                              padding: "4px 8px",
                            }}
                          >
                            <input
                              type="text"
                              className="vp-wm-input"
                              style={{ margin: 0, flex: 1 }}
                              value={subQuery}
                              placeholder="Type subtitle name..."
                              onChange={(e) => setSubQuery(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.stopPropagation();
                                  searchSubtitles();
                                }
                              }}
                            />
                            <button
                              className="vp-small-btn"
                              style={{ padding: "0 10px", height: "auto" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                searchSubtitles();
                              }}
                              disabled={subSearching || !subQuery.trim()}
                              title="Search Subtitles"
                            >
                              <FontAwesomeIcon
                                icon={
                                  subSearching ? faSpinner : faMagnifyingGlass
                                }
                                spin={subSearching}
                              />
                            </button>
                          </div>

                          {subError && (
                            <div className="vp-sub-error">{subError}</div>
                          )}
                          {subResults.map((r) => {
                            const isDownloading = downloadingSubId === r.id;
                            return (
                              <button
                                key={r.id}
                                className="sub-result"
                                onClick={() => downloadSubtitle(r)}
                                disabled={downloadingSubId !== null}
                              >
                                <FontAwesomeIcon
                                  icon={isDownloading ? faSpinner : faDownload}
                                  spin={isDownloading}
                                />
                                <span>
                                  {isDownloading
                                    ? "Downloading…"
                                    : r.attributes?.release ||
                                      r.attributes?.feature_details?.title ||
                                      "Subtitle"}
                                  {!isDownloading && (
                                    <span className="vp-lang-tag">
                                      ({r.attributes?.language})
                                    </span>
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <button
                      className="vp-ctrl-btn"
                      onClick={rotate}
                      title="Rotate"
                    >
                      <FontAwesomeIcon icon={faRepeat} />
                    </button>

                    <button
                      className="vp-ctrl-btn"
                      onClick={() => setShowConverter(true)}
                      title="Extract Audio (WAV)"
                    >
                      <FontAwesomeIcon icon={faMusic} />
                    </button>

                    {currentEntry?.sources.length > 1 && (
                      <div className="vp-dropdown-wrap">
                        <button
                          className="vp-ctrl-btn vp-ctrl-btn--quality"
                          onClick={() => setShowQualityMenu((v) => !v)}
                        >
                          {activeQuality}
                        </button>
                        {showQualityMenu && (
                          <div className="vp-pop-menu">
                            <div className="vp-pop-label">Quality</div>
                            {currentEntry.sources.map((s) => (
                              <button
                                key={s.quality}
                                className={`vp-pop-item ${s.quality === activeQuality ? "active" : ""}`}
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
                                <span>{s.quality}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="vp-dropdown-wrap">
                      <button
                        style={{ zIndex: "1010" }}
                        className="vp-ctrl-btn vp-ctrl-btn--gear"
                        onClick={() => setShowSettings((v) => !v)}
                      >
                        <FontAwesomeIcon
                          icon={faGear}
                          style={{ fontSize: "1.4rem" }}
                        />
                      </button>
                      {showSettings && (
                        <div className="vp-pop-menu">
                          <button
                            onClick={() => setShowSettings((v) => !v)}
                            className="vp-pop-close vp-pop-close--wide"
                          >
                            X
                          </button>
                          <div className="vp-pop-label">Playback Speed</div>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                            <button
                              key={s}
                              className={`vp-pop-item ${playbackRate === s ? "active" : ""}`}
                              onClick={() => changeSpeed(s)}
                            >
                              <FontAwesomeIcon
                                icon={playbackRate === s ? faCheck : faGear}
                              />
                              <span>{s}×</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      className="vp-ctrl-btn"
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
            {activeCueText && (
              <div className="custom-subtitle-overlay">
                {activeCueText.split("\n").map((line, i) => (
                  <span key={i} className="custom-subtitle-line">
                    {line.replace(/<[^>]+>/g, "")}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {playlist.length > 0 && (
        <div className={`vp-sidebar ${playlistVisible ? "" : "hidden"}`}>
          {isMobile && (
            <div
              className="vp-drag-handle"
              onClick={() => setShowPlaylist((v) => !v)}
            >
              <div className="vp-drag-handle-pill" />
            </div>
          )}
          <div className="vp-sidebar-head">
            <FontAwesomeIcon icon={faList} className="vp-icon-muted" />
            <span className="vp-sidebar-title">Playlist</span>
            <span className="vp-sidebar-count">{playlist.length} videos</span>
            <button
              className="vp-sidebar-close"
              onClick={() => setShowPlaylist(false)}
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
          <div className="vp-sidebar-list">
            {playlist.map((p, i) => (
              <div
                key={p.id}
                className={`vp-item ${i === currentIndex ? "active" : ""}`}
                onClick={() => {
                  playEntry(i);
                  if (isMobile) setShowPlaylist(false);
                }}
              >
                <div className="vp-thumb-wrap">
                  {p.thumb ? (
                    <img src={p.thumb} alt={p.title} className="vp-thumb-img" />
                  ) : (
                    <div className="vp-thumb-placeholder">
                      <FontAwesomeIcon icon={faFilm} />
                    </div>
                  )}
                  {i === currentIndex && (
                    <div className="vp-now-playing-badge">
                      <FontAwesomeIcon icon={playing ? faPause : faPlay} />
                    </div>
                  )}
                </div>

                <div className="vp-item-body">
                  <div
                    className={`vp-item-title ${i === currentIndex ? "active" : ""}`}
                  >
                    {p.title}
                  </div>
                  <div className="vp-item-meta">
                    {p.sources.map((s) => s.quality).join(" · ")} ·{" "}
                    {(p.sources[0].size / 1048576).toFixed(1)} MB
                  </div>
                </div>

                <button
                  className="vp-dot-btn"
                  title="More options"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemMenuId((prev) => (prev === p.id ? null : p.id));
                  }}
                >
                  <FontAwesomeIcon icon={faEllipsisVertical} />
                </button>

                {itemMenuId === p.id && (
                  <div
                    className="vp-item-menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="vp-item-menu-item"
                      onClick={() => {
                        setItemMenuId(null);
                        convertEntryToAudio(p);
                      }}
                    >
                      <FontAwesomeIcon
                        icon={faMusic}
                        className="vp-item-menu-icon"
                      />
                      <div>
                        <div className="vp-item-menu-label">
                          Convert to Audio
                        </div>
                        <div className="vp-item-menu-sub">
                          Extract WAV from video
                        </div>
                      </div>
                    </button>

                    <div className="vp-item-menu-divider" />

                    <button
                      className="vp-item-menu-item"
                      onClick={() => {
                        setItemMenuId(null);
                        setDetailEntry(p);
                      }}
                    >
                      <FontAwesomeIcon
                        icon={faCircleInfo}
                        className="vp-item-menu-icon"
                      />
                      <div>
                        <div className="vp-item-menu-label">Video Details</div>
                        <div className="vp-item-menu-sub">
                          Size, quality, format
                        </div>
                      </div>
                    </button>

                    <div className="vp-item-menu-divider" />

                    <div className="vp-item-menu-section">
                      <div className="vp-item-menu-label vp-item-menu-label--section">
                        <FontAwesomeIcon icon={faShareNodes} /> Share (with
                        watermark)
                      </div>
                      <div className="vp-share-chips">
                        <button
                          className="vp-share-chip"
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "whatsapp");
                          }}
                        >
                          <FontAwesomeIcon icon={faWhatsapp} />
                          WhatsApp
                        </button>
                        <button
                          className="vp-share-chip"
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "facebook");
                          }}
                        >
                          <FontAwesomeIcon icon={faFacebook} />
                          Facebook
                        </button>
                        <button
                          className="vp-share-chip"
                          onClick={() => {
                            setItemMenuId(null);
                            shareEntryVideo(p, "tiktok");
                          }}
                        >
                          <FontAwesomeIcon icon={faTiktok} />
                          TikTok
                        </button>
                      </div>
                    </div>

                    <div className="vp-item-menu-section--wm">
                      <div className="vp-item-menu-sub">
                        <FontAwesomeIcon icon={faStamp} /> Watermark text
                        (custom part)
                      </div>
                      <input
                        className="vp-wm-input"
                        value={watermarkCustom}
                        maxLength={30}
                        onChange={(e) => setWatermarkCustom(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Your name or brand…"
                      />
                      <div className="vp-wm-preview">
                        Full watermark: "
                        <strong>{fullWatermark(watermarkCustom)}</strong>"
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <FolderPicker className="vp-change-folder">
            <FontAwesomeIcon icon={faFolder} />
            <span>Change Folder</span>
          </FolderPicker>
        </div>
      )}

      {detailEntry && (
        <div className="vp-modal-backdrop" onClick={() => setDetailEntry(null)}>
          <div
            className="vp-modal vp-modal--sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vp-modal-head">
              <FontAwesomeIcon
                icon={faCircleInfo}
                className="vp-modal-head-icon"
              />
              <span className="vp-modal-title">Video Details</span>
              <button
                className="vp-modal-close"
                onClick={() => setDetailEntry(null)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
            <div className="vp-modal-body">
              {detailEntry.thumb && (
                <img
                  src={detailEntry.thumb}
                  alt={detailEntry.title}
                  className="vp-detail-thumb"
                />
              )}
              <div className="vp-detail-grid">
                <div className="vp-detail-row">
                  <FontAwesomeIcon icon={faFilm} className="vp-detail-icon" />
                  <div>
                    <div className="vp-detail-label">Title</div>
                    <div className="vp-detail-value">{detailEntry.title}</div>
                  </div>
                </div>
                {detailEntry.sources.map((s, si) => (
                  <div key={si} className="vp-detail-row">
                    <FontAwesomeIcon icon={faHdd} className="vp-detail-icon" />
                    <div>
                      <div className="vp-detail-label">
                        Source {si + 1} — {s.quality.toUpperCase()}
                      </div>
                      <div className="vp-detail-value">
                        {(s.size / 1048576).toFixed(2)} MB &nbsp;·&nbsp;{" "}
                        {s.file.type || "unknown"}
                      </div>
                    </div>
                  </div>
                ))}
                <div className="vp-detail-row">
                  <FontAwesomeIcon
                    icon={faCalendar}
                    className="vp-detail-icon"
                  />
                  <div>
                    <div className="vp-detail-label">Last Modified</div>
                    <div className="vp-detail-value">
                      {detailEntry.sources[0].file.lastModified
                        ? new Date(
                            detailEntry.sources[0].file.lastModified,
                          ).toLocaleString()
                        : "—"}
                    </div>
                  </div>
                </div>
                <div className="vp-detail-row">
                  <FontAwesomeIcon icon={faStamp} className="vp-detail-icon" />
                  <div>
                    <div className="vp-detail-label">
                      Watermark Text ( Enter custom watermark )
                    </div>
                    <input
                      className="vp-wm-input vp-wm-input--full"
                      value={watermarkCustom}
                      maxLength={30}
                      onChange={(e) => setWatermarkCustom(e.target.value)}
                      placeholder="Your name or brand…"
                    />
                    <div className="vp-wm-preview vp-wm-preview--modal">
                      Full watermark: "
                      <strong>{Watermark(watermarkCustom)}</strong>"
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {shareEntry && shareStep !== "idle" && (
        <div
          className="vp-modal-backdrop"
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
            className="vp-modal vp-modal--xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vp-modal-head">
              <FontAwesomeIcon icon={faStamp} className="vp-modal-head-icon" />
              <span className="vp-modal-title">
                Preparing Watermarked Video
              </span>
              {shareStep !== "building" && (
                <button
                  className="vp-modal-close"
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
            <div className="vp-modal-body">
              <div className="vp-converter-info">
                <FontAwesomeIcon
                  icon={faFilm}
                  className="vp-converter-info-icon"
                />
                <span className="vp-converter-info-title">
                  {shareEntry.title}
                </span>
              </div>
              <div className="vp-share-status">
                {shareStep === "building" && (
                  <>
                    <FontAwesomeIcon
                      icon={faSpinner}
                      spin
                      size="2x"
                      className="vp-share-status-icon building"
                    />
                    <div className="vp-share-status-text building">
                      Rendering frames with watermark… this may take a moment.
                    </div>
                  </>
                )}
                {shareStep === "done" && (
                  <>
                    <FontAwesomeIcon
                      icon={faCheck}
                      size="2x"
                      className="vp-share-status-icon done"
                    />
                    <div className="vp-share-status-text done">
                      Done! File downloaded and share dialog opened.
                    </div>
                  </>
                )}
                {shareStep === "error" && (
                  <>
                    <FontAwesomeIcon
                      icon={faXmark}
                      size="2x"
                      className="vp-share-status-icon error"
                    />
                    <div className="vp-share-status-text error">
                      Failed to render watermark. The video format may not be
                      supported by your browser's encoder.
                    </div>
                  </>
                )}
              </div>
              <p className="vp-converter-note">
                The watermark "
                <strong className="vp-wm-strong-white">
                  {fullWatermark(watermarkCustom)}
                </strong>
                " is burned into the bottom-right corner of every frame. No data
                is uploaded — everything happens in your browser.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
