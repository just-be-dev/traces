/**
 * The URL of a Traces API route, such as `api/stats`, resolved against where this
 * app is served.
 *
 * A router can mount the Website under a path, as just-be.dev does at `/traces`,
 * and it rewrites only markup and stylesheets, so a root-relative `/api/stats`
 * would reach the wrong site. The built bundle always sits in `<base>/assets/`,
 * so the app's base is one level above the bundle's own URL. The Vite dev server
 * serves modules from their source paths instead, so dev resolves against the
 * origin root.
 */
export const apiUrl = (
  route: string,
  moduleUrl: string = import.meta.url,
  isDev: boolean = import.meta.env?.DEV === true,
): string => {
  const base = new URL(isDev ? "/" : "..", moduleUrl);
  return new URL(route.replace(/^\/+/, ""), base).href;
};
