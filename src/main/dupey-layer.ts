import { DUPEY_LAYER_ID } from "../shared/live-contract";
import type { FsDirChange } from "../shared/live-contract";
import type { FsVersionFamiliesResult } from "../shared/fs-contract";
import type { DerivedLayer } from "./change-hub";
import type { VersionFamilyService } from "./version-family-service";

/** Adapts the verified dupey service to the ordered ChangeHub layer contract. */
export function createDupeyLayer(service: VersionFamilyService): DerivedLayer<FsVersionFamiliesResult> {
	return {
		id: DUPEY_LAYER_ID,
		snapshot: () => service.result(),
		applyChanges: (dirs: readonly FsDirChange[]) => service.applyDirChanges(dirs),
		resync: () => service.reverify(),
	};
}
