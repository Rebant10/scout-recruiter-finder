const inExtension =
  typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id) && Boolean(chrome?.storage?.local);

/** "extension" when loaded as the Chrome extension, "web" when served by server.mjs. */
export const runtime = inExtension ? "extension" : "web";

// Extension pages call the APIs directly (host_permissions bypass CORS);
// the local web version goes through server.mjs, which proxies them.
export const endpoints = inExtension
  ? {
      hunter: "https://api.hunter.io/v2",
      apollo: "https://api.apollo.io/api/v1",
      companies: "https://autocomplete.clearbit.com/v1/companies/suggest",
    }
  : {
      hunter: "/api/hunter",
      apollo: "/api/apollo",
      companies: "/api/companies",
    };
