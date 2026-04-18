import MovieCard from "../components/MovieCard";
import "../css/Home.css";
import { getPopularMovies, getMoviesByGenre } from "../services/api.js";
import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import Loading from "../components/Loading";
import { useMovieContext } from "../contexts/MovieContext";
import Genre from "./Genre";
import Hero from "../components/Hero";

function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === "/";

  const handleGenreSelect = async (id) => {
    setLoading(true);
    if (id) {
      navigate(`/genre/${id}`);
    } else {
      navigate("/");
    }

    try {
      const data = id ? await getMoviesByGenre(id) : await getPopularMovies();
      setMovies(data);
    } catch (err) {
      setError("Failed to fetch movies.");
    } finally {
      setLoading(false);
    }
  };

  const { movies, setMovies, loading, setLoading, error, setError } =
    useMovieContext();

  useEffect(() => {
    if (loading) return;
    if (movies.length > 0) return;

    const loadPopularMovies = async () => {
      const cached = localStorage.getItem("popular_movies");
      const cachedTime = localStorage.getItem("popular_movies_time");

      if (cached && cachedTime && Date.now() - parseInt(cachedTime) < 720000) {
        setMovies(JSON.parse(cached));
        return;
      }

      try {
        setLoading(true);
        const popularMovies = await getPopularMovies();
        setMovies(popularMovies);

        // Store data and current timestamp
        localStorage.setItem("popular_movies", JSON.stringify(popularMovies));
        localStorage.setItem("popular_movies_time", Date.now().toString());
      } catch (err) {
        setError("Fail to get popular movies...");
      } finally {
        setLoading(false);
      }
    };
    loadPopularMovies();
  }, []);

  return (
    <div className="home">
      <div
        className="genre"
        style={{ position: isHome ? "absolute" : "static" }}
      >
        <Genre onGenreSelect={handleGenreSelect} className="genre" />
      </div>
      {isHome && <Hero movies={movies} />}

      {error && <div className="error-message">{error}</div>}

      {loading && movies.length === 0 ? (
        <Loading />
      ) : (
        <div className="movie-grid">
          {movies.map((movie) => (
            <MovieCard movie={movie} key={movie.id} isSelected={false} />
          ))}
        </div>
      )}
    </div>
  );
}

export default Home;
