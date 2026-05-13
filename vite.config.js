import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
       includeAssets: ["favicon.ico", "robots.txt"],
      manifest: {
        name: "The Play Crawler",
        short_name: "Play Crawler",
        description: "Movie link crawling App",
        theme_color: "#1e79a7",
        background_color: "#01030c",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/logo-fin.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/logo-fin.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          }
        ]
      }
    })
  ]
});
