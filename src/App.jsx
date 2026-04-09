import Home from "./pages/Home";
import { Route, Routes } from "react-router-dom";
import { useRef, useState } from "react";
import "./css/App.css";
import Favourite from "./pages/Favourites";
import Genre from "./pages/Genre";
import NavBar from "./components/NavBar";
import SlideUp from "./components/SlideUp";
import MovieInfo from "./components/MovieInfo";
import SearchResults from "./components/SearchResults";

function App() {
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef(null);

  const handleScroll = () => {
    if (scrollRef.current) {
      const scrollTop = scrollRef.current.scrollTop;
      setIsScrolled(scrollTop > 20);
    }
  };

  const handleBackToTop = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className="app-container">
      <NavBar isScrolled={isScrolled} />
      {isScrolled && (
        <SlideUp isScrolled={isScrolled} onClick={handleBackToTop} />
      )}
      <main ref={scrollRef} onScroll={handleScroll} className="main-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/favourite" element={<Favourite />} />
          <Route path="/genre" element={<Genre />} />
          <Route path="/genre/:genreId" element={<Home />} />
          <Route path="/movie/:id" element={<MovieInfo />} />
          <Route path="/search" element={<SearchResults />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
