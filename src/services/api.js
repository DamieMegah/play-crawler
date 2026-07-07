const API_KEY = "7da7fc581346b48c2d8130eb7da7ead8";
const BASE_URL = "https://api.themoviedb.org/3";

export const getPopularMovies = async () => {
  const response = await fetch(`${BASE_URL}/movie/popular?api_key=${API_KEY}`);
  const data = await response.json();
  return data.results;
};

export const searchMovies = async (query) => {
  const response = await fetch(
    `${BASE_URL}/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(query)}`
  );
  const data = await response.json();
  return data.results;
};

export const getGenres = async () => {
  const response = await fetch(`${BASE_URL}/genre/movie/list?api_key=${API_KEY}`);
  const data = await response.json();
  return data.genres;
};

export const getMoviesByGenre = async (genreId) => {
  const response = await fetch(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&with_genres=${genreId}&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results;
};

export const getMoviesKdrama = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/tv?api_key=${API_KEY}&with_original_language=ko&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results.map((tvShow) => ({
    ...tvShow,
    title: tvShow.name,
    release_date: tvShow.first_air_date,
  }));
};

export const getMoviesBollywood = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&with_original_language=hi&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results;
};

export const getMoviesNollywood = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&with_origin_country=NG&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results;
};

// FIX 1: Accept a `mediaType` param ("movie" | "tv") so TV shows hit the
// correct /tv/{id}/videos endpoint instead of /movie/{id}/videos.
// Previously every item — including TV shows — used /movie/, causing 404s
// for all TV IDs, which then threw and killed the entire Promise.all.
export const getMovieTrailer = async (id, mediaType = "movie") => {
  try {
    const response = await fetch(
      `${BASE_URL}/${mediaType}/${id}/videos?api_key=${API_KEY}`
    );

    // A 404 means no video data for this title — return null gracefully
    // instead of throwing, so callers don't have to catch individually.
    if (!response.ok) return null;

    const data = await response.json();

    const trailer = data.results?.find(
      (v) => v.type === "Trailer" && v.site === "YouTube"
    );
    const key = trailer?.key ?? data.results?.[0]?.key;

    return key ? `https://www.youtube.com/embed/${key}` : null;
  } catch {
    // Network failure — degrade gracefully
    return null;
  }
};


export const getNetflixMovies = async (page = 1) => {
  const [moviesRes, tvRes] = await Promise.all([
    fetch(
      `${BASE_URL}/discover/movie?api_key=${API_KEY}&with_watch_providers=8&watch_region=US&with_watch_monetization_types=flatrate&page=${page}`
    ),
    fetch(
      `${BASE_URL}/discover/tv?api_key=${API_KEY}&with_watch_providers=8&watch_region=US&with_watch_monetization_types=flatrate&page=${page}`
    ),
  ]);

  const movies = await moviesRes.json();
  const tv = await tvRes.json();

  const merged = [
    // Tag movies so the trailer fetcher uses /movie/
    ...movies.results.map((m) => ({ ...m, mediaType: "movie" })),
    // Tag TV shows so the trailer fetcher uses /tv/
    ...tv.results.map((show) => ({
      ...show,
      title: show.name,
      release_date: show.first_air_date,
      mediaType: "tv",
    })),
  ];

  // allSettled: every item resolves regardless of whether its trailer fetch
  // succeeds or fails — no single 404 can abort the whole list anymore.
  const results = await Promise.allSettled(
    merged.map(async (item) => ({
      ...item,
      trailerUrl: await getMovieTrailer(item.id, item.mediaType),
    }))
  );

  const items = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  return {
    results: items,
    // both endpoints paginate independently, so "more available" means
    // either one still has pages left
    hasMore:
      page < (movies.total_pages || 1) || page < (tv.total_pages || 1),
  };
};

export const getAnimeCollection = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/tv?api_key=${API_KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results.map((anime) => ({
    ...anime,
    title: anime.name,
    release_date: anime.first_air_date,
  }));
};

export const getClassicMovies = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&release_date.lte=2000-01-01&vote_count.gte=5000&sort_by=vote_average.desc`
  );
  const data = await response.json();
  return data.results;
};

export const getDisneyMovies = async () => {
  const response = await fetch(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&with_watch_providers=337&watch_region=US&with_watch_monetization_types=flatrate&sort_by=popularity.desc`
  );
  const data = await response.json();
  return data.results;
};