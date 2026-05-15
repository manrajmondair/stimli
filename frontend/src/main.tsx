import React from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { App } from "./App";
import "./styles.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

const root = createRoot(document.getElementById("root") as HTMLElement);

if (clerkPublishableKey) {
  root.render(
    <React.StrictMode>
      <ClerkProvider
        publishableKey={clerkPublishableKey}
        appearance={{
          variables: {
            colorPrimary: "#e96a3d",
            colorText: "#1f1e1a",
            colorBackground: "#f4f1e6",
            fontFamily: "Geist, Inter, system-ui, -apple-system, sans-serif",
            borderRadius: "14px"
          }
        }}
      >
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
} else {
  // Allow the app to render without Clerk so local dev / preview deploys without
  // VITE_CLERK_PUBLISHABLE_KEY still work in read-only mode.
  console.warn(
    "[stimli] VITE_CLERK_PUBLISHABLE_KEY is not set. Auth surfaces will render an unconfigured banner."
  );
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
