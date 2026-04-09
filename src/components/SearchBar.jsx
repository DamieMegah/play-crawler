import { useState, useRef, useEffect } from "react";
import "../css/SearchBar.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSearch } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { searchMovies } from "../services/api";
import { useMovieContext } from "../contexts/MovieContext";

function SearchBar({ onClose }) {
  const [searchQuery, setSearchQuery] = useState("");
  const { setMovies, setLoading, loading, setError } = useMovieContext();
  const navigate = useNavigate();

  const handleSearch = (e) => {
    e.preventDefault();

    const query = searchQuery.trim();
    if (!query) return;

    navigate(`/search?q=${encodeURIComponent(query)}`);

    if (onClose) onClose();
  };

  const inputRef = useRef(null);

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    });

    const handleKeyDown = (e) => {
      if (e.key === "Escape" && onClose) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div>
      <form onSubmit={handleSearch} className="search-form">
        <FontAwesomeIcon icon={faSearch} className="search-icon" />
        <input
          type="text"
          placeholder="Search for movies..."
          className="search-input"
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <button type="submit" className="search-form-btn">
          Search
        </button>
      </form>
    </div>
  );
}

export default SearchBar;
