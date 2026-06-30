import { useEffect, useRef, useState, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faFolder,
  faVolumeXmark,
  faVolumeHigh,
  faForwardStep,
  faBackwardStep,
  faRotateLeft,
  faRotateRight,
  faList,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

const AUTO_HIDE_DELAY = 3000;
const DB_NAME = "video-player-db";
const DB_STORE = "handles";
const DB_KEY = "lastFolder";

const supportsFSAccess =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

// ── Tiny IndexedDB helper (handles aren't JSON-serializable, so localStorage can't hold them) ──
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

export default function VideoPlayer() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const controlsTimer = useRef(null);

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
  const [isSeeking, setIsSeeking] = useState(false);
  const [playlist, setPlaylist] = useState([]);
  const [showPlaylist, setShowPlaylist] = useState(true);
  const [folderName, setFolderName] = useState("");
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [restoring, setRestoring] = useState(supportsFSAccess);

  const dirHandleRef = useRef(null);
  const currentVideo = playlist[currentIndex] ?? null;

  // Revoke old blob URLs on playlist change
  useEffect(() => {
    return () => playlist.forEach((v) => URL.revokeObjectURL(v.url));
  }, [playlist]);

  // Build playlist entries from a list of File objects
  const buildPlaylist = (files) => {
    const sorted = [...files]
      .filter((f) => f.type.startsWith("video/"))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    return sorted.map((file) => ({
      id: crypto.randomUUID(),
      title: file.name.replace(/\.[^/.]+$/, ""),
      name: file.name,
      size: file.size,
      url: URL.createObjectURL(file),
      file,
    }));
  };

  // Read all video files out of a directory handle
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

  // On mount: try to silently reconnect to the last folder via File System Access API
  useEffect(() => {
    if (!supportsFSAccess) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        const handle = await idbGet(DB_KEY);
        if (!handle) {
          setRestoring(false);
          return;
        }
        dirHandleRef.current = handle;
        setFolderName(handle.name);

        const perm = await handle.queryPermission({ mode: "read" });
        if (perm === "granted") {
          const files = await readDirHandle(handle);
          if (files.length) {
            setPlaylist(buildPlaylist(files));
            setCurrentIndex(0);
          }
        } else {
          // Browser requires a user gesture to re-grant — show a reconnect button
          setNeedsReconnect(true);
        }
      } catch {
        // handle may be stale/deleted folder — ignore, user can re-pick
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // Load new src whenever currentVideo changes — but do NOT autoplay
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentVideo) return;
    video.src = currentVideo.url;
    video.load();
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
  }, [currentVideo]);

  // Video event listeners
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
      setShowPlaylist(false); // hide playlist once playback starts
    };
    const onPause = () => setPlaying(false);
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length)
        setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onEnded = () => {
      setCurrentIndex((prev) => (prev < playlist.length - 1 ? prev + 1 : prev));
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

  // Fullscreen change
  useEffect(() => {
    const fn = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  }, []);

  // Keyboard shortcuts
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
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [volume]);

  // Controls auto-hide
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

  // ── Actions ──────────────────────────────────────────────────────────

  // Legacy <input webkitdirectory> path (no persistence possible across reloads)
  const loadFolder = (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    setPlaylist(buildPlaylist(files));
    setCurrentIndex(0);
    setFolderName(files[0]?.webkitRelativePath?.split("/")[0] ?? "");
    setNeedsReconnect(false);
  };

  // File System Access API path — handle gets saved to IndexedDB so it survives reloads
  const pickFolderFSAccess = async () => {
    try {
      const handle = await window.showDirectoryPicker();
      dirHandleRef.current = handle;
      await idbSet(DB_KEY, handle);
      setFolderName(handle.name);
      const files = await readDirHandle(handle);
      setPlaylist(buildPlaylist(files));
      setCurrentIndex(0);
      setNeedsReconnect(false);
    } catch {
      // user cancelled the picker — no-op
    }
  };

  const reconnectFolder = async () => {
    const handle = dirHandleRef.current;
    if (!handle) return;
    const perm = await handle.requestPermission({ mode: "read" });
    if (perm === "granted") {
      const files = await readDirHandle(handle);
      setPlaylist(buildPlaylist(files));
      setCurrentIndex(0);
      setNeedsReconnect(false);
    }
  };

  const openFolder = supportsFSAccess ? pickFolderFSAccess : null;

  const playPause = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await video.play();
    } else {
      video.pause();
    }
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

  // Reusable "open folder" control — uses File System Access picker when available,
  // otherwise falls back to the classic <input webkitdirectory> picker.
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

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {/* ── Left: Video + controls ── */}
      <div style={S.main}>
        {restoring ? (
          <div style={S.empty}>
            <div style={S.spinner} />
            <p style={S.emptyHint}>Reconnecting to your last folder…</p>
          </div>
        ) : needsReconnect ? (
          <div style={S.empty}>
            <button style={S.openBtn} onClick={reconnectFolder} type="button">
              <FontAwesomeIcon icon={faFolder} /> Reconnect to "{folderName}"
            </button>
            <p style={S.emptyHint}>
              Your browser needs a click to re-grant access to this folder.
            </p>
            <FolderPicker style={S.linkBtn}>
              Or pick a different folder
            </FolderPicker>
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
            <video ref={videoRef} style={S.video} preload="metadata" />

            {loading && (
              <div style={S.spinnerWrap}>
                <div style={S.spinner} />
              </div>
            )}

            {!currentVideo && (
              <div style={S.spinnerWrap}>
                <span style={{ color: "#888", fontSize: 14 }}>
                  Select a video
                </span>
              </div>
            )}

            {/* Playlist toggle — always visible, even with controls hidden */}
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

            <div
              style={{ ...S.overlay, opacity: showControls ? 1 : 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={S.titleBar}>
                <span style={S.titleText}>{currentVideo?.title ?? ""}</span>
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
                  <div
                    style={{ ...S.track, background: "rgba(255,255,255,0.15)" }}
                  >
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
                    onMouseDown={() => setIsSeeking(true)}
                    onMouseUp={() => setIsSeeking(false)}
                    onChange={(e) => seek(Number(e.target.value) / 100)}
                  />
                </div>

                <div style={S.ctrlRow}>
                  <div style={S.ctrlLeft}>
                    <button style={S.ctrlBtn} onClick={playPause}>
                      {playing ? "⏸" : "▶"}
                    </button>
                    <button
                      style={S.ctrlBtn}
                      onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}
                    >
                      <FontAwesomeIcon icon={faBackwardStep} />
                    </button>
                    <button
                      style={S.ctrlBtn}
                      onClick={() =>
                        setCurrentIndex((i) =>
                          Math.min(i + 1, playlist.length - 1),
                        )
                      }
                    >
                      <FontAwesomeIcon icon={faForwardStep} />
                    </button>
                    <FontAwesomeIcon
                      style={S.ctrlBtn}
                      onClick={toggleMute}
                      icon={muted ? faVolumeXmark : faVolumeHigh}
                    />
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.02"
                      value={muted ? 0 : volume}
                      style={{
                        ...S.rangeOverlay,
                        position: "relative",
                        width: 70,
                        height: 4,
                      }}
                      onChange={(e) => handleVolume(Number(e.target.value))}
                    />
                    <span style={S.timeText}>
                      {fmt(currentTime)} / {fmt(duration)}
                    </span>
                  </div>
                  <div style={S.ctrlRight}>
                    <div style={{ position: "relative" }}>
                      <button
                        style={S.ctrlBtn}
                        onClick={() => setShowSettings((v) => !v)}
                      >
                        {playbackRate}× ⚙
                      </button>
                      {showSettings && (
                        <div style={S.speedMenu}>
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                            <button
                              key={s}
                              style={{
                                ...S.speedItem,
                                fontWeight: playbackRate === s ? "700" : "400",
                              }}
                              onClick={() => changeSpeed(s)}
                            >
                              {s}×
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button style={S.ctrlBtn} onClick={toggleFullscreen}>
                      {fullscreen ? "⛶" : "⛶"}⛶
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: Playlist (slides in/out instead of unmounting, so it stays "hooked") ── */}
      {playlist.length > 0 && (
        <div style={{ ...S.sidebar, ...(showPlaylist ? {} : S.sidebarHidden) }}>
          <div style={S.sidebarHead}>
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
            {playlist.map((v, i) => (
              <div
                key={v.id}
                style={{
                  ...S.item,
                  ...(i === currentIndex ? S.itemActive : {}),
                }}
                onClick={() => setCurrentIndex(i)}
              >
                <div style={S.itemNum}>{i === currentIndex ? "▶" : i + 1}</div>
                <div style={S.itemBody}>
                  <div
                    style={{
                      ...S.itemTitle,
                      color: i === currentIndex ? "#e50914" : "#eee",
                    }}
                  >
                    {v.title}
                  </div>
                  <div style={S.itemMeta}>
                    {(v.size / 1048576).toFixed(1)} MB
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
  root: {
    display: "flex",
    width: "100%",
    height: "100vh",
    background: "var(--bg-main)",
    fontFamily: "var(--font-body)",
    overflow: "hidden",
    color: "var(--text-main)",
  },
  main: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#000",
    position: "relative",
    minWidth: 0,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 20,
  },
  openBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "14px 32px",
    borderRadius: "var(--radius-md)",
    background: "var(--primary-color)",
    color: "var(--text-main)",
    fontFamily: "var(--font-heading)",
    fontSize: "var(--fs-body)",
    letterSpacing: "1px",
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    transition: "background 0.2s ease, transform 0.2s ease",
    boxShadow: "0 4px 14px rgba(51, 144, 236, 0.3)",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 12,
    textDecoration: "underline",
    cursor: "pointer",
  },
  emptyHint: {
    color: "var(--text-muted)",
    fontSize: 13,
    margin: 0,
    letterSpacing: "-0.01em",
    textAlign: "center",
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
  spinner: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "3px solid rgba(255,255,255,0.1)",
    borderTopColor: "var(--text-main)",
    animation: "spin 0.8s linear infinite",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    background:
      "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, transparent 20%, transparent 80%, rgba(0,0,0,0.7) 100%)",
    transition: "opacity 0.3s cubic-bezier(0.25, 1, 0.5, 1)",
    zIndex: 3,
    cursor: "default",
  },
  playlistToggle: {
    position: "absolute",
    top: 20,
    right: 24,
    zIndex: 4,
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.12)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "var(--text-main)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    transition: "opacity 0.3s, background 0.2s",
  },
  titleBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 70px 20px 24px",
  },
  titleText: {
    color: "var(--text-main)",
    fontFamily: "var(--font-heading)",
    fontSize: "var(--fs-title)",
    fontWeight: 500,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    letterSpacing: "0.5px",
  },
  smallBtn: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    fontSize: 16,
    flexShrink: 0,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.08)",
    transition: "background 0.2s",
  },
  centerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 32,
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "var(--text-main)",
    fontSize: 15,
    cursor: "pointer",
    padding: "10px 16px",
    borderRadius: "var(--radius-md)",
    display: "flex",
    alignItems: "center",
    gap: 6,
    transition: "background 0.2s",
  },
  playBig: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.15)",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    color: "var(--text-main)",
    fontSize: 28,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.3)",
    transition: "transform 0.2s cubic-bezier(0.25, 1, 0.5, 1), background 0.2s",
  },
  bottomBar: { padding: "0 24px 24px" },
  progressWrap: {
    position: "relative",
    height: 16,
    marginBottom: 10,
    cursor: "pointer",
  },
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    transform: "translateY(-50%)",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    background: "rgba(255, 255, 255, 0.24)",
  },
  trackFill: {
    position: "absolute",
    left: 0,
    top: 0,
    height: "100%",
    borderRadius: 2,
    background: "var(--primary-color)",
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
  ctrlLeft: { display: "flex", alignItems: "center", gap: 12 },
  ctrlRight: { display: "flex", alignItems: "center", gap: 12 },
  ctrlBtn: {
    background: "none",
    border: "none",
    color: "var(--text-main)",
    fontSize: 20,
    cursor: "pointer",
    padding: "6px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
    transition: "opacity 0.2s",
  },
  timeText: {
    color: "var(--text-muted)",
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    marginLeft: 6,
    fontWeight: 500,
  },
  speedMenu: {
    position: "absolute",
    bottom: "130%",
    right: 0,
    background: "rgba(30, 41, 59, 0.75)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    borderRadius: 12,
    padding: "6px 0",
    zIndex: 10,
    minWidth: 110,
    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
  },
  speedItem: {
    display: "block",
    width: "100%",
    padding: "10px 20px",
    textAlign: "center",
    background: "none",
    border: "none",
    color: "var(--text-main)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    transition: "background 0.15s ease",
  },
  sidebar: {
    width: 320,
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-nav)",
    borderLeft: "1px solid rgba(255, 255, 255, 0.06)",
    flexShrink: 0,
    transition: "margin-right 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s",
  },
  sidebarHidden: {
    marginRight: -320,
    opacity: 0,
    pointerEvents: "none",
  },
  sidebarHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "24px 20px 16px",
    borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
    flexShrink: 0,
  },
  sidebarTitle: {
    color: "var(--text-main)",
    fontFamily: "var(--font-heading)",
    fontWeight: 500,
    fontSize: "var(--fs-title)",
    letterSpacing: "0.5px",
    flex: 1,
  },
  sidebarCount: { color: "var(--text-muted)", fontSize: 12, fontWeight: 500 },
  sidebarClose: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 14,
    cursor: "pointer",
    padding: 4,
  },
  sidebarList: { flex: 1, overflowY: "auto", padding: "12px 0" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "12px 20px",
    cursor: "pointer",
    transition: "background 0.2s, border-color 0.2s",
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "transparent",
  },
  itemActive: {
    background: "rgba(51, 144, 236, 0.08)",
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "var(--primary-color)",
  },
  itemNum: {
    width: 20,
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: 12,
    fontWeight: 600,
    flexShrink: 0,
  },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-main)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginBottom: 4,
    letterSpacing: "-0.01em",
  },
  itemMeta: { color: "var(--text-muted)", fontSize: 11, fontWeight: 500 },
  changeFolder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "14px",
    margin: "12px 20px 20px",
    borderRadius: "var(--radius-md)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    background: "var(--bg-card)",
    color: "var(--text-muted)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 0.2s, color 0.2s",
  },
};
