import { NotFoundScreen, TO_LIST } from "@/components/not-found-screen";

/**
 * notFound() under /app (another person's parcel, a malformed id): shown inside the app, with its
 * tabs. The app's layout has checked the sign-in already, so the way back is the parcel list.
 */
export default function NotFound() {
  return <NotFoundScreen back={TO_LIST} />;
}
