import { useState, useEffect } from "react";
import { useLocation, useParams, useNavigate } from "react-router-dom";
import { getGenres, getMoviesByGenre, getPopularMovies } from "../services/api";
import MovieCard from "../components/MovieCard";
import Loading from "../components/Loading";
import { useMovieContext } from "../contexts/MovieContext";
import "../css/Genre.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFire } from "@fortawesome/free-solid-svg-icons";

function Genre({ onGenreSelect }) {
  const [genres, setGenres] = useState([]);
  const [localMovies, setLocalMovies] = useState([]);
  const { genreId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { loading, setLoading, setError } = useMovieContext();

  const isGenrePage = location.pathname.startsWith("/genre");
  const pageStyle = isGenrePage ? "genre-layout-active" : "genre-layout-home";

  const [randomGenres, setRandomGenres] = useState([]);

  const allHeroGenres = [
    { id: 28, name: "Action", image: "/action.jpg" },
    { id: 35, name: "Comedy", image: "/comedy.jpg" },
    { id: 27, name: "Horror", image: "/horror.jpg" },
    { id: 10749, name: "Romance", image: "/romance.jpg" },
    { id: 878, name: "Sci-Fi", image: "/scifi.jpg" },
    { id: 18, name: "Drama", image: "/drama.jpg" },
    { id: 53, name: "Thriller", image: "/thriller.jpg" },
    { id: 16, name: "Animation", image: "/animation.jpg" },
    { id: 12, name: "Adventure", image: "/adventure.jpg" },
    { id: 80, name: "Crime", image: "/crime.jpg" },
    { id: 99, name: "Docu", image: "/docu.jpg" },
    { id: 14, name: "Fantasy", image: "/fantasy.jpg" },
  ];

  useEffect(() => {
    const shuffled = [...allHeroGenres].sort(() => 0.5 - Math.random());
    setRandomGenres(shuffled.slice(0, 4));
  }, []);

  const handleHeroClick = (id) => {
    navigate(`/genre/${id}`);
    if (onGenreSelect) onGenreSelect(id);
  };
  useEffect(() => {
    const loadGenres = async () => {
      const cached = localStorage.getItem("genres");
      if (cached) {
        setGenres(JSON.parse(cached));
        return;
      }
      try {
        const data = await getGenres();
        setGenres(data);
        localStorage.setItem("genres", JSON.stringify(data));
      } catch (err) {
        setError("Failed to load genres");
      }
    };
    loadGenres();
  }, [setError]);

  useEffect(() => {
    const fetchMovies = async () => {
      const cacheKey = genreId ? `movies_${genreId}` : "movies_popular";
      const cachedData = localStorage.getItem(cacheKey);
      const cacheTime = localStorage.getItem(`${cacheKey}_timestamp`);

      const now = new Date().getTime();
      const expiry = 7 * 24 * 60 * 60 * 1000;

      if (cachedData && cacheTime && now - cacheTime < expiry) {
        setLocalMovies(JSON.parse(cachedData));
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const data = genreId
          ? await getMoviesByGenre(genreId)
          : await getPopularMovies();

        setLocalMovies(data);

        localStorage.setItem(cacheKey, JSON.stringify(data));
        localStorage.setItem(`${cacheKey}_timestamp`, now.toString());
      } catch (err) {
        setError("Failed to fetch movies");
      } finally {
        setLoading(false);
      }
    };

    fetchMovies();
  }, [genreId, setLoading, setError]);

  const handleGenreClick = (id) => {
    if (id) {
      navigate(`/genre/${id}`);
    } else {
      navigate("/");
    }
  };

  return (
    <div className={`genre-container ${pageStyle}`}>
      {isGenrePage && !genreId && (
        <div className="genre-hero-grid">
          {randomGenres.map((hero) => (
            <div
              key={hero.id}
              className={`genre-hero-card ${Number(genreId) === hero.id ? "selected" : ""}`}
              onClick={() => handleHeroClick(hero.id)}
              style={{
                backgroundImage: `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.8)), url(${hero.image})`,
              }}
            >
              <h3>{hero.name}</h3>
            </div>
          ))}
        </div>
      )}

      <div className="genre-container active-view">
        <div className="genre-list">
          <button
            className={`genre-btn ${!genreId ? "active" : ""}`}
            onClick={() => handleGenreClick(null)}
          >
            Trending <FontAwesomeIcon icon={faFire} className="fire" />
          </button>
          {genres.map((g) => (
            <button
              key={g.id}
              className={`genre-btn ${genreId === String(g.id) ? "active" : ""}`}
              onClick={() => handleGenreClick(g.id)}
            >
              {g.name}
            </button>
          ))}
        </div>
      </div>

      <div className="genre-results">
        {loading ? (
          <Loading />
        ) : (
          <div className="movie-grid">
            {localMovies.map((movie) => (
              <MovieCard movie={movie} key={movie.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Genre;
