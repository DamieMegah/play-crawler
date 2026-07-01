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
  faKey,
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

const supportsFSAccess = typeof window !== "undefined" && "showDirectoryPicker" in window;
const QUALITY_RE = /\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i;

// ── IndexedDB helper (folder handles aren't JSON-able, so localStorage can't hold them) ──
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

// ── SRT -> VTT conversion (the only format <track> understands) ──
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}

export default function VideoPlayer() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const controlsTimer = useRef(null);
  const canvasRef = useRef(null);
  const recorderRef = useRef(null);
  const chunkBufferRef = useRef([]); // rolling { blob, t } chunks
  const trackUrlRef = useRef(null);

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
  const [playlist, setPlaylist] = useState([]); // grouped by base title -> { sources: [{url,file,quality,size}], thumb }
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
  const [osKey, setOsKey] = useState(localStorage.getItem("os_api_key") || "");

  const dirHandleRef = useRef(null);
  const currentEntry = playlist[currentIndex] ?? null;
  const currentSource = currentEntry
    ? currentEntry.sources.find((s) => s.quality === activeQuality) || currentEntry.sources[0]
    : null;

  // ── Cleanup blob URLs ──
  useEffect(() => {
    return () => {
      playlist.forEach((p) => {
        p.sources.forEach((s) => URL.revokeObjectURL(s.url));
        if (p.thumb) URL.revokeObjectURL(p.thumb);
      });
    };
  }, [playlist]);

  // ── Group raw files by title, stripping quality tags, and grab thumbnails ──
  const buildPlaylist = async (files) => {
    const sorted = [...files]
      .filter((f) => f.type.startsWith("video/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const groups = new Map();
    for (const file of sorted) {
      const rawName = file.name.replace(/\.[^/.]+$/, "");
      const qMatch = rawName.match(QUALITY_RE);
      const quality = qMatch ? qMatch[0].toLowerCase() : "source";
      const baseTitle = rawName.replace(QUALITY_RE, "").replace(/[\s._-]+$/, "").trim() || rawName;
      const url = URL.createObjectURL(file);
      if (!groups.has(baseTitle)) {
        groups.set(baseTitle, { id: crypto.randomUUID(), title: baseTitle, sources: [], thumb: null });
      }
      groups.get(baseTitle).sources.push({ quality, url, file, size: file.size });
    }

    const entries = [...groups.values()];
    // Generate poster thumbnails by seeking a hidden video element
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
            c.height = Math.round((320 * (v.videoHeight || 9)) / (v.videoWidth || 16));
            const ctx = c.getContext("2d");
            ctx.drawImage(v, 0, 0, c.width, c.height);
            c.toBlob((blob) => {
              entry.thumb = blob ? URL.createObjectURL(blob) : null;
              cleanup();
              resolve();
            }, "image/jpeg", 0.7);
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

  // ── Read directory handle into File[] ──
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

  // ── Restore last folder on mount ──
  useEffect(() => {
    if (!supportsFSAccess) {
      setRestoring(false);
      return;
    }
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
      } catch {
        // stale handle, ignore
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // ── Load source whenever current entry/quality changes ──
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
      // quality swap: keep position
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
  }, [currentSource?.url]);

  const autoplayNextRef = useRef(false);

  // ── Subtitle: when a movie is selected, clear previous track unless user reloads one ──
  useEffect(() => {
    setSubResults([]);
    setSubError("");
  }, [currentIndex]);

  // ── Auto-play whenever the index changes via explicit user click ──
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

  // ── Video element listeners ──
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
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
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

  // ── Rolling 30s recorder for clip-sharing ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    let stream, recorder, alive = true;

    const start = () => {
      try {
        stream = video.captureStream ? video.captureStream() : null;
        if (!stream) return;
        recorder = new MediaRecorder(stream, { mimeType: pickMime() });
        chunkBufferRef.current = [];
        recorder.ondataavailable = (e) => {
          if (!e.data || !e.data.size) return;
          chunkBufferRef.current.push({ blob: e.data, t: Date.now() });
          const cutoff = Date.now() - (CLIP_SECONDS + 2) * 1000;
          chunkBufferRef.current = chunkBufferRef.current.filter((c) => c.t >= cutoff);
        };
        recorder.start(CHUNK_MS);
        recorderRef.current = recorder;
      } catch {
        // captureStream/MediaRecorder unsupported — clip sharing will be disabled
      }
    };

    const onPlay = () => alive && start();
    const onPauseOrEnd = () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {}
      }
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPauseOrEnd);
    video.addEventListener("ended", onPauseOrEnd);
    return () => {
      alive = false;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPauseOrEnd);
      video.removeEventListener("ended", onPauseOrEnd);
      onPauseOrEnd();
    };
  }, [currentSource?.url]);

  function pickMime() {
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return candidates.find((c) => MediaRecorder.isTypeSupported?.(c)) || "video/webm";
  }

  // ── Fullscreen ──
  useEffect(() => {
    const fn = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
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
  }, [volume, currentIndex, playlist.length]);

  const hideControls = useCallback(() => {
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), AUTO_HIDE_DELAY);
  }, []);
  const revealControls = () => {
    setShowControls(true);
    if (playing) hideControls();
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
    } catch {
      // cancelled
    }
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

  // ── Playback actions ──
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
    if (!document.fullscreenElement) await playerRef.current?.requestFullscreen();
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

  const fmt = (t) => {
    if (!t || isNaN(t)) return "0:00";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const pct = (n, d) => (d ? Math.min((n / d) * 100, 100) : 0);

  // ── Rotate ──
  const rotate = () => setRotation((r) => (r + 90) % 360);

  // ── Screenshot ──
  const takeScreenshot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const c = canvasRef.current;
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 0, 0, c.width, c.height);
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

  // ── Clip sharing (last 30s) ──
  const buildClip = async () => {
    setClipBusy(true);
    try {
      // briefly stop the recorder to flush the final chunk
      if (recorderRef.current && recorderRef.current.state === "recording") {
        await new Promise((resolve) => {
          recorderRef.current.addEventListener("dataavailable", resolve, { once: true });
          recorderRef.current.requestData();
        });
      }
      const cutoff = Date.now() - CLIP_SECONDS * 1000;
      const chunks = chunkBufferRef.current.filter((c) => c.t >= cutoff).map((c) => c.blob);
      if (!chunks.length) {
        setSubError("");
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
    const file = new File([blob], `${(currentEntry?.title || "clip").replace(/\s+/g, "_")}.webm`, {
      type: blob.type,
    });
    const text = `Check out this clip from "${currentEntry?.title || "this video"}"`;

    // Native share sheet — works on most mobile browsers and lets the user pick
    // WhatsApp / Facebook / TikTok directly if those apps are installed.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, title: currentEntry?.title });
        return;
      } catch {
        // user cancelled or share failed — fall through to manual fallback
      }
    }

    // Desktop / unsupported fallback: download the clip, then open the target's
    // web composer. None of these platforms accept a video attachment via URL,
    // so the user drags the downloaded file in manually.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();

    if (target === "whatsapp") {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    } else if (target === "facebook") {
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`, "_blank");
    } else if (target === "tiktok") {
      window.open("https://www.tiktok.com/upload", "_blank");
    }
  };

  // ── Subtitles: local file ──
  const loadLocalSubtitle = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const vtt = file.name.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
    const blob = new Blob([vtt], { type: "text/vtt" });
    if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
    const url = URL.createObjectURL(blob);
    trackUrlRef.current = url;
    setSubtitleUrl(url);
    setSubtitlesOn(true);
    setShowSubMenu(false);
  };

  // ── Subtitles: OpenSubtitles search/download ──
  const saveOsKey = (k) => {
    setOsKey(k);
    localStorage.setItem("os_api_key", k);
  };

  const searchSubtitles = async () => {
    if (!currentEntry) return;
    if (!osKey) {
      setSubError("wrGWKjuGmouEKEbbko8ZO8HZjUihnXk8");
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
      if (!res.ok) throw new Error(`OpenSubtitles returned ${res.status}`);
      const data = await res.json();
      setSubResults((data.data || []).slice(0, 8));
      if (!data.data?.length) setSubError("No subtitles found for this title.");
    } catch (err) {
      setSubError(
        "Couldn't reach OpenSubtitles from the browser (likely blocked by CORS, or an invalid key). " +
          "You can still load a local .srt/.vtt file instead.",
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
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const json = await res.json();
      const fileRes = await fetch(json.link);
      const text = await fileRes.text();
      const vtt = json.link.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
      const blob = new Blob([vtt], { type: "text/vtt" });
      if (trackUrlRef.current) URL.revokeObjectURL(trackUrlRef.current);
      const url = URL.createObjectURL(blob);
      trackUrlRef.current = url;
      setSubtitleUrl(url);
      setSubtitlesOn(true);
      setShowSubMenu(false);
    } catch {
      setSubError("Couldn't download that subtitle file — try another result or upload one manually.");
    }
  };

  const FolderPicker = ({ children, style }) =>
    openFolder ? (
      <button style={style} onClick={openFolder} type="button">
        {children}
      </button>
    ) : (
      <label style={style}>
        {children}
        <input type="file" multiple accept="video/*" webkitdirectory="" directory="" hidden onChange={loadFolder} />
      </label>
    );

  return (
    <div style={S.root}>
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* ── Left: Video + controls ── */}
      <div style={S.main}>
        {restoring ? (
          <div style={S.empty}>
            <FontAwesomeIcon icon={faSpinner} spin size="2x" />
            <p style={S.emptyHint}>Reconnecting to your last folder…</p>
          </div>
        ) : needsReconnect ? (
          <div style={S.empty}>
            <button style={S.openBtn} onClick={reconnectFolder} type="button">
              <FontAwesomeIcon icon={faFolder} /> Reconnect to "{folderName}"
            </button>
            <p style={S.emptyHint}>Your browser needs a click to re-grant access to this folder.</p>
            <FolderPicker style={S.linkBtn}>Or pick a different folder</FolderPicker>
          </div>
        ) : playlist.length === 0 ? (
          <div style={S.empty}>
            <FolderPicker style={S.openBtn}>
              <FontAwesomeIcon icon={faFolder} /> Open Folder
            </FolderPicker>
            <p style={S.emptyHint}>
              {supportsFSAccess
                ? "This folder will be remembered next time you open the app."
                : "Select a folder containing video files"}
            </p>
          </div>
        ) : (
          <div
            ref={playerRef}
            style={{ ...S.player, cursor: showControls ? "default" : "none" }}
            onMouseMove={revealControls}
            onMouseLeave={() => playing && hideControls()}
            onClick={playPause}
          >
            <video
              ref={videoRef}
              style={{ ...S.video, transform: `rotate(${rotation}deg)` }}
              preload="metadata"
              crossOrigin="anonymous"
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
            {!currentEntry && (
              <div style={S.spinnerWrap}>
                <span style={{ color: "#888", fontSize: 14 }}>Select a video</span>
              </div>
            )}

            {/* Playlist toggle */}
            <button
              style={{ ...S.playlistToggle, opacity: showControls ? 1 : 0 }}
              onClick={(e) => {
                e.stopPropagation();
                setShowPlaylist((v) => !v);
              }}
              title="Toggle playlist (P)"
            >
              <FontAwesomeIcon icon={showPlaylist ? faXmark : faList} />
            </button>

            <div style={{ ...S.overlay, opacity: showControls ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
              <div style={S.titleBar}>
                <span style={S.titleText}>{currentEntry?.title ?? ""}</span>
                <FolderPicker style={S.smallBtn}>
                  <FontAwesomeIcon icon={faFolder} />
                </FolderPicker>
              </div>

              <div style={S.centerRow}>
                <button style={S.iconBtn} onClick={() => skip(-10)}>
                  10 <FontAwesomeIcon icon={faRotateLeft} />
                </button>
                <button style={S.playBig} onClick={playPause}>
                  {playing ? "⏸" : "▶"}
                </button>
                <button style={S.iconBtn} onClick={() => skip(10)}>
                  <FontAwesomeIcon icon={faRotateRight} /> 10
                </button>
              </div>

              <div style={S.bottomBar}>
                <div style={S.progressWrap}>
                  <div style={{ ...S.track, background: "rgba(255,255,255,0.15)" }}>
                    <div style={{ ...S.trackFill, width: `${pct(buffered, duration)}%`, background: "rgba(255,255,255,0.3)" }} />
                    <div style={{ ...S.trackFill, width: `${pct(currentTime, duration)}%`, background: "#e50914" }} />
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

                <div style={S.ctrlRow}>
                  <div style={S.ctrlLeft}>
                    <button style={S.ctrlBtn} onClick={playPause}>
                      {playing ? "⏸" : "▶"}
                    </button>
                    <button style={S.ctrlBtn} onClick={goPrev} title="Previous">
                      <FontAwesomeIcon icon={faBackwardStep} />
                    </button>
                    <button style={S.ctrlBtn} onClick={goNext} title="Next (N)">
                      <FontAwesomeIcon icon={faForwardStep} />
                    </button>
                    <FontAwesomeIcon
                      style={S.ctrlBtn}
                      onClick={toggleMute}
                      icon={muted || volume === 0 ? faVolumeXmark : volume < 0.5 ? faVolumeLow : faVolumeHigh}
                      title="Mute (M)"
                    />
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.02"
                      value={muted ? 0 : volume}
                      style={{ ...S.rangeOverlay, position: "relative", width: 70, height: 4 }}
                      onChange={(e) => handleVolume(Number(e.target.value))}
                    />
                    <span style={S.timeText}>
                      {fmt(currentTime)} / {fmt(duration)}
                    </span>
                  </div>

                  <div style={S.ctrlRight}>
                    {/* Screenshot */}
                    <div style={{ position: "relative" }}>
                      <button style={S.ctrlBtn} onClick={takeScreenshot} title="Screenshot (C)">
                        <FontAwesomeIcon icon={faCamera} />
                      </button>
                      {shotUrl && (
                        <div style={S.popMenu}>
                          <img src={shotUrl} alt="screenshot" style={S.shotPreview} />
                          <button style={S.popItem} onClick={downloadShot}>
                            Download
                          </button>
                          <button style={S.popItem} onClick={() => setShotUrl(null)}>
                            Close
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Share last 30s */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={S.ctrlBtn}
                        onClick={() => setShowShareMenu((v) => !v)}
                        title="Share last 30 seconds"
                      >
                        <FontAwesomeIcon icon={faShareNodes} />
                      </button>
                      {showShareMenu && (
                        <div style={S.popMenu}>
                          <div style={S.popLabel}>Share last {CLIP_SECONDS}s</div>
                          {clipBusy && <div style={S.popLabel}>Preparing clip…</div>}
                          <button style={S.popItem} onClick={() => shareClip("whatsapp")}>
                            <FontAwesomeIcon icon={faWhatsapp} /> WhatsApp
                          </button>
                          <button style={S.popItem} onClick={() => shareClip("facebook")}>
                            <FontAwesomeIcon icon={faFacebook} /> Facebook
                          </button>
                          <button style={S.popItem} onClick={() => shareClip("tiktok")}>
                            <FontAwesomeIcon icon={faTiktok} /> TikTok
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Subtitles */}
                    <div style={{ position: "relative" }}>
                      <button
                        style={{ ...S.ctrlBtn, opacity: subtitleUrl ? 1 : 0.6 }}
                        onClick={() => setShowSubMenu((v) => !v)}
                        title="Subtitles"
                      >
                        <FontAwesomeIcon icon={faClosedCaptioning} />
                      </button>
                      {showSubMenu && (
                        <div style={{ ...S.popMenu, width: 280 }}>
                          <div style={S.popLabel}>Subtitles</div>
                          {subtitleUrl && (
                            <label style={S.subToggleRow}>
                              <input
                                type="checkbox"
                                checked={subtitlesOn}
                                onChange={(e) => setSubtitlesOn(e.target.checked)}
                              />
                              Enabled
                            </label>
                          )}
                          <label style={S.popItem}>
                            Upload .srt / .vtt
                            <input type="file" accept=".srt,.vtt" hidden onChange={loadLocalSubtitle} />
                          </label>
                          <div style={S.popDivider} />
                          <div style={S.popLabel}>OpenSubtitles search</div>
                          <input
                            type="password"
                            placeholder="OpenSubtitles API key"
                            defaultValue={osKey}
                            onBlur={(e) => saveOsKey(e.target.value)}
                            style={S.keyInput}
                          />
                          <button style={S.popItem} onClick={searchSubtitles} disabled={subSearching}>
                            <FontAwesomeIcon icon={subSearching ? faSpinner : faMagnifyingGlass} spin={subSearching} />{" "}
                            Search for "{currentEntry?.title}"
                          </button>
                          {subError && <div style={S.subError}>{subError}</div>}
                          {subResults.map((r) => (
                            <button
                              key={r.id}
                              style={S.popItem}
                              onClick={() => downloadSubtitle(r)}
                            >
                              {r.attributes?.release || r.attributes?.feature_details?.title || "Subtitle"}{" "}
                              <span style={{ opacity: 0.6 }}>({r.attributes?.language})</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Rotate */}
                    <button style={S.ctrlBtn} onClick={rotate} title="Rotate">
                      <FontAwesomeIcon icon={faRepeat} />
                    </button>

                    {/* Quality */}
                    {currentEntry && currentEntry.sources.length > 1 && (
                      <div style={{ position: "relative" }}>
                        <button style={S.ctrlBtn} onClick={() => setShowQualityMenu((v) => !v)} title="Quality">
                          {activeQuality}
                        </button>
                        {showQualityMenu && (
                          <div style={S.popMenu}>
                            {currentEntry.sources.map((s) => (
                              <button
                                key={s.quality}
                                style={{ ...S.popItem, fontWeight: s.quality === activeQuality ? 700 : 400 }}
                                onClick={() => {
                                  autoplayNextRef.current = playing;
                                  setActiveQuality(s.quality);
                                  setShowQualityMenu(false);
                                }}
                              >
                                {s.quality}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Speed */}
                    <div style={{ position: "relative" }}>
                      <button style={S.ctrlBtn} onClick={() => setShowSettings((v) => !v)}>
                        <FontAwesomeIcon icon={faGear} /> {playbackRate}×
                      </button>
                      {showSettings && (
                        <div style={S.popMenu}>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                            <button
                              key={s}
                              style={{ ...S.popItem, fontWeight: playbackRate === s ? 700 : 400 }}
                              onClick={() => changeSpeed(s)}
                            >
                              {s}×
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <button style={S.ctrlBtn} onClick={toggleFullscreen}>
                      ⛶
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: Playlist with poster thumbnails ── */}
      {playlist.length > 0 && (
        <div style={{ ...S.sidebar, ...(showPlaylist ? {} : S.sidebarHidden) }}>
          <div style={S.sidebarHead}>
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
                style={{ ...S.item, ...(i === currentIndex ? S.itemActive : {}) }}
                onClick={() => playEntry(i)}
              >
                <div style={S.thumbWrap}>
                  {p.thumb ? (
                    <img src={p.thumb} alt={p.title} style={S.thumbImg} />
                  ) : (
                    <div style={S.thumbPlaceholder}>
                      <FontAwesomeIcon icon={faSpinner} spin />
                    </div>
                  )}
                  {i === currentIndex && playing && <div style={S.nowPlayingDot} />}
                </div>
                <div style={S.itemBody}>
                  <div style={{ ...S.itemTitle, color: i === currentIndex ? "#e50914" : "#eee" }}>{p.title}</div>
                  <div style={S.itemMeta}>
                    {p.sources.map((s) => s.quality).join(" · ")} ·{" "}
                    {(p.sources[0].size / 1048576).toFixed(1)} MB
                  </div>
                </div>
              </div>
            ))}
          </div>
          <FolderPicker style={S.changeFolder}>
            <FontAwesomeIcon icon={faFolder} /> Change Folder
          </FolderPicker>
        </div>
      )}
    </div>
  );
}

// ── Inline styles ───────────────────────────────────────────────────────
const S = {
  root: { display: "flex", width: "100%", height: "100vh", background: "var(--bg-main)", fontFamily: "var(--font-body)", overflow: "hidden", color: "var(--text-main)" },
  main: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", position: "relative", minWidth: 0 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 20 },
  openBtn: { display: "inline-flex", alignItems: "center", gap: 10, padding: "14px 32px", borderRadius: "var(--radius-md)", background: "var(--primary-color)", color: "var(--text-main)", fontFamily: "var(--font-heading)", fontSize: "var(--fs-body)", letterSpacing: "1px", fontWeight: 600, cursor: "pointer", border: "none", boxShadow: "0 4px 14px rgba(51, 144, 236, 0.3)" },
  linkBtn: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, textDecoration: "underline", cursor: "pointer" },
  emptyHint: { color: "var(--text-muted)", fontSize: 13, margin: 0, textAlign: "center", maxWidth: 260 },
  player: { position: "relative", width: "100%", height: "100%", background: "#000", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" },
  video: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000", display: "block", zIndex: 1, transition: "transform 0.3s ease" },
  spinnerWrap: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2, pointerEvents: "none" },
  overlay: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", background: "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, transparent 20%, transparent 80%, rgba(0,0,0,0.7) 100%)", transition: "opacity 0.3s cubic-bezier(0.25, 1, 0.5, 1)", zIndex: 3, cursor: "default" },
  playlistToggle: { position: "absolute", top: 20, right: 24, zIndex: 4, width: 36, height: 36, borderRadius: "50%", background: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255,255,255,0.08)", color: "var(--text-main)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(20px)", transition: "opacity 0.3s, background 0.2s" },
  titleBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 70px 20px 24px" },
  titleText: { color: "var(--text-main)", fontFamily: "var(--font-heading)", fontSize: "var(--fs-title)", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  smallBtn: { width: 36, height: 36, borderRadius: "50%", background: "rgba(255, 255, 255, 0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 16, flexShrink: 0, backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)" },
  centerRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 32 },
  iconBtn: { background: "none", border: "none", color: "var(--text-main)", fontSize: 15, cursor: "pointer", padding: "10px 16px", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", gap: 6 },
  playBig: { width: 72, height: 72, borderRadius: "50%", background: "rgba(255, 255, 255, 0.15)", border: "1px solid rgba(255, 255, 255, 0.25)", color: "var(--text-main)", fontSize: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(20px)", boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.3)" },
  bottomBar: { padding: "0 24px 24px" },
  progressWrap: { position: "relative", height: 16, marginBottom: 10, cursor: "pointer" },
  track: { position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)", height: 4, borderRadius: 2, overflow: "hidden", background: "rgba(255, 255, 255, 0.24)" },
  trackFill: { position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 2, background: "var(--primary-color)", transition: "width 0.1s linear" },
  rangeOverlay: { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", margin: 0 },
  ctrlRow: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 8 },
  ctrlLeft: { display: "flex", alignItems: "center", gap: 12 },
  ctrlRight: { display: "flex", alignItems: "center", gap: 10 },
  ctrlBtn: { background: "none", border: "none", color: "var(--text-main)", fontSize: 18, cursor: "pointer", padding: "6px", borderRadius: "var(--radius-sm)", lineHeight: 1 },
  timeText: { color: "var(--text-muted)", fontSize: 12, fontVariantNumeric: "tabular-nums", marginLeft: 6, fontWeight: 500 },
  popMenu: { position: "absolute", bottom: "130%", right: 0, background: "rgba(30, 41, 59, 0.92)", backdropFilter: "blur(20px)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: 12, padding: "8px 0", zIndex: 10, minWidth: 180, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" },
  popItem: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 16px", textAlign: "left", background: "none", border: "none", color: "var(--text-main)", fontSize: 13, fontWeight: 500, cursor: "pointer" },
  popLabel: { padding: "4px 16px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" },
  popDivider: { height: 1, background: "rgba(255,255,255,0.08)", margin: "6px 0" },
  shotPreview: { width: "100%", borderRadius: 8, marginBottom: 6 },
  subToggleRow: { display: "flex", alignItems: "center", gap: 8, padding: "4px 16px 8px", fontSize: 13 },
  keyInput: { margin: "4px 16px 8px", width: "calc(100% - 32px)", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.06)", color: "var(--text-main)", fontSize: 12 },
  subError: { padding: "6px 16px", fontSize: 11, color: "#f87171", lineHeight: 1.4 },
  sidebar: { width: 320, display: "flex", flexDirection: "column", background: "var(--bg-nav)", borderLeft: "1px solid rgba(255, 255, 255, 0.06)", flexShrink: 0, transition: "margin-right 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s" },
  sidebarHidden: { marginRight: -320, opacity: 0, pointerEvents: "none" },
  sidebarHead: { display: "flex", alignItems: "center", gap: 10, padding: "24px 20px 16px", borderBottom: "1px solid rgba(255, 255, 255, 0.06)", flexShrink: 0 },
  sidebarTitle: { color: "var(--text-main)", fontFamily: "var(--font-heading)", fontWeight: 500, fontSize: "var(--fs-title)", flex: 1 },
  sidebarCount: { color: "var(--text-muted)", fontSize: 12, fontWeight: 500 },
  sidebarClose: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", padding: 4 },
  sidebarList: { flex: 1, overflowY: "auto", padding: "12px 0" },
  item: { display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", cursor: "pointer", borderLeftWidth: "3px", borderLeftStyle: "solid", borderLeftColor: "transparent" },
  itemActive: { background: "rgba(51, 144, 236, 0.08)", borderLeftWidth: "3px", borderLeftStyle: "solid", borderLeftColor: "var(--primary-color)" },
  thumbWrap: { position: "relative", width: 80, height: 45, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.06)" },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbPlaceholder: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 },
  nowPlayingDot: { position: "absolute", top: 4, right: 4, width: 8, height: 8, borderRadius: "50%", background: "#e50914", boxShadow: "0 0 6px #e50914" },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: 13, fontWeight: 500, color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 },
  itemMeta: { color: "var(--text-muted)", fontSize: 11, fontWeight: 500, textTransform: "uppercase" },
  changeFolder: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px", margin: "12px 20px 20px", borderRadius: "var(--radius-md)", border: "1px solid rgba(255, 255, 255, 0.08)", background: "var(--bg-card)", color: "var(--text-muted)", fontSize: 13, fontWeight: 500, cursor: "pointer", flexShrink: 0 },
};