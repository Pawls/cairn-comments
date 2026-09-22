// Heuristic tells of AI-written comments (plan A5). Each detector's `score` is its measured
// precision on the labeled corpus, and `enabled` follows the kill criterion (>= 80%);
// packages/core/test/scan.corpus.test.ts pins both, so neither can drift from the evidence.

export interface DetectorInput {
  /** Comment text, lines joined with a space. */
  text: string;
  firstLine: string;
  lineCount: number;
  placement: "own-line" | "trailing";
  /** The code line an own-line comment precedes, or the code before a trailing comment. */
  context: string;
}

export interface Detector {
  name: string;
  description: string;
  score: number;
  enabled: boolean;
  test(input: DetectorInput): boolean;
}

const anyOf = (patterns: RegExp[], s: string) => patterns.some((p) => p.test(s));

// ©, ®, and ™ are Extended_Pictographic but turn up in license and brand text.
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/u;

const CHANGE_HISTORY_OPENERS = [
  /^(?:NEW|UPDATED?|CHANGED?|FIXED|ADDED|REMOVED|MODIFIED)\s*[:!]/,
  // "Changed in 3.8" and "Added in version 2" are release notes, not agent narration.
  /^(?:updated|changed|modified|refactored|switched|converted|migrated|reworked)\s+(?:to|from|so|this|the|it)\b/i,
  // Past tense only: an imperative "Fix the cell" is an instruction, not a changelog.
  /^fixed(?::|\s+(?:the|a|an|this|that|it|bug|issue|problem|error|crash)\b)/i,
  /^(?:added|removed|deleted|introduced|replaced)\s+(?:a|an|the|this|that|new|support|check|checks|logic|handling|validation|error|fallback|redundant|unnecessary|unused|extra|missing|proper|explicit|caching|retry|retries)\b/i,
];
const CHANGE_HISTORY_ANYWHERE =
  /\b(?:instead of the (?:old|previous|original)|no longer (?:throws?|crash(?:es)?|fails?)|now (?:correctly|properly) (?:handles?|returns?|works?)|(?:as|per) (?:requested|your request)|was (?:changed|updated|modified) to)\b/i;

