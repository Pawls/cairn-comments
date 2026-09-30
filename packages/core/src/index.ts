export { BRAND, BRAND_TITLE, FILTER_DRIVER, SCAN_IGNORE, SIDECAR_ROOT } from "./brand.js";
export { DETECTORS, detectorNamed, type Detector, type DetectorInput } from "./detectors.js";
export { appendIgnore, parseIgnore, type IgnoreEntry } from "./ignore.js";
export {
  analyzeSource,
  convertComments,
  convertDemoted,
  demoteTarget,
  fingerprintOf,
  newComments,
  recordLiterals,
  scanSource,
  type DemoteConversion,
  type Finding,
  type ProtectedClass,
  type ScanOptions,
  type ScannedComment,
} from "./scan.js";
export { resolveIds } from "./ids.js";
export { LITERAL_KEY } from "./literals.js";
export {
  placeComments,
  recordComments,
  stripComments,
  type CommentSite,
  type PlaceResult,
  type RecordOptions,
  type RecordResult,
} from "./placement.js";
export {
  COPIED_FROM_KEY,
  carryComments,
  confirmPlaced,
  promotePlaced,
  type CarriedComment,
  type CarryResult,
  type ConfirmPlacedResult,
  type PromotePlacedResult,
} from "./owner.js";
export { mergeSidecars, type MergeResult } from "./merge.js";
export { LANGUAGES, languageForPath, type LanguageSpec } from "./languages.js";
export { STALE_TAG, findMarkers, type Marker, type MarkerKind } from "./markers.js";
export {
  bodiesOf,
  normalizeBody,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type Sidecar,
  type SidecarEntry,
} from "./sidecar.js";
export { CLI_HOME_ENV, cliHome, homeCommand, installCli, pendingInstall, type CliVersion, type InstallResult } from "./home.js";
