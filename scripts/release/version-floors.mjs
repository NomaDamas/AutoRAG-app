/**
 * Hard version floors for the tools the installer bundles. Floors for tools the librarian
 * validates itself (`minsync`, `dupey`, `jikji`) are derived directly from the pinned
 * `@autorag/librarian` package (`MINSYNC_MIN_VERSION`, `DUPEY_MIN_VERSION`, `JIKJI_MIN_VERSION`);
 * additional app-only floors (`@nomadamas/mailcrawl`, `lazykatok`) live in `src/shared/tool-pins.json`.
 *
 * Nothing here duplicates a version literal: if the librarian raises a minimum version,
 * `VERSION_FLOORS` moves with it and any stale pin fails the build and test suite.
 */
import { assertVersionFloor, compareVersions, deriveVersionFloors } from "./pins.mjs";

export const VERSION_FLOORS = deriveVersionFloors();
export { assertVersionFloor, compareVersions };
