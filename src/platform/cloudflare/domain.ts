import type * as Cloudflare from "alchemy/Cloudflare";

/**
 * Public hostname, e.g. `traces.just-be.dev`, read at plan time like the Access
 * policy. Unset (as in `alchemy dev`), both Workers keep only their workers.dev URLs.
 *
 * One host serves everything. The Website owns it as a custom domain, and API
 * Worker routes on the same host take precedence for the paths that need Access:
 * Worker-level Access covers the API Worker's routes, so those paths sign in
 * directly, while `/install*`, `/api/ingest`, and `/api/uploaders/claim` reach the
 * API through the Website's service binding without an Access identity.
 */
export const publicDomain = process.env.TRACES_DOMAIN || undefined;

/** The zone holding {@link publicDomain}: `TRACES_ZONE`, else its last two labels. */
const zoneName = publicDomain
  ? process.env.TRACES_ZONE || publicDomain.split(".").slice(-2).join(".")
  : undefined;

/**
 * Paths served by the API Worker directly, behind Access, including OAuth discovery.
 * Any route that reads the owner's data must be listed, or on the public domain it
 * arrives through the Website without an Access identity and answers 401.
 */
export const accessPaths = ["/mcp*", "/api/events*", "/api/search*", "/.well-known/*"];

export const apiRoutes: Array<Cloudflare.WorkerRouteConfig> | undefined =
  publicDomain && zoneName
    ? accessPaths.map((path) => ({ pattern: `${publicDomain}${path}`, zoneName }))
    : undefined;

/**
 * The Website keeps a custom domain for DNS and TLS, plus a whole-host route. Routes
 * take precedence over custom domains, so without it a wildcard route on the zone
 * (`*.just-be.dev/*` exists) would shadow the Website. The more specific API routes
 * above still win for their paths.
 */
export const websiteDomain =
  publicDomain && zoneName ? { name: publicDomain, zoneName } : undefined;

export const websiteRoutes: Array<Cloudflare.WorkerRouteConfig> | undefined =
  publicDomain && zoneName ? [{ pattern: `${publicDomain}/*`, zoneName }] : undefined;
