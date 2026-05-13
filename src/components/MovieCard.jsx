import "../css/MovieCard.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faStar, faHeart } from "@fortawesome/free-solid-svg-icons";
import { useMovieContext } from "../contexts/MovieContext";
import { NavLink } from "react-router-dom";
function MovieCard({ movie }) {
  //star rating logic
  const ratingOutOfFive = Math.round(movie.vote_average / 2);
  const stars = [1, 2, 3, 4, 5];

  const { isFavourite, addToFavourites, removeFromFavourites } =
    useMovieContext();

  const favourite = isFavourite(movie.id);
  function handleHeart(e) {
    e.preventDefault();
    if (favourite) removeFromFavourites(movie.id);
    else addToFavourites(movie);
  }

  const handleCardClick = () => {
    localStorage.setItem("selected_movie", JSON.stringify(movie));
  };
  return (
    <NavLink to={`/movie/${movie.id}`} state={{ movie }} className="movie-card">
      <div className="movie-poster" onClick={handleCardClick}>
        <img
          src={`https://image.tmdb.org/t/p/w500${movie.poster_path}`}
          alt={movie.title}
        />
        <div className="movie-overlay">
          <button
            onClick={handleHeart}
            className={`heartBtn ${favourite ? "active" : ""}`}
          >
            <FontAwesomeIcon icon={faHeart} className="fav-icon" />
          </button>
        </div>
      </div>
      <div className="movie-info">
        <div className="title-box">
          <h3>{movie.title}</h3>
          <p>({movie.release_date})</p>
        </div>
        <div className="rating">
          {stars.map((s) => (
            <FontAwesomeIcon
              key={s}
              icon={faStar}
              className={s <= ratingOutOfFive ? "star active" : "star inactive"}
            />
          ))}
          <span className="rating-num">{movie.vote_average.toFixed(1)}</span>
        </div>
      </div>
    </NavLink>
  );
}

export default MovieCard;
