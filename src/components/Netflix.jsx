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

    const isMobile = window.innerWidth <= 768;

    const observerOptions = {
      root: null,
      threshold: 0.8,
    };

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
          // MOBILE:
          // choose centered visible card

          let bestCard = null;
          let closestDistance = Infinity;

          cardsArray.forEach((card) => {
            const rect = card.getBoundingClientRect();

            const cardCenter = rect.top + rect.height / 2;

            const viewportCenter = window.innerHeight / 2;

            const distance = Math.abs(cardCenter - viewportCenter);

            if (distance < closestDistance) {
              closestDistance = distance;
              bestCard = card;
            }
          });

          if (bestCard) {
            setActiveAutoplayId(bestCard.getAttribute("data-movie-id"));
          }
        } else {
          // DESKTOP:
          // RANDOM visible card

          const randomCard =
            cardsArray[Math.floor(Math.random() * cardsArray.length)];

          setActiveAutoplayId(randomCard.getAttribute("data-movie-id"));
        }
      }, 5000);
    };

    const observerCallback = (entries) => {
      entries.forEach((entry) => {
        const el = entry.target;

        if (entry.isIntersecting) {
          visibleCards.add(el);
        } else {
          visibleCards.delete(el);

          const movieId = el.getAttribute("data-movie-id");

          setActiveAutoplayId((prev) => (prev === movieId ? null : prev));
        }
      });

      startAutoplay();
    };

    const observer = new IntersectionObserver(
      observerCallback,
      observerOptions,
    );

    const cardElements = document.querySelectorAll(".animated-card-holder");

    cardElements.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();

      clearTimeout(timersRef.current.mainTimer);
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
                          src={`${trailerUrl}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0`}
                          title={movie.title || "Trailer"}
                          frameBorder="0"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                        <div className="floating-movie-card">
                          <MovieCard
                            movie={movie}
                            className="inner-moviecard"
                          />
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
