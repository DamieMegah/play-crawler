import { Link } from "react-router-dom";
import "../css/Logo.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
function Logo() {
  return (
    <div>
      <Link to="/" className="nav-brand">
        PL
        <span className="play-box">
          {" "}
          <FontAwesomeIcon icon={faPlay} className="play" />
        </span>
        Y<span>crawler</span>
      </Link>
    </div>
  );
}

export default Logo;
