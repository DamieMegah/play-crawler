import "../css/InstallPWA.css";
import inst01 from "../assets/inst01.jpg";
import inst02 from "../assets/inst02.jpg";
import inst03 from "../assets/inst03.jpg";
import inst04 from "../assets/inst04.jpg";
import inst05 from "../assets/inst05.jpg";
import inst06 from "../assets/inst06.jpg";
import inst07 from "../assets/inst07.jpg";

function InstallPWA() {
  const steps = [
    {
      id: 1,
      title: "Open PlayCrawler in Chrome",
      description: "Launch Google Chrome and visit the PlayCrawler.netlify.app",
      image: inst07,
    },
    {
      id: 2,
      title: "Tap the 3 Dots Menu",
      description:
        "Click the Chrome menu icon at the top-right corner of the browser.",
      image: inst06,
    },
    {
      id: 3,
      title: "Select 'Add App To Homescreen'",
      description:
        "Find and click the 'Add App to Homescreen' or 'Install PlayCrawler' option.",
      image: inst05,
    },
    {
      id: 4,
      title: "Confirm Installation",
      description: "A popup will appear. Click the Install button to continue.",
      image: inst04,
    },
    {
      id: 5,
      title: "Verify PlayCrawler Is Install",
      description:
        "A Verification notification will pop up saying 'Playcrawler, App Installed'",
      image: inst03,
    },

    {
      id: 6,
      title: "Launch PlayCrawler",
      description:
        "PlayCrawler is now installed and can be opened directly from your home screen or app gellery.",
      image: inst02,
    },

    {
      id: 7,
      title: "Enjoy The Premuim App",
      description:
        "PlayCrawler gives you the Premuim native feel and perfom more effectively on both Android & IOS ",
      image: inst01,
    },
  ];

  return (
    <div className="install-container">
      <div className="install-header">
        <h1>Install PlayCrawler App</h1>
        <small>Supported by Windows, Android and IOS Devices</small>
        <p>
          Follow these simple steps to install PlayCrawler as an app on your
          device using Google Chrome.
        </p>
      </div>

      <div className="steps-wrapper">
        {steps.map((step) => (
          <div className="step-card" key={step.id}>
            <div className="step-number">{step.id}</div>

            <div className="step-image">
              <img src={step.image} alt={step.title} />
            </div>

            <div className="step-content">
              <h2>{step.title}</h2>
              <p>{step.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default InstallPWA;
