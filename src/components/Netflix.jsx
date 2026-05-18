import { useState, useEffect, useRef } from "react";
import { getNetflixMovies } from "../services/api";
import MovieCard from "../components/MovieCard";
import Loading from "../components/Loading";
import "../css/Netflix.css";

function Netflix() {
  const [netflixMovies, setNetflixMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeAutoplayId, setActiveAutoplayId] = useState(null);
  const timersRef = useRef({});

  useEffect(() => {
    const fetchNetflixContent = async () => {
      setLoading(true);
      try {
        const cacheKey = "movies_netflix";
        const cachedData = localStorage.getItem(cacheKey);

        if (cachedData) {
          const parsedData = JSON.parse(cachedData);
          if (parsedData && parsedData.length > 0) {
            setNetflixMovies(parsedData);
            setLoading(false);
            return;
          }
        }

        const data = await getNetflixMovies();
        setNetflixMovies(data);
        localStorage.setItem(cacheKey, JSON.stringify(data));
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

    const observerOptions = {
      root: null, // viewport
      threshold: 0.8, // 80% visibility required
    };

    const observerCallback = (entries) => {
      entries.forEach((entry) => {
        const movieId = entry.target.getAttribute("data-movie-id");

        if (entry.isIntersecting) {
          // If 80% visible, start a 5-second countdown timer
          timersRef.current[movieId] = setTimeout(() => {
            setActiveAutoplayId(movieId);
          }, 5000); // 5 seconds
        } else {
          // If it drops below 80% visibility, clear its timer
          if (timersRef.current[movieId]) {
            clearTimeout(timersRef.current[movieId]);
            delete timersRef.current[movieId];
          }
          // If this card was currently playing, stop it when scrolled away
          setActiveAutoplayId((prevId) => (prevId === movieId ? null : prevId));
        }
      });
    };

    const observer = new IntersectionObserver(
      observerCallback,
      observerOptions,
    );

    // Grab all modern card holders to observe
    const cardElements = document.querySelectorAll(".animated-card-holder");
    cardElements.forEach((el) => observer.observe(el));

    // Cleanup logic on unmount or data refresh
    return () => {
      cardElements.forEach((el) => observer.unobserve(el));
      // Clear any pending timers to avoid memory leaks
      Object.values(timersRef.current).forEach(clearTimeout);
    };
  }, [loading, netflixMovies]);

  return (
    <div className="netflix-page-container">
      {/* Background Ambient Glow & Particles */}
      <div className="netflix-ambient-glow"></div>
      <div className="netflix-particles">
        <span className="particle p1"></span>
        <span className="particle p2"></span>
        <span className="particle p3"></span>
        <span className="particle p4"></span>
        <span className="particle p5"></span>
        <span className="particle p6"></span>
      </div>

      {/* Cinematic Header Section */}
      <div className="netflix-hero-header">
        <div className="netflix-logo-wrapper">
          <div className="netflix-logo">NETFLIX</div>
        </div>
        <h2 className="netflix-subtitle">Originals & Popular Releases</h2>
      </div>

      {error && <div className="error-message">{error}</div>}

      {/* Grid Results */}
      <div className="netflix-results">
        {loading ? (
          <Loading />
        ) : (
          <div className="movie-grid-animated">
            {netflixMovies &&
              netflixMovies.map((movie, index) => {
                const isAutoplayActive =
                  String(activeAutoplayId) === String(movie.id);
                // Standard default placeholder or fallback trailer URL
                const trailerUrl = movie.trailerUrl;

                return (
                  <div
                    className={`animated-card-holder ${isAutoplayActive ? "autoplay-active" : ""}`}
                    style={{ "--card-delay": `${index * 0.05}s` }}
                    key={movie.id}
                    data-movie-id={movie.id}
                  >
                    {/* Render MovieCard if not playing, or render the Video elements instead */}
                    {isAutoplayActive && trailerUrl ? (
                      <div className="inline-trailer-wrapper">
                        <iframe
                          src={`${trailerUrl}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0`}
                          title={movie.title || "Trailer"}
                          frameBorder="0"
                          allow="autoplay; encrypted-media"
                        />
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
