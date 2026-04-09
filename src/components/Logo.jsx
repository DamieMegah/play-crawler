import { Link } from "react-router-dom";
import "../css/Logo.css";
function Logo() {
  return (
    <div>
      <Link to="/" className="nav-brand">
        PL
        <span className="play">▶</span>Y<span>crawler</span>
      </Link>
    </div>
  );
}

export default Logo;
