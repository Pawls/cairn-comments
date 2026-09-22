export { BRAND, BRAND_TITLE, FILTER_DRIVER, SCAN_IGNORE, SIDECAR_ROOT } from "./brand.js";
export { DETECTORS, detectorNamed, type Detector, type DetectorInput } from "./detectors.js";
export { appendIgnore, parseIgnore, type IgnoreEntry } from "./ignore.js";
export {
  analyzeSource,
  convertComments,
  fingerprintOf,
  newComments,
  scanSource,
  type Finding,
  type ProtectedClass,
  type ScanOptions,
  type ScannedComment,
} from "./scan.js";
export { clean, smudge, sync, type SyncOptions, type SyncResult } from "./filter.js";
export { resolveIds } from "./ids.js";
export { LANGUAGES, languageForPath, type LanguageSpec } from "./languages.js";
export { findMarkers, type Marker, type MarkerKind } from "./markers.js";
export {
  bodiesOf,
  normalizeBody,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type Sidecar,
  type SidecarEntry,
} from "./sidecar.js";
