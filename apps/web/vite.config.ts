import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["flowpay-mark.svg"],
      manifest: {
        name: "QeSuite FlowPay",
        short_name: "FlowPay",
        description:
          "Programmable business settlement, accounting, reconciliation and audit.",
        theme_color: "#173f35",
        background_color: "#f4f5f1",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/flowpay-mark.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
