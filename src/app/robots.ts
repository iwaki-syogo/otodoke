import type { MetadataRoute } from "next";

/** /robots.txt: the public pages may be crawled; the signed-in app and the auth endpoints may not. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/app", "/auth"] } };
}
