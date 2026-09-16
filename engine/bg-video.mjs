// =====================================================================
// engine/bg-video.mjs, the ambient background video block.
//
// Andrew ruled 2026-09-16: ONE ambient background video per page, hero only,
// slow, low-contrast, behind a scrim, no faces or text in the clip, poster
// frame under reduced-motion and on slow connections, never behind a form or
// pricing table. Every other section uses CSS motion or stays still. This
// module makes that recipe reusable across every BBE site so no project ever
// hand-rolls it again.
//
// Brand-blind, same rule as the rest of engine/: no hex, no brand fact. Every
// colour a consumer sees here is a CSS custom property (--bgv-fade,
// --bgv-scrim) that the brand's own kit css sets.
//
//   import { bgVideo, bgVideoCSS, bgVideoScript } from './bg-video.mjs';
//
// bgVideoCSS()     -> a CSS string. Wire it into the site's stylesheet once.
// bgVideoScript()  -> a <script> string. createEngine's page() includes this
//                     automatically, only on a page whose body uses the block.
// bgVideo({...})   -> the HTML string for one block.
// =====================================================================

// ---------------------------------------------------------------- the CSS
export function bgVideoCSS() {
  return `
.bg-video{position:relative;isolation:isolate;overflow:hidden}
.bg-video__media{position:absolute;inset:0;z-index:0;overflow:hidden}
.bg-video__poster,.bg-video__video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bg-video__video{opacity:0;transition:opacity var(--bgv-fade,.6s) ease}
.bg-video.is-playing .bg-video__video{opacity:1}
.bg-video__scrim{position:absolute;inset:0;z-index:1;background:var(--bgv-scrim,rgba(0,0,0,.55))}
.bg-video__content{position:relative;z-index:2}
@media (prefers-reduced-motion: reduce){
  .bg-video__video{display:none}
}
@media (max-width:767px){
  .bg-video:not([data-mobile="video"]) .bg-video__video{display:none}
}
`.trim();
}

// -------------------------------------------------------------- the script
// An IIFE, safe with JS off: the page is fully rendered (poster + scrim +
// content) without it, this only upgrades the poster into a playing video.
// Bails on reduced motion, on a metered/slow connection, and on a narrow
// viewport unless the section opted into mobile video. Everything else is
// an IntersectionObserver: load the real sources and play on enter, pause
// on exit, so a below-fold hero never downloads or decodes.
export function bgVideoScript() {
  return `<script>
(function(){
try{
if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
var conn=navigator.connection||navigator.webkitConnection||navigator.mozConnection;
if(conn&&(conn.saveData||/2g|3g/.test(conn.effectiveType||'')))return;
function boot(){
if(!('IntersectionObserver'in window))return;
document.querySelectorAll('.bg-video').forEach(function(sec){
if(window.innerWidth<768&&sec.getAttribute('data-mobile')!=='video')return;
var v=sec.querySelector('.bg-video__video');
if(!v)return;
var io=new IntersectionObserver(function(es){
es.forEach(function(e){
if(e.isIntersecting){
if(!sec.__bgvLoaded){
sec.__bgvLoaded=1;
v.querySelectorAll('source[data-src]').forEach(function(s){s.src=s.getAttribute('data-src');});
v.load();
}
var p=v.play();
if(p&&p.then)p.then(function(){sec.classList.add('is-playing');}).catch(function(){});
else sec.classList.add('is-playing');
}else{
v.pause();
}
});
},{rootMargin:'200px'});
io.observe(sec);
});
}
if(document.readyState==='complete')boot();else window.addEventListener('load',boot);
}catch(e){}
})();
</script>`;
}

// ---------------------------------------------------------------- the block
// {mp4, webm, poster, posterAlt='', mobileMp4, mobile='poster'|'video',
//  scrim, content, tag='section', className='', attrs=''}
//
// mp4/webm/poster are absolute or site-relative URLs the consumer already
// resolved (this module holds no BASE, no SITE, brand-blind). `content` is
// raw HTML, already escaped by the caller if it needed to be.
export function bgVideo({
  mp4,
  webm,
  poster,
  posterAlt = '',
  mobileMp4,
  mobile = 'poster',
  scrim,
  content = '',
  tag = 'section',
  className = '',
  attrs = ''
} = {}) {
  if (!mp4 && !webm) throw new Error('bgVideo(): needs at least one of mp4 or webm');
  if (!poster) throw new Error('bgVideo(): needs a poster');

  const cls = ['bg-video', className].filter(Boolean).join(' ');

  const sources = [];
  if (mobileMp4) sources.push(`<source data-src="${mobileMp4}" type="video/mp4" media="(max-width:767px)">`);
  if (webm) sources.push(`<source data-src="${webm}" type="video/webm">`);
  if (mp4) sources.push(`<source data-src="${mp4}" type="video/mp4">`);

  const scrimStyle = scrim ? ` style="--bgv-scrim:${scrim}"` : '';

  return `<${tag} class="${cls}" data-mobile="${mobile}"${attrs}>` +
    `<div class="bg-video__media">` +
      `<img class="bg-video__poster" src="${poster}" alt="${posterAlt}" decoding="async" fetchpriority="high">` +
      `<video class="bg-video__video" muted playsinline loop preload="none" poster="${poster}" aria-hidden="true" tabindex="-1">${sources.join('')}</video>` +
    `</div>` +
    `<div class="bg-video__scrim"${scrimStyle}></div>` +
    `<div class="bg-video__content">${content}</div>` +
  `</${tag}>`;
}
