import { useState, useEffect } from "react";
import "../css/Hero.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlay } from "@fortawesome/free-solid-svg-icons";

function Hero({ movies }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const topFive = movies.slice(0, 5);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev === 4 ? 0 : prev + 1));
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  if (!topFive.length) return null;

  return (
    <div className="hero-container">
      {/* Slides */}
      <div
        className="hero-wrapper"
        style={{ transform: `translateX(-${currentIndex * 20}%)` }}
      >
        {topFive.map((movie) => (
          <div
            key={movie.id}
            className="hero-slide"
            style={{
              backgroundImage: `url(https://image.tmdb.org/t/p/original${movie.backdrop_path})`,
            }}
          >
            <div className="hero-overlay">
              <h1>{movie.title}</h1>
              <p>{movie.overview.substring(0, 150)}...</p>
              <button className="play-btn">
                <FontAwesomeIcon icon={faPlay} className="icon" />
                &nbsp;Crawl Movie
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="hero-dots">
        {topFive.map((_, index) => (
          <button
            key={index}
            className={`dot ${index === currentIndex ? "active" : ""}`}
            onClick={() => setCurrentIndex(index)}
          />
        ))}
      </div>
    </div>
  );
}
export default Hero;
