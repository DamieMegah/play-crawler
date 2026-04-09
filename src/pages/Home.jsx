import MovieCard from "../components/MovieCard";
import "../css/Home.css";
import { getPopularMovies, getMoviesByGenre } from "../services/api.js";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Loading from "../components/Loading";
import { useMovieContext } from "../contexts/MovieContext";
import Genre from "./Genre";

function Home() {
  const navigate = useNavigate();

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

  //  Pull everything from the GLOBAL context
  const { movies, setMovies, loading, setLoading, error, setError } =
    useMovieContext();
  useEffect(() => {
    if (loading) return;
    if (movies.length > 0) return;

    const loadPopularMovies = async () => {
      const cached = localStorage.getItem("popular_movies");

      if (cached) {
        setMovies(JSON.parse(cached));
        return;
      }

      try {
        setLoading(true);
        const popularMovies = await getPopularMovies();
        setMovies(popularMovies);
        localStorage.setItem("popular_movies", JSON.stringify(popularMovies));
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
      <Genre onGenreSelect={handleGenreSelect} className="genre" />
      {error && <div className="error-message">{error}</div>}

      {loading ? (
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
