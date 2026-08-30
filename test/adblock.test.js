'use strict';

/** Tests for the ad-block filter engine. Pure logic, no Electron needed. */

const assert = require('assert');
const { FilterEngine } = require('../src/main/adblock/filter-engine');
const DEFAULT_FILTERS = require('../src/main/adblock/default-filters');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const PAGE = 'https://news.example.com/article';
const blocked = (e, url, type = 'script', src = PAGE) => Boolean(e.match(url, type, src));

console.log('\npattern matching');
{
  const e = new FilterEngine();
  e.addFilters(`
||ads.example.com^
|http://start.example.com
/banner/*.gif|
@@||ads.example.com/allowed.js
`);

  check('|| matches the domain and its subdomains', () => {
    assert.ok(blocked(e, 'https://ads.example.com/a.js'));
    assert.ok(blocked(e, 'https://sub.ads.example.com/a.js'));
  });
  check('|| does not match an unrelated domain', () => {
    assert.ok(!blocked(e, 'https://notads.example.com/a.js'));
    assert.ok(!blocked(e, 'https://example.com/a.js'));
  });
  check('| anchors to the start of the URL', () => {
    assert.ok(blocked(e, 'http://start.example.com/x.js'));
    assert.ok(!blocked(e, 'https://redirect.com/?u=http://start.example.com'));
  });
  check('wildcards and trailing anchors work', () => {
    assert.ok(blocked(e, 'https://cdn.com/banner/top.gif', 'image'));
    assert.ok(!blocked(e, 'https://cdn.com/banner/top.gif.html', 'image'));
  });
  check('@@ exception rules override blocks', () => {
    assert.ok(!blocked(e, 'https://ads.example.com/allowed.js'));
    assert.ok(blocked(e, 'https://ads.example.com/other.js'));
  });
}

console.log('\nregex rules');
{
  const e = new FilterEngine();
  e.addFilter('/tracker-\\d+\\.js/');
  check('regex literals are honoured', () => {
    assert.ok(blocked(e, 'https://x.com/tracker-42.js'));
    assert.ok(!blocked(e, 'https://x.com/tracker-abc.js'));
  });
}

console.log('\n$type options');
{
  const e = new FilterEngine();
  e.addFilters(`
||cdn.example.com/a$script
||cdn.example.com/b$image,font
||cdn.example.com/c$~script
`);
  check('a type option restricts to that type', () => {
    assert.ok(blocked(e, 'https://cdn.example.com/a', 'script'));
    assert.ok(!blocked(e, 'https://cdn.example.com/a', 'image'));
  });
  check('multiple types are OR-ed', () => {
    assert.ok(blocked(e, 'https://cdn.example.com/b', 'image'));
    assert.ok(blocked(e, 'https://cdn.example.com/b', 'font'));
    assert.ok(!blocked(e, 'https://cdn.example.com/b', 'script'));
  });
  check('negated types are excluded', () => {
    assert.ok(!blocked(e, 'https://cdn.example.com/c', 'script'));
    assert.ok(blocked(e, 'https://cdn.example.com/c', 'image'));
  });
  check('Electron resource types are mapped', () => {
    const e2 = new FilterEngine();
    e2.addFilter('||t.com^$xmlhttprequest');
    assert.ok(blocked(e2, 'https://t.com/x', 'xhr'));
    const e3 = new FilterEngine();
    e3.addFilter('||t.com^$subdocument');
    assert.ok(blocked(e3, 'https://t.com/x', 'subFrame'));
  });
}

console.log('\n$third-party');
{
  const e = new FilterEngine();
  e.addFilter('||track.com^$third-party');
  check('blocks only in a third-party context', () => {
    assert.ok(blocked(e, 'https://track.com/p.js', 'script', 'https://other.com/'));
    assert.ok(!blocked(e, 'https://track.com/p.js', 'script', 'https://track.com/'));
  });
  check('subdomains count as first-party', () => {
    assert.ok(!blocked(e, 'https://a.track.com/p.js', 'script', 'https://b.track.com/'));
  });
}

console.log('\n$domain scoping');
{
  const e = new FilterEngine();
  e.addFilters(`
||widget.com^$domain=foo.com|bar.com
||other.com^$domain=~safe.com
`);
  check('applies only on the listed domains', () => {
    assert.ok(blocked(e, 'https://widget.com/w.js', 'script', 'https://foo.com/'));
    assert.ok(blocked(e, 'https://widget.com/w.js', 'script', 'https://sub.bar.com/'));
    assert.ok(!blocked(e, 'https://widget.com/w.js', 'script', 'https://baz.com/'));
  });
  check('negated domains are excluded', () => {
    assert.ok(blocked(e, 'https://other.com/x.js', 'script', 'https://any.com/'));
    assert.ok(!blocked(e, 'https://other.com/x.js', 'script', 'https://safe.com/'));
  });
}

