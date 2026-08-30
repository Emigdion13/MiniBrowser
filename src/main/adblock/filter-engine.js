'use strict';

/**
 * A dependency-free Adblock Plus / uBlock Origin filter engine.
 *
 * Supports the subset of the syntax that matters for real blocking:
 *
 *   ||example.com^              anchored domain match
 *   |http://example.com         start anchor
 *   /banner/*.gif|              wildcards + end anchor
 *   /ads?\d+/                   regular expression rules
 *   @@||example.com^            exception (allow) rules
 *   $script,image,third-party   type + party options
 *   $domain=a.com|~b.com        domain scoping (with negation)
 *   $~third-party               negated options
 *   example.com##.ad-banner     cosmetic element hiding
 *   example.com#@#.ad-banner    cosmetic exception
 *   ##.generic-ad               generic cosmetic rule
 *
 * Matching strategy: every network rule is indexed under a short token taken
 * from the pattern. At request time we only test rules sharing a token with
 * the URL, which keeps lookups to a handful of regex tests instead of tens of
 * thousands.
 */

const { URL } = require('url');

// Electron resourceType -> filter option name
const TYPE_ALIASES = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket'
};

const KNOWN_TYPES = new Set([
  'document', 'subdocument', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other', 'popup'
]);

// Options we parse but that do not change whether we block.
const IGNORED_OPTIONS = new Set(['important', 'first-party', 'badfilter', 'redirect', 'redirect-rule', 'removeparam', 'empty', 'mp4', 'inline-script', 'inline-font']);

const TOKEN_RE = /[a-z0-9%]{3,}/g;

function escapeRegex(text) {
  return text.replace(/[.+?${}()|[\]\\]/g, '\\$&');
}

/** Convert an ABP pattern into a RegExp. */
function patternToRegex(pattern) {
  // Already a regex literal.
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1), 'i');
  }

  let source = escapeRegex(pattern);

  // ^ is a separator: any char that is not a letter, digit, _, -, . or %
  source = source.replace(/\^/g, '(?:[^\\w\\-.%]|$)');
  // * is a wildcard
  source = source.replace(/\*/g, '.*');

  // || anchors to the start of a domain (optionally with scheme + subdomains)
  if (source.startsWith('\\|\\|')) {
    source = '^[a-z-]+://(?:[^/?#]*\\.)?' + source.slice(4);
  } else if (source.startsWith('\\|')) {
    source = '^' + source.slice(2);
  }

  // trailing | anchors to the end
  if (source.endsWith('\\|')) {
    source = source.slice(0, -2) + '$';
  }

  return new RegExp(source, 'i');
}

