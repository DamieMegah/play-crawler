import { useState } from "react";
import { useMovieContext } from "../contexts/MovieContext";
import { useParams, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Loading from "./Loading";
import {
  faStar,
  faDownload,
  faHeart,
  faFilm,
  faClock,
  faCloudDownloadAlt,
  faFrownOpen,
} from "@fortawesome/free-solid-svg-icons";
import { faYoutube, faTelegram } from "@fortawesome/free-brands-svg-icons";
import "../css/MovieInfo.css";

function MovieInfo() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    movies,
    loading,
    favourites,
    isFavourite,
    addToFavourites,
    removeFromFavourites,
  } = useMovieContext();
  const [showCrawler, setShowCrawler] = useState(false);

  const movie =
    movies.find((m) => m.id === Number(id)) ||
    favourites.find((m) => m.id === Number(id));

  if (loading) return <Loading />;
  if (!movie)
    return (
      <div className="error-message">
        <FontAwesomeIcon icon={faFrownOpen} className="icon" />
        <p>Ooops!</p> <br />
        <p>This movie can not be crawl at the moment</p>
        <button
          onClick={() => {
            navigate(-1);
          }}
        >
          Go back
        </button>
      </div>
    );

  const favourite = isFavourite(movie.id);
  function handleHeart(e) {
    e.preventDefault();
    if (favourite) removeFromFavourites(movie.id);
    else addToFavourites(movie);
  }

  //Youtube crawl Logic
  function handleYoutube(movie) {
    if (!movie) return;
    const cleanTitle = movie.title.replace(/[^\w\s]/gi, "");
    const year = movie.release_date ? movie.release_date.split("-")[0] : "";
    const query = encodeURIComponent(`${cleanTitle} ${year} full movie`);
    const url = `https://www.youtube.com/results?search_query=${query}`;
    window.open(url, "_blank");
  }

  //nkiri logic
  function handleNkiri(movie) {
    if (!movie) return;
    const slug = movie.title
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    const year = movie.release_date ? movie.release_date.split("-")[0] : "";
    const url = `https://thenkiri.com/${slug}-${year}-download-hollywood-movie/`;

    window.open(url, "_blank", "noopener,noreferrer");
  }

  //netnaija Logic
  function handleNetNaija(movie) {
    if (!movie) return;

    const formattedTitle = movie.title
      .replace(/[^\w\s-]/g, "")
      .split(" ")
      .join("-");
    const year = movie.release_date ? movie.release_date.split("-")[0] : "2026";
    const url = `https://thenetnaija.ng/${formattedTitle}-${year}-movie-download/`;

    window.open(url, "_blank", "noopener,noreferrer");
  }

  const backdropBase = "https://image.tmdb.org/t/p/original";
  const posterBase = "https://image.tmdb.org/t/p/w500";

  return (
    <div className="movie-detail-container">
      <div
        className="hero-blur-bg"
        style={{
          backgroundImage: `url(${backdropBase}${movie.backdrop_path})`,
        }}
      />

      <div className="detail-content">
        <div className="hero-section">
          <div className="poster-main">
            <img src={`${posterBase}${movie.poster_path}`} alt={movie.title} />
          </div>

          <div className="info-main">
            <h1 className="movie-title">{movie.title}</h1>

            <div className="meta-row">
              <span className="rating-badge">
                <FontAwesomeIcon icon={faStar} />{" "}
                {movie.vote_average.toFixed(1)}
              </span>
              <span>
                <FontAwesomeIcon icon={faClock} /> {movie.release_date}
              </span>
              <span>
                <FontAwesomeIcon icon={faFilm} /> HD / 4K
              </span>
            </div>

            <p className="overview-text">{movie.overview}</p>

            <div className="action-buttons">
              <button
                className={`btn-primary ${favourite ? "active" : ""}`}
                onClick={handleHeart}
              >
                <FontAwesomeIcon
                  icon={faHeart}
                  style={{ color: favourite ? "red" : "white" }}
                />{" "}
                {favourite ? "Remove Favourite" : "Add Favourites"}
              </button>
              <button
                className="btn-crawl"
                onClick={() => setShowCrawler(!showCrawler)}
              >
                <FontAwesomeIcon icon={faDownload} /> Crawl / Download
              </button>
            </div>
          </div>
        </div>

        {showCrawler && (
          <div className="crawl-drawer">
            <h3>Select Source to Crawl</h3>
            <button
              onClick={() => setShowCrawler(!showCrawler)}
              className="close-crawler"
            >
              X
            </button>
            <div className="source-grid">
              <div
                className="source-item yt"
                onClick={() => handleYoutube(movie)}
              >
                <FontAwesomeIcon icon={faYoutube} className="youtube" />
                <span>YouTube</span>
              </div>
              <div className="source-item tg">
                <FontAwesomeIcon icon={faTelegram} className="telegram" />
                <span>Telegram</span>
              </div>
              <div
                className="source-item web" /* onClick={() => handleWeb(movie)}*/
              >
                <FontAwesomeIcon
                  icon={faCloudDownloadAlt}
                  className="web-icon"
                />
                <span>Web&nbsp;Crawl </span>
                <div className="web-children">
                  <p>Select prefered dawnload site</p>
                  <div className="btns">
                    <button onClick={() => handleNkiri(movie)}>
                      The Nkiri <sub>&nbsp;(Highly recommended)</sub>
                    </button>
                    <button onClick={() => handleNetNaija(movie)}>
                      NetNaija <sub>&nbsp;(Fairly recommended)</sub>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MovieInfo;
