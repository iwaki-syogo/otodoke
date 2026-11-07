import type { MetadataRoute } from "next";

/**
 * /robots.txt: the public pages may be crawled; the signed-in app and the auth endpoints may not.
 * Plain "/app" would also block "/apple-icon.png" (robots rules are prefix matches), so the app
 * is listed as "/app/" plus the exact "/app$". Nothing lives at exactly "/auth", so "/auth/" is enough.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/app/", "/app$", "/auth/"] } };
}
