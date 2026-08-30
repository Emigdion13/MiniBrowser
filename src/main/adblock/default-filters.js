'use strict';

/**
 * Built-in filter list, in Adblock Plus syntax.
 *
 * This ships offline on purpose: no network fetch before the first page load
 * means there is nothing for an attacker to intercept or poison. Subscriptions
 * to EasyList / EasyPrivacy can be enabled by the user from the Privacy menu.
 */

module.exports = `
! ---- Ad serving infrastructure ----
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||adservice.google.^
||pagead2.googlesyndication.com^
||partner.googleadservices.com^
||2mdn.net^
||adnxs.com^
||adsrvr.org^
||rubiconproject.com^
||pubmatic.com^
||openx.net^
||criteo.com^
||criteo.net^
||taboola.com^
||taboolasyndication.com^
||outbrain.com^
||sharethrough.com^
||smartadserver.com^
||casalemedia.com^
||indexww.com^
||bidswitch.net^
||yieldmo.com^
||teads.tv^
||moatads.com^
||adform.net^
||media.net^
||serving-sys.com^
||zedo.com^
||revcontent.com^
||adroll.com^
||advertising.com^
||adtechus.com^
||amazon-adsystem.com^
||ads.yahoo.com^
||adcolony.com^
||applovin.com^
||unityads.unity3d.com^
||inmobi.com^
||mopub.com^
||smaato.net^
||pubnative.net^
||adsafeprotected.com^
||doubleverify.com^
||contextweb.com^
||gumgum.com^
||triplelift.com^
||districtm.io^
||sovrn.com^
||lijit.com^
||33across.com^
||spotxchange.com^
||springserve.com^
||sonobi.com^
||conversantmedia.com^
||bluekai.com^
||exelator.com^
||agkn.com^
||tapad.com^
||crwdcntrl.net^
||rlcdn.com^
||demdex.net^
||everesttech.net^
||omtrdc.net^
||adsymptotic.com^

! ---- Analytics and telemetry ----
||google-analytics.com^
||analytics.google.com^
||googletagmanager.com^
||googletagservices.com^
||segment.io^
||segment.com^
||cdn.segment.com^
||mixpanel.com^
||amplitude.com^
||heap.io^
||heapanalytics.com^
||hotjar.com^
||hotjar.io^
||fullstory.com^
||mouseflow.com^
||crazyegg.com^
||quantserve.com^
||quantcast.com^
||scorecardresearch.com^
||chartbeat.com^
||chartbeat.net^
||parsely.com^
||newrelic.com^
||nr-data.net^
||statcounter.com^
||clarity.ms^
||kissmetrics.com^
||optimizely.com^
||mktoresp.com^
||marketo.net^
||pardot.com^
||hubspot.com^$third-party
||hs-analytics.net^
||branch.io^
||appsflyer.com^
||adjust.com^
||kochava.com^
||bugsnag.com^$third-party
||sentry.io^$third-party

! ---- Social / cross-site trackers ----
||connect.facebook.net^
||facebook.com/tr
||pixel.facebook.com^
||ct.pinterest.com^
||analytics.tiktok.com^
||ads-twitter.com^
||analytics.twitter.com^
||static.ads-twitter.com^
||bat.bing.com^
||ads.linkedin.com^
||px.ads.linkedin.com^
||snap.licdn.com^
||sc-static.net^
||ads.reddit.com^
||events.redditmedia.com^

! ---- Fingerprinting and session replay ----
||fingerprintjs.com^
||fpjs.io^
||logrocket.com^
||lr-ingest.io^
||smartlook.com^
||inspectlet.com^
||luckyorange.com^
||sessioncam.com^
||quantummetric.com^
||contentsquare.net^
||decibelinsight.net^
||glassboxdigital.io^

! ---- Generic path patterns ----
/adsbygoogle.js
/pagead/js/adsbygoogle.js
||*/ads/banner
||*/adserver/
/googlesyndication.com/*
-advertisement-icon.
/advertisement/*$image
/adframe.$subdocument
/ad-choices.$image
||*/prebid.js
||*/gpt.js$script
||*/analytics.js$third-party,script
||*/tracking.js$third-party,script
||*/telemetry$third-party,xmlhttprequest
||*/beacon$third-party,ping
||*/pixel.gif$third-party,image
||*/1x1.gif$third-party,image
||*/track.png$third-party,image

! ---- Exceptions: things that break sites when blocked ----
@@||googletagmanager.com/gtag/js$script,domain=google.com
@@||google-analytics.com/analytics.js$domain=google.com
@@||amazon-adsystem.com^$domain=amazon.com|amazon.co.uk|amazon.de
@@||sentry.io^$domain=sentry.io
@@||segment.com^$domain=segment.com
@@||optimizely.com^$domain=optimizely.com
@@||hubspot.com^$domain=hubspot.com
@@||adjust.com^$domain=adjust.com

! ---- Cosmetic: hide leftover ad containers ----
##.adsbygoogle
##.ad-banner
##.ad-container
##.ad-wrapper
##.ad-placeholder
##.advertisement
##.advert-container
##.sponsored-content
##.sponsored-post
##.promoted-content
##.google-ad
##.dfp-ad
##.banner-ad
##.leaderboard-ad
##.sidebar-ad
##.outbrain-widget
##.taboola-widget
##.trc_related_container
##.OUTBRAIN
##div[id^="google_ads_iframe"]
##div[id^="div-gpt-ad"]
##iframe[src*="doubleclick.net"]
##iframe[src*="googlesyndication.com"]
##iframe[id^="google_ads_frame"]
##a[href^="https://googleads.g.doubleclick.net"]
##ins.adsbygoogle
##[data-ad-slot]
##[data-ad-client]
##[aria-label="Advertisement"]
`;
