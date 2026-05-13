import { useNavigate } from "react-router-dom";
import "../css/About.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTelegram,
  faGithub,
  faChrome,
} from "@fortawesome/free-brands-svg-icons";
import {
  faRoute,
  faShareNodes,
  faCirclePlay,
  faTriangleExclamation,
  faCodeBranch,
  faDownload,
} from "@fortawesome/free-solid-svg-icons";
import Logo from "../components/Logo";
import { href, Navigate } from "react-router-dom";

function About() {
  const navigate = useNavigate();
  const handleShare = async () => {
    const shareData = {
      title: "PlayCrawler",
      text: "Check out PlayCrawler - The smartest way to route and crawl your favorite movies!",
      url: window.location.origin,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        e;
        await navigator.clipboard.writeText(window.location.origin);
        alert("App link copied to clipboard!");
      }
    } catch (err) {
      console.error("Error sharing:", err);
    }
  };

  return (
    <div className="about-container">
      <section className="about-hero">
        <div className="logo-glow">
          <Logo />
          {/* <FontAwesomeIcon icon={faFire} className="burning-flame-icon" /> */}
        </div>
        <p className="tagline">Smart Routing for the Modern Streamer</p>
        <p className="mission">
          When it comes to quality streaming, we put you ahead quickly, we find
          the <strong>best path</strong> to videos. By analyzing high traffic
          directories, PlayCrawler routes you to the most stable and high
          quality sources, ensuring you spend less time searching and more time
          watching.
        </p>
      </section>

      <section className="action-cards">
        <div className="card install-card">
          <FontAwesomeIcon icon={faDownload} className="card-icon" />
          <h3>Install PlayCrawler</h3>
          <p>
            Get the best experience with full-screen mode and instant access
            directly from your app drawer (powered by Google Chrome{" "}
            <FontAwesomeIcon
              icon={faChrome}
              style={{
                color: "White",
                fontSize: "18px",
              }}
            />
            )
          </p>
          <button
            onClick={() => navigate("/installApp")}
            className="btn-action"
          >
            Install App
          </button>
        </div>

        <div className="card telegram-card">
          <FontAwesomeIcon icon={faTelegram} className="card-icon" />
          <h3>Community Hub</h3>
          <p>
            Join our Telegram for latest movies, real-time link updates, feature
            requests, and community support.
          </p>
          <a
            href="https://t.me/playcrawler"
            target="_blank"
            className="btn-action tg"
          >
            Join Channel
          </a>
        </div>
      </section>

      <section className="details-grid">
        <div className="detail-item">
          <h3>
            <FontAwesomeIcon icon={faRoute} /> Optimized Routing
          </h3>
          <p>
            The web is vast. We navigate the maze of redirect loops and dead
            ends to point you toward the most reliable web nodes. We prioritize
            sites that respect the viewer's time and device health.
          </p>
        </div>

        <div className="detail-item">
          <h3>
            <FontAwesomeIcon icon={faCirclePlay} /> Ecosystem Compatibility
          </h3>
          <p>
            To ensure the smoothest playback of complex web-crawled streams, we
            highly recommend using <strong>VLC Media Player</strong> or
            <strong> MX Player</strong>. These tools are built to handle the
            diverse codecs found in raw web directories.
          </p>
        </div>

        <div className="detail-item">
          <h3>
            <FontAwesomeIcon icon={faCodeBranch} /> Open Source Contribution
          </h3>
          <p>
            PlayCrawler thrives on transparency. Our core routing logic is open
            for peer review and contribution. Help us build a smarter web by
            visiting our <strong>GitHub</strong> repository.
            <button
              className="contribute"
              onClick={() =>
                window.open(
                  "https://github.com/DamieMegah/play-crawler ",
                  "_blank",
                  "noopener noreferrer",
                )
              }
            >
              Contribute <FontAwesomeIcon icon={faGithub} />
            </button>
          </p>
        </div>
      </section>

      <section className="share-section">
        <div className="share-card">
          <div className="share-info">
            <h3>Spread the Word</h3>
            <p>
              PlayCrawler is built for the community. Share the app with fellow
              streamers to help us grow the open-source routing ecosystem.
            </p>
          </div>
          <div className="share-actions">
            <button onClick={handleShare} className="btn-share">
              <FontAwesomeIcon icon={faShareNodes} /> Share App Link
            </button>
            <div className="url-display">{window.location.origin}</div>
          </div>
        </div>
      </section>

      <footer className="legal-section">
        <div className="disclaimer-container">
          <h3>
            <FontAwesomeIcon icon={faTriangleExclamation} /> Legal & Copyright
            Notice
          </h3>

          <div className="disclaimer-grid">
            <div className="legal-box">
              <h4>General Disclaimer</h4>
              <p>
                PlayCrawler is a specialized search engine and routing utility.
                We do not host, store, or upload any video files, media, or data
                on our servers. All information is retrieved in real-time from
                third-party publicly accessible sources.
              </p>
            </div>

            <div className="legal-box">
              <h4>Copyright Policy</h4>
              <p>
                We respect the intellectual property rights of others.
                PlayCrawler does not facilitate the illegal distribution of
                copyrighted material. If you find content that infringes upon
                your rights, please contact the original hosting provider, as we
                have no control over external content nodes.
              </p>
            </div>

            <div className="legal-box">
              <h4>Data & Privacy Policy</h4>

              <p>
                <strong>Zero Data Collection:</strong> We do not collect, track,
                or monitor any user-identifiable information. PlayCrawler does
                not store, sell or your personal information.
              </p>
              <p>
                <strong>No Data Storage:</strong> We do not own or maintain
                servers that store user data. Your "Favourites" and "Settings"
                are stored 100% locally on your own device. When you clear your
                browser data, your PlayCrawler history isn't retriveable.
              </p>
            </div>

            <div className="legal-box full-width">
              <h4>Usage Agreement</h4>
              <p>
                PlayCrawler is built on the foundation of transparency and
                digital privacy. As an <strong>Open Source project</strong>, our
                source code is public and auditable by the community. We believe
                that your browsing habits are your business alone.
              </p>
              <p>
                By using this tool, you acknowledge that PlayCrawler is not
                responsible for the content, privacy policies, or practices of
                any third-party websites we route you to. Users are encouraged
                to comply with their local laws and regulations regarding media
                consumption. We do not guarantee the uptime or safety of
                external links.
              </p>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <p>
            &copy; 2026 PlayCrawler. <em>Engineered</em>:{" "}
            <a
              href="https://damiemegah.github.io/portfolio/#"
              target="_blank"
              rel="noopener noreferrer"
            >
              by DM-Tech
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

export default About;