console.log('\ncosmetic filtering');
{
  const e = new FilterEngine();
  e.addFilters(`
##.generic-ad
example.com##.site-ad
example.com,other.com##.shared-ad
sub.example.com##.deep-ad
example.com#@#.generic-ad
`);
  check('generic rules apply everywhere', () => {
    assert.ok(e.cosmeticCSS('random.org').includes('.generic-ad'));
  });
  check('domain rules apply on that domain only', () => {
    assert.ok(e.cosmeticCSS('example.com').includes('.site-ad'));
    assert.ok(!e.cosmeticCSS('random.org').includes('.site-ad'));
  });
  check('subdomains inherit parent-domain rules', () => {
    assert.ok(e.cosmeticCSS('www.example.com').includes('.site-ad'));
  });
  check('multi-domain rules apply to each', () => {
    assert.ok(e.cosmeticCSS('other.com').includes('.shared-ad'));
  });
  check('#@# exceptions remove a selector', () => {
    assert.ok(!e.cosmeticCSS('example.com').includes('.generic-ad'));
    assert.ok(e.cosmeticCSS('elsewhere.com').includes('.generic-ad'));
  });
  check('output is valid display:none CSS', () => {
    assert.ok(/\{display:none!important\}$/.test(e.cosmeticCSS('example.com').trim()));
  });
  check('procedural selectors are skipped', () => {
    const e2 = new FilterEngine();
    e2.addFilters('example.com##.x:has-text(Ad)\nexample.com##+js(nowebrtc)');
    assert.strictEqual(e2.cosmeticCSS('example.com'), '');
  });
  check('unknown hosts produce no CSS', () => {
    assert.strictEqual(e.cosmeticCSS(''), '');
  });
}

console.log('\nparser robustness');
{
  const e = new FilterEngine();
  const before = e.stats().networkRules;
  e.addFilters(`
! a comment
[Adblock Plus 2.0]

||valid.com^
||broken.com^$totally-unknown-option
`);
  check('comments and blank lines are ignored', () => {
    assert.strictEqual(e.stats().networkRules, before + 1);
  });
  check('rules with unknown options are dropped, not crashed on', () => {
    assert.ok(!blocked(e, 'https://broken.com/x.js'));
    assert.ok(blocked(e, 'https://valid.com/x.js'));
  });
  check('malformed regex does not throw', () => {
    assert.doesNotThrow(() => e.addFilter('/[unclosed/'));
  });
}

console.log('\nbuilt-in list');
{
  const e = new FilterEngine();
  e.addFilters(DEFAULT_FILTERS);
  const stats = e.stats();

  check('loads a meaningful number of rules', () => {
    assert.ok(stats.networkRules > 100, `only ${stats.networkRules} network rules`);
    assert.ok(stats.cosmeticRules > 20, `only ${stats.cosmeticRules} cosmetic rules`);
  });
  check('blocks the usual ad servers', () => {
    assert.ok(blocked(e, 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'));
    assert.ok(blocked(e, 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'));
    assert.ok(blocked(e, 'https://www.google-analytics.com/analytics.js'));
    assert.ok(blocked(e, 'https://connect.facebook.net/en_US/fbevents.js'));
    assert.ok(blocked(e, 'https://static.criteo.net/js/ld/ld.js'));
    assert.ok(blocked(e, 'https://cdn.taboola.com/libtrc/loader.js'));
  });
  check('does not block ordinary sites', () => {
    assert.ok(!blocked(e, 'https://en.wikipedia.org/w/load.php'));
    assert.ok(!blocked(e, 'https://github.com/assets/app.js'));
    assert.ok(!blocked(e, 'https://cdn.jsdelivr.net/npm/vue/dist/vue.js'));
    assert.ok(!blocked(e, 'https://fonts.googleapis.com/css?family=Inter', 'stylesheet'));
    assert.ok(!blocked(e, 'https://news.example.com/main.css', 'stylesheet'));
  });
  check('first-party analytics on its own site is excepted', () => {
    assert.ok(!blocked(e, 'https://www.google-analytics.com/analytics.js', 'script', 'https://google.com/'));
  });
  check('hides adsbygoogle containers', () => {
    assert.ok(e.cosmeticCSS('news.example.com').includes('.adsbygoogle'));
  });
}

console.log('\nperformance');
{
  const e = new FilterEngine();
  e.addFilters(DEFAULT_FILTERS);
  // Synthesise a large list to prove the token index scales.
  for (let i = 0; i < 20000; i += 1) e.addFilter(`||synthetic-tracker-${i}.com^`);

  check('20k+ rules match in well under a millisecond each', () => {
    const urls = [
      'https://en.wikipedia.org/w/load.php',
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      'https://cdn.example.com/app.bundle.js'
    ];
    const start = process.hrtime.bigint();
    const N = 30000;
    for (let i = 0; i < N; i += 1) e.match(urls[i % urls.length], 'script', PAGE);
    const perCall = Number(process.hrtime.bigint() - start) / 1e6 / N;
    console.log(`      ${e.stats().networkRules} rules, ${perCall.toFixed(4)} ms/lookup`);
    assert.ok(perCall < 0.5, `too slow: ${perCall.toFixed(4)} ms per lookup`);
  });
}

console.log(`\n${passed} passed, ${failed} failed.`);