const NARRATION = [
  /^step\s*\d+\b/i,
  /^(?:first(?:ly)?|second(?:ly)?|next|then|finally|lastly|now)\s*,?\s+(?:we|let'?s|i|you)\b/i,
  /^(?:finally|lastly),\s/i,
  /^(?:here|now) we\b/i,
  /^let(?:'s| us)\b/i,
  // "We need to" and "We can't" explain constraints in human code as often as not.
  /^we (?:now |then |first )?(?:will|are going to|iterate|loop|create|initialize|set up|start by)\b/i,
  /^this (?:function|method|block|code|section|loop|line|part|snippet|class|helper|component|hook|module|script|file)\s+(?:is used to|will|does|handles|takes|returns|retrieves|renders|parses|builds|creates|checks|initializes|computes|calculates|converts|is responsible)\b/i,
];

const FILLER = [
  /^(?:note that|please note|it'?s worth noting|it is worth noting|it'?s important to|it is important to|keep in mind|remember that|as you can see|as mentioned|basically|essentially|simply put|in other words|just to be safe|for good measure)\b/i,
  /^(?:IMPORTANT|CRITICAL)\s*:/,
  /^(?:this|which) (?:ensures|guarantees|makes sure|allows us to|helps (?:us )?to|is (?:needed|necessary|required) (?:to|for|because))\b/i,
  /^(?:make sure|ensure)\s+(?:to|that|we|you)\b/i,
  /^handle (?:the )?(?:case|edge case|scenario|situation)s? (?:where|when|in which)\b/i,
  /^(?:helper|utility) (?:function|method) (?:to|that|for)\b/i,
];

const HEDGING =
  /\b(?:should (?:work|be fine|be enough|be sufficient) (?:for|in)|you (?:may|might|could) (?:want|need) to|you(?:'ll| will) (?:want|need) to|adjust (?:this |it )?(?:as needed|accordingly|based on|depending on)|depending on your|based on your (?:needs|use case|requirements)|in a real(?:[- ]world)? (?:app|application|implementation|scenario|project|system|environment|codebase)\b|in production,? (?:you|we) (?:would|should|might|may)|this is (?:a |just a )?(?:simplified|basic|naive|simple) (?:example|version|implementation|approach)|^placeholder\b|for (?:demonstration|illustration) purposes|for the sake of (?:simplicity|brevity|this example)|for simplicity\b|replace (?:this |it )?with (?:your|the actual|a real)|your (?:actual|own) )/i;

// Words that carry no claim of their own when a comment names what the next line does.
const STOPWORDS = new Set(
  (
    "a an the to of and or is are be this that it its we our in on at for with by from as if then " +
    "into so up out over each every all new given current specified necessary required needed " +
    "module modules result value values variable object instance function method code line one"
  ).split(" "),
);

// Comment verbs and the code shapes that say the same thing.
const VERB_SHAPES: [RegExp, RegExp][] = [
  [/^(?:increment|increase|add|sum|plus|append|accumulate)/, /\+\+|\+=|\+|\b(?:add|append|push|sum)\b/],
  [/^(?:decrement|decrease|subtract|minus)/, /--|-=/],
  [/^(?:set|assign|store|save|initiali[sz]e|init|define|declare|create|calculate|compute|make)/, /[^=!<>]=[^=]|\bnew\b|\b(?:const|let|var)\b/],
  [/^(?:check|verify|validate|test)/, /\b(?:if|assert|when)\b/],
  [/^(?:loop|iterate|traverse)/, /\b(?:for|foreach|while|map|forEach)\b/],
  [/^(?:call|invoke|run|execute|convert|transform|get|fetch|retrieve|read|load|send|start|stop|open|close)/, /\w\s*\(/],
  [/^(?:print|log|output|display|show|write)/, /\b(?:print|console|log|Console|System\.out|write|logger)\b/i],
  [/^(?:import|require|include)/, /\b(?:import|require|using|from)\b/],
  [/^(?:throw|raise)/, /\b(?:throw|raise)\b/],
  [/^(?:return)/, /\breturn\b/],
  [/^(?:wait|await)/, /\bawait\b/],
];

const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ing|ed|es|er|s)$/, "") : w);

function codeTokens(code: string): Set<string> {
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
  return new Set(words.map(stem));
}

function restatesCode({ text, lineCount, context }: DetectorInput): boolean {
  if (lineCount !== 1 || !context) return false;
  const words = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (!words.length || words.length > 10) return false;
  const content = words.filter((w) => w.length > 1 && !STOPWORDS.has(w));
  // One content word ("Check.", "Verify.", "Token lists.") is a human section label as often as not.
  if (content.length < 2 || content.length > 6) return false;
  const tokens = codeTokens(context);
  const matched = content.filter((w) => {
    const s = stem(w);
    if (tokens.has(s)) return true;
    for (const t of tokens) if (t.length >= 3 && (s.startsWith(t) || t.startsWith(s))) return true;
    return VERB_SHAPES.some(([verb, shape]) => verb.test(w) && shape.test(context));
  });
  return matched.length / content.length >= 2 / 3;
}

export const DETECTORS: readonly Detector[] = [
  {
    name: "restates-code",
    description: "names what the adjacent line of code already says",
    // People restate code too ("load config file"); design.md § Scan detectors.
    score: 0.68,
    enabled: false,
    test: restatesCode,
  },
  {
    name: "narrates-steps",
    description: 'walks through the code as steps ("Step 1:", "Now we", "Let\'s")',
    score: 0.81,
    enabled: true,
    test: ({ firstLine }) => anyOf(NARRATION, firstLine),
  },
  {
    name: "change-history",
    description: 'describes an edit instead of the code ("Updated to", "Fixed", "NEW:")',
    score: 1,
    enabled: true,
    test: ({ firstLine, text }) => anyOf(CHANGE_HISTORY_OPENERS, firstLine) || CHANGE_HISTORY_ANYWHERE.test(text),
  },
  {
    name: "emoji",
    description: "contains an emoji",
    score: 1,
    enabled: true,
    test: ({ text }) => EMOJI.test(text),
  },
  {
    name: "filler-opener",
    description: 'opens with filler ("Note that", "This ensures", "IMPORTANT:")',
    // "Note that" and "Ensure that" are everyday human openers; design.md § Scan detectors.
    score: 0.39,
    enabled: false,
    test: ({ firstLine }) => anyOf(FILLER, firstLine),
  },
  {
    name: "hedging",
    description: 'hedges or addresses the reader ("you may want to", "in a real app", "for simplicity")',
    score: 0.92,
    enabled: true,
    test: ({ text }) => HEDGING.test(text),
  },
];

export function detectorNamed(name: string): Detector | undefined {
  return DETECTORS.find((d) => d.name === name);
}