/** Pick a cheap indexing token from a pattern. */
function tokenize(pattern) {
  if (pattern.startsWith('/') && pattern.endsWith('/')) return null; // regex rules go in the slow lane
  const cleaned = pattern.toLowerCase().replace(/[|^*]/g, ' ');
  const matches = cleaned.match(TOKEN_RE);
  if (!matches) return null;
  // Prefer the longest token — it is the most selective.
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

function baseDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A single parsed network rule. */
class NetworkRule {
  constructor(pattern, options, isException) {
    this.regex = patternToRegex(pattern);
    this.isException = isException;
    this.types = null;        // Set of allowed types, or null = any
    this.notTypes = null;     // Set of excluded types
    this.thirdParty = null;   // true / false / null
    this.domains = null;      // Set of domains the rule applies to
    this.notDomains = null;   // Set of domains the rule is excluded on
    this.raw = (isException ? '@@' : '') + pattern;

    for (const rawOpt of options) {
      let opt = rawOpt.trim().toLowerCase();
      if (!opt) continue;

      const negated = opt.startsWith('~');
      if (negated) opt = opt.slice(1);

      if (opt.startsWith('domain=')) {
        for (const d of opt.slice(7).split('|')) {
          if (!d) continue;
          if (d.startsWith('~')) {
            (this.notDomains ||= new Set()).add(d.slice(1));
          } else {
            (this.domains ||= new Set()).add(d);
          }
        }
      } else if (opt === 'third-party' || opt === '3p') {
        this.thirdParty = !negated;
      } else if (KNOWN_TYPES.has(opt)) {
        if (negated) (this.notTypes ||= new Set()).add(opt);
        else (this.types ||= new Set()).add(opt);
      } else if (!IGNORED_OPTIONS.has(opt)) {
        // Unknown option: be conservative and disable the rule.
        this.invalid = true;
      }
    }
  }

  matches(url, type, sourceHost, isThirdParty) {
    if (this.types && !this.types.has(type)) return false;
    if (this.notTypes && this.notTypes.has(type)) return false;
    if (this.thirdParty !== null && this.thirdParty !== isThirdParty) return false;

    if (this.domains || this.notDomains) {
      const host = sourceHost || '';
      const matchesDomain = (d) => host === d || host.endsWith('.' + d);
      if (this.notDomains && [...this.notDomains].some(matchesDomain)) return false;
      if (this.domains && ![...this.domains].some(matchesDomain)) return false;
    }

    return this.regex.test(url);
  }
}

class FilterEngine {
  constructor() {
    this.blockIndex = new Map();     // token -> NetworkRule[]
    this.blockNoToken = [];          // rules we could not index
    this.allowIndex = new Map();
    this.allowNoToken = [];

    this.cosmeticGeneric = new Set();          // selectors applied everywhere
    this.cosmeticByDomain = new Map();         // domain -> Set(selectors)
    this.cosmeticExceptions = new Map();       // domain -> Set(selectors)

    this.ruleCount = 0;
    this.cosmeticCount = 0;
  }

  addFilter(line) {
    const text = line.trim();
    if (!text || text.startsWith('!') || text.startsWith('[Adblock')) return;

    // --- cosmetic rules -----------------------------------------------
    const cosmetic = text.match(/^([^#]*)#(@?)#(.+)$/);
    if (cosmetic) {
      const [, domainPart, exception, selector] = cosmetic;
      // Skip procedural / scriptlet syntax we cannot safely support.
      if (/^\+js\(|:has-text\(|:matches-css|:xpath\(|:upward\(|:remove\(/.test(selector)) return;

      const domains = domainPart ? domainPart.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : [];
      this.cosmeticCount += 1;

      if (exception === '@') {
        for (const d of domains) {
          (this.cosmeticExceptions.get(d) || this.cosmeticExceptions.set(d, new Set()).get(d)).add(selector);
        }
        return;
      }

      if (!domains.length) {
        this.cosmeticGeneric.add(selector);
      } else {
        for (const d of domains) {
          if (d.startsWith('~')) continue; // negated cosmetic domains: skip
          if (!this.cosmeticByDomain.has(d)) this.cosmeticByDomain.set(d, new Set());
          this.cosmeticByDomain.get(d).add(selector);
        }
      }
      return;
    }

    // --- network rules -------------------------------------------------
    let body = text;
    const isException = body.startsWith('@@');
    if (isException) body = body.slice(2);

    let options = [];
    const dollar = body.lastIndexOf('$');
    // Do not treat a $ inside a regex literal as an option separator.
    if (dollar !== -1 && !(body.startsWith('/') && body.lastIndexOf('/') > dollar)) {
      options = body.slice(dollar + 1).split(',');
      body = body.slice(0, dollar);
    }
    if (!body) return;

    let rule;
    try {
      rule = new NetworkRule(body, options, isException);
    } catch {
      return; // malformed regex etc.
    }
    if (rule.invalid) return;

    const token = tokenize(body);
    const index = isException ? this.allowIndex : this.blockIndex;
    const fallback = isException ? this.allowNoToken : this.blockNoToken;

    if (token) {
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(rule);
    } else {
      fallback.push(rule);
    }
    this.ruleCount += 1;
  }

  addFilters(text) {
    for (const line of String(text).split('\n')) this.addFilter(line);
  }

  /** Candidate rules for a URL, gathered from its tokens. */
  candidates(index, fallback, url) {
    const found = [];
    const tokens = url.toLowerCase().match(TOKEN_RE);
    if (tokens) {
      const seen = new Set();
      for (const t of tokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        const bucket = index.get(t);
        if (bucket) found.push(...bucket);
      }
    }
    found.push(...fallback);
    return found;
  }

  /**
   * @returns {null | { rule: string }} null = allow, object = block
   */
  match(url, resourceType, sourceUrl) {
    const type = TYPE_ALIASES[resourceType] || 'other';
    const sourceHost = hostOf(sourceUrl);
    const targetHost = hostOf(url);
    if (!targetHost) return null;

    const isThirdParty = Boolean(sourceHost) && baseDomain(sourceHost) !== baseDomain(targetHost);

    // Exceptions win, so check them first.
    for (const rule of this.candidates(this.allowIndex, this.allowNoToken, url)) {
      if (rule.matches(url, type, sourceHost, isThirdParty)) return null;
    }

    for (const rule of this.candidates(this.blockIndex, this.blockNoToken, url)) {
      if (rule.matches(url, type, sourceHost, isThirdParty)) return { rule: rule.raw };
    }

    return null;
  }

  /** CSS to hide ad elements on a given hostname. */
  cosmeticCSS(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return '';

    const selectors = new Set(this.cosmeticGeneric);

    // Walk up the domain: ads.example.co.uk -> example.co.uk -> co.uk
    const parts = host.split('.');
    const excluded = new Set();
    for (let i = 0; i < parts.length - 1; i += 1) {
      const domain = parts.slice(i).join('.');
      const add = this.cosmeticByDomain.get(domain);
      if (add) for (const s of add) selectors.add(s);
      const skip = this.cosmeticExceptions.get(domain);
      if (skip) for (const s of skip) excluded.add(s);
    }

    for (const s of excluded) selectors.delete(s);
    if (!selectors.size) return '';

    // Chunk the selector list: some engines choke on one gigantic rule.
    const list = [...selectors];
    const chunks = [];
    for (let i = 0; i < list.length; i += 300) {
      chunks.push(`${list.slice(i, i + 300).join(',')}{display:none!important}`);
    }
    return chunks.join('\n');
  }

  stats() {
    return { networkRules: this.ruleCount, cosmeticRules: this.cosmeticCount };
  }
}

module.exports = { FilterEngine, hostOf, baseDomain };
