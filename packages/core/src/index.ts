export { BRAND, BRAND_TITLE, FILTER_DRIVER, SCAN_IGNORE, SIDECAR_ROOT } from "./brand.js";
export { DETECTORS, detectorNamed, type Detector, type DetectorInput } from "./detectors.js";
export { appendIgnore, parseIgnore, type IgnoreEntry } from "./ignore.js";
export {
  analyzeSource,
  convertComments,
  demoteTarget,
  fingerprintOf,
  newComments,
  scanSource,
  type Finding,
  type ProtectedClass,
  type ScanOptions,
  type ScannedComment,
} from "./scan.js";
export {
  ANCHOR_KEY,
  anchorsOf,
  clean,
  confirm,
  isStale,
  promote,
  smudge,
  staleMarkers,
  sync,
  type ConfirmResult,
  type PromoteResult,
  type StaleMarker,
  type SyncOptions,
  type SyncResult,
} from "./filter.js";
export { resolveIds } from "./ids.js";
export { mergeSidecars, type MergeResult } from "./merge.js";
export { LANGUAGES, languageForPath, type LanguageSpec } from "./languages.js";
export { STALE_TAG, findMarkers, type FindOptions, type Marker, type MarkerKind } from "./markers.js";
export {
  bodiesOf,
  normalizeBody,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type Sidecar,
  type SidecarEntry,
} from "./sidecar.js";
