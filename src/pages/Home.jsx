import MovieCard from "../components/MovieCard";
import "../css/Home.css";
import {
  getPopularMovies,
  getMoviesByGenre,
  getGenres,
} from "../services/api.js";
import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import Loading from "../components/Loading";
import { useMovieContext } from "../contexts/MovieContext";
import Genre from "./Genre";
import Hero from "../components/Hero";

function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === "/";

  const { movies, setMovies, loading, setLoading, error, setError } =
    useMovieContext();

  // --- infinite "See More" state ---
  const [allGenres, setAllGenres] = useState([]);
  const [usedGenreIds, setUsedGenreIds] = useState(new Set());
  const [extraSections, setExtraSections] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const handleGenreSelect = async (id) => {
    setLoading(true);
    // reset infinite sections whenever the user picks a genre manually
    setExtraSections([]);
    setUsedGenreIds(new Set());

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

  useEffect(() => {
    // fetch the genre list once so "See More" has something to pick from
    const loadGenres = async () => {
      try {
        const genres = await getGenres();
        setAllGenres(genres || []);
      } catch (err) {
        console.error("Failed to load genres for See More", err);
      }
    };
    loadGenres();
  }, []);

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

  const handleSeeMore = async () => {
    if (loadingMore || allGenres.length === 0) return;

    let pool = allGenres.filter((g) => !usedGenreIds.has(g.id));
    let resetting = false;

    // once every genre has been shown, start the cycle over so it stays infinite
    if (pool.length === 0) {
      pool = allGenres;
      resetting = true;
    }

    const randomGenre = pool[Math.floor(Math.random() * pool.length)];

    setLoadingMore(true);
    try {
      const genreMovies = await getMoviesByGenre(randomGenre.id);
      setUsedGenreIds((prev) => {
        const next = resetting ? new Set() : new Set(prev);
        next.add(randomGenre.id);
        return next;
      });
      setExtraSections((prev) => [
        ...prev,
        {
          sectionId: `${randomGenre.id}-${Date.now()}`,
          genreName: randomGenre.name,
          movies: genreMovies,
        },
      ]);
    } catch (err) {
      setError("Failed to fetch more movies.");
    } finally {
      setLoadingMore(false);
    }
  };

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
        <>
          <div className="movie-grid">
            <h2
              className="grid-head"
              style={{
                display: isHome ? "none" : "block",
              }}
            >
              Trending Movies
            </h2>
            {movies.map((movie) => (
              <MovieCard movie={movie} key={movie.id} isSelected={false} />
            ))}
          </div>

          {extraSections.map((section) => (
            <div className="movie-grid" key={section.sectionId}>
              <h2 className="grid-head">{section.genreName}</h2>
              {section.movies.map((movie) => (
                <MovieCard movie={movie} key={movie.id} isSelected={false} />
              ))}
            </div>
          ))}

          {movies.length > 0 && (
            <div className="see-more-wrapper">
              <button
                className="see-more-btn"
                onClick={handleSeeMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "See More"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Home;
