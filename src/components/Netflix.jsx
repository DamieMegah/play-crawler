import { useState, useEffect, useRef } from "react";
import { getNetflixMovies } from "../services/api";
import MovieCard from "../components/MovieCard";
import Loading from "../components/Loading";
import "../css/Netflix.css";

// Safe cache reader — same pattern as Genre.jsx fix.
// Prevents "undefined" / corrupt JSON from crashing the page.
function safeGetCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw === "undefined" || raw === "null") {
      localStorage.removeItem(key);
      return null;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function safeSetCache(key, value) {
  try {
    if (Array.isArray(value) && value.length > 0) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {}
}

function Netflix() {
  const [netflixMovies, setNetflixMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeAutoplayId, setActiveAutoplayId] = useState(null);
  const [hoveredMovieId, setHoveredMovieId] = useState(null);
  const timersRef = useRef({});

  useEffect(() => {
    const fetchNetflixContent = async () => {
      setLoading(true);
      setError(null);
      try {
        const cacheKey = "movies_netflix";

        // FIX: use safe cache reader so corrupt/undefined entries don't throw
        const cached = safeGetCache(cacheKey);
        if (cached) {
          setNetflixMovies(cached);
          setLoading(false);
          return;
        }

        const data = await getNetflixMovies();
        setNetflixMovies(data);
        safeSetCache(cacheKey, data);
      } catch (err) {
        console.error(err);
        setError("Failed to load Netflix collection.");
      } finally {
        setLoading(false);
      }
    };

    fetchNetflixContent();
  }, []);

  useEffect(() => {
    if (loading || netflixMovies.length === 0) return;

    const isMobile = window.innerWidth <= 768;
    const visibleCards = new Set();

    const startAutoplay = () => {
      clearTimeout(timersRef.current.mainTimer);
      timersRef.current.mainTimer = setTimeout(() => {
        const cardsArray = Array.from(visibleCards);
        if (cardsArray.length === 0) {
          setActiveAutoplayId(null);
          return;
        }

        if (isMobile) {
          let bestCard = null;
          let closestDistance = Infinity;
          cardsArray.forEach((card) => {
            const rect = card.getBoundingClientRect();
            const distance = Math.abs(
              rect.top + rect.height / 2 - window.innerHeight / 2,
            );
            if (distance < closestDistance) {
              closestDistance = distance;
              bestCard = card;
            }
          });
          if (bestCard)
            setActiveAutoplayId(bestCard.getAttribute("data-movie-id"));
        } else {
          const randomCard =
            cardsArray[Math.floor(Math.random() * cardsArray.length)];
          setActiveAutoplayId(randomCard.getAttribute("data-movie-id"));
        }
      }, 5000);
    };

    const observerCallback = (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          visibleCards.add(entry.target);
        } else {
          visibleCards.delete(entry.target);
          const movieId = entry.target.getAttribute("data-movie-id");
          setActiveAutoplayId((prev) => (prev === movieId ? null : prev));
        }
      });
      startAutoplay();
    };

    const observer = new IntersectionObserver(observerCallback, {
      root: null,
      threshold: 0.8,
    });
    document
      .querySelectorAll(".animated-card-holder")
      .forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
      clearTimeout(timersRef.current.mainTimer);
    };
  }, [loading, netflixMovies]);

  return (
    <div className="netflix-page-container">
      <div className="netflix-ambient-glow"></div>
      <div className="netflix-particles">
        <span className="particle p1"></span>
        <span className="particle p2"></span>
        <span className="particle p3"></span>
        <span className="particle p4"></span>
        <span className="particle p5"></span>
        <span className="particle p6"></span>
      </div>

      <div className="netflix-hero-header">
        <div className="netflix-logo-wrapper">
          <div className="netflix-logo">NETFLIX</div>
        </div>
        <h2 className="netflix-subtitle">Originals & Popular Releases</h2>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="netflix-results">
        {loading ? (
          <Loading />
        ) : (
          <div className="movie-grid-animated">
            {netflixMovies.map((movie, index) => {
              const isAutoplayActive =
                String(hoveredMovieId) === String(movie.id) ||
                String(activeAutoplayId) === String(movie.id);

              return (
                <div
                  className={`animated-card-holder ${isAutoplayActive ? "autoplay-active" : ""}`}
                  style={{ "--card-delay": `${index * 0.05}s` }}
                  key={movie.id}
                  data-movie-id={movie.id}
                  onMouseEnter={() => {
                    if (window.innerWidth > 768) {
                      setHoveredMovieId(movie.id);
                      setActiveAutoplayId(movie.id);
                    }
                  }}
                  onMouseLeave={() => {
                    if (window.innerWidth > 768) setHoveredMovieId(null);
                  }}
                >
                  {isAutoplayActive && movie.trailerUrl ? (
                    <div className="inline-trailer-wrapper">
                      <iframe
                        src={`${movie.trailerUrl}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0`}
                        title={movie.title || "Trailer"}
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                      <div className="floating-movie-card">
                        <MovieCard movie={movie} className="inner-moviecard" />
                      </div>
                    </div>
                  ) : (
                    <MovieCard movie={movie} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default Netflix;
