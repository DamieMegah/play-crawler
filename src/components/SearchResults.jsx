import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { searchMovies } from "../services/api";
import { useMovieContext } from "../contexts/MovieContext";
import MovieCard from "./MovieCard";
import Loading from "./Loading";

function SearchResults() {
  const [params] = useSearchParams();
  const query = params.get("q");

  const { movies, setMovies, loading, setLoading, error, setError } =
    useMovieContext();

  useEffect(() => {
    if (!query) return;

    const cacheKey = `search_${query.toLowerCase()}`;
    const timestampKey = `${cacheKey}_time`;
    const now = Date.now();
    const expiry = 7 * 24 * 60 * 60 * 1000;

    const fetchSearch = async () => {
      const cachedData = localStorage.getItem(cacheKey);
      const cachedTime = localStorage.getItem(timestampKey);

      // CACHE
      if (cachedData && cachedTime && now - parseInt(cachedTime) < expiry) {
        setMovies(JSON.parse(cachedData));
        setError(null);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const res = await searchMovies(query);
        const results = res.results || res;

        if (!results || results.length === 0) {
          setMovies([]);
          setError("No movies found.");
        } else {
          setMovies(results);
          localStorage.setItem(cacheKey, JSON.stringify(results));
          localStorage.setItem(timestampKey, now.toString());
        }
      } catch (err) {
        console.log(err);
        setError("Search failed.");
      } finally {
        setLoading(false);
      }
    };

    fetchSearch();
  }, [query]);

  if (loading) return <Loading />;

  return (
    <div>
      {error && <p>{error}</p>}

      <div className="movie-grid">
        {movies.map((movie) => (
          <MovieCard key={movie.id} movie={movie} />
        ))}
      </div>
    </div>
  );
}

export default SearchResults;
