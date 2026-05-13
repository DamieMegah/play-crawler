import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChrome } from "@fortawesome/free-brands-svg-icons";
import "../css/InstallPopup.css";

function InstallPopup() {
  const navigate = useNavigate();
  const location = useLocation();

  const [visible, setVisible] = useState(false);
  const [render, setRender] = useState(false);
  const [translateX, setTranslateX] = useState(0);

  const startX = useRef(0);
  const currentX = useRef(0);

  useEffect(() => {
    if (location.pathname !== "/") return;

    const isInstalled =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;

    if (isInstalled) return;

    const timer = setTimeout(() => {
      setRender(true);

      setTimeout(() => {
        setVisible(true);

        setTimeout(() => {
          closePopup();
        }, 10000);
      }, 50);
    }, 10000);

    return () => clearTimeout(timer);
  }, [location.pathname]);

  const closePopup = () => {
    setVisible(false);

    setTimeout(() => {
      setRender(false);
    }, 350);
  };

  const handleTouchStart = (e) => {
    startX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e) => {
    currentX.current = e.touches[0].clientX;

    const diff = currentX.current - startX.current;

    // swipe left only
    if (diff < 0) {
      setTranslateX(diff);
    }
  };

  const handleTouchEnd = () => {
    if (translateX < -100) {
      closePopup();
    } else {
      setTranslateX(0);
    }
  };

  if (!render) return null;

  return (
    <div
      className={`install-popup ${visible ? "show" : ""}`}
      style={{
        transform: `translateX(${translateX}px)`,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="install-content">
        <div className="install-text">
          <FontAwesomeIcon icon={faChrome} />
          <p>Install PlayCrawler for best experience</p>
        </div>

        <div className="install-actions">
          <button
            className="install-btn"
            onClick={() => navigate("/installApp")}
          >
            Install
          </button>

          <button className="close-btn" onClick={closePopup}>
            X
          </button>
        </div>
      </div>
    </div>
  );
}

export default InstallPopup;
