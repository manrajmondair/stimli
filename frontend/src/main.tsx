import React from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { App } from "./App";
import "./styles.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

const root = createRoot(document.getElementById("root") as HTMLElement);

const clerkAppearance = {
  variables: {
    colorPrimary: "#e96a3d",
    colorText: "#1f1e1a",
    colorTextSecondary: "#3a3528",
    colorBackground: "#f4f1e6",
    colorInputBackground: "#f7e9b6",
    colorInputText: "#1f1e1a",
    colorNeutral: "#1f1e1a",
    fontFamily: "Geist, Inter, system-ui, -apple-system, sans-serif",
    fontFamilyButtons: "Geist, Inter, system-ui, -apple-system, sans-serif",
    borderRadius: "14px",
    spacingUnit: "1rem",
    fontSize: "15px"
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: { boxShadow: "8px 8px 0 #1f1e1a", border: "2.5px solid #1f1e1a", borderRadius: 28 },
    card: { background: "#f4f1e6", padding: "32px 32px 28px", boxShadow: "none" },
    headerTitle: {
      fontFamily: "Caprasimo, Georgia, serif",
      fontWeight: 400,
      fontSize: "32px",
      letterSpacing: "-0.01em"
    },
    headerSubtitle: { color: "#3a3528", fontSize: "14px" },
    socialButtonsBlockButton: {
      border: "2px solid #1f1e1a",
      borderRadius: "14px",
      boxShadow: "3px 3px 0 #1f1e1a",
      background: "#f4f1e6",
      color: "#1f1e1a",
      fontWeight: 600,
      height: "48px",
      "&:hover": { background: "#f7e9b6", transform: "translate(-1px, -1px)", boxShadow: "4px 4px 0 #1f1e1a" }
    },
    socialButtonsBlockButtonText: { fontSize: "14px", fontWeight: 600 },
    dividerLine: { background: "#3a3528", opacity: 0.25 },
    dividerText: { color: "#3a3528", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase" },
    formFieldLabel: { fontSize: "12px", letterSpacing: "0.04em", color: "#3a3528", fontWeight: 600 },
    formFieldInput: {
      border: "2px solid #1f1e1a",
      borderRadius: "14px",
      background: "#f7e9b6",
      color: "#1f1e1a",
      height: "44px",
      fontSize: "15px",
      padding: "0 14px"
    },
    formButtonPrimary: {
      background: "#e96a3d",
      color: "#f4f1e6",
      border: "2px solid #1f1e1a",
      borderRadius: "999px",
      boxShadow: "3px 3px 0 #1f1e1a",
      fontWeight: 600,
      height: "44px",
      letterSpacing: "0.01em",
      "&:hover": { background: "#d75a30", transform: "translate(-1px, -1px)", boxShadow: "4px 4px 0 #1f1e1a" }
    },
    footer: { background: "transparent", borderTop: "1.5px dashed #1f1e1a", paddingTop: 14 },
    footerActionText: { color: "#3a3528" },
    footerActionLink: { color: "#7a2e15", fontWeight: 600 },
    modalBackdrop: { background: "rgba(31, 30, 26, 0.5)", backdropFilter: "blur(2px)" },
    modalContent: { boxShadow: "none" },
    identityPreview: {
      border: "2px solid #1f1e1a",
      borderRadius: "14px",
      background: "#f7e9b6"
    },
    badge: { background: "#f4c83a", color: "#1f1e1a", border: "1.5px solid #1f1e1a" },
    alert: { borderRadius: "14px", border: "2px solid #1f1e1a" }
  }
};

if (clerkPublishableKey) {
  root.render(
    <React.StrictMode>
      <ClerkProvider
        publishableKey={clerkPublishableKey}
        signInFallbackRedirectUrl="/app"
        signUpFallbackRedirectUrl="/app"
        signInForceRedirectUrl="/app"
        signUpForceRedirectUrl="/app"
        appearance={clerkAppearance}
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
