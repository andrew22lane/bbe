// =====================================================================
// engine/lib.mjs — the shared site engine core. ONE copy, two brands.
//
// This file holds the parts of the generator that are the same for every
// brand: the HTML skeleton of <head>, the page wrapper, the escape and
// clamp helpers, URL building, the breadcrumb nav, the reveal and crumb
// scripts, and the two brand-blind JSON-LD builders.
//
// It holds NO brand facts. No colour, no name, no tracking id, no font.
// Everything brand-specific arrives through the context object passed to
// createEngine(). A brand's lib.mjs builds that context from its brand
// pack and re-exports what its page templates import, so the templates
// never change.
//
// bex-site is the home of this file. design-hacker-apex carries a byte
// mirror in its own engine/ folder, guarded by tools/engine-parity.mjs,
// because Cloudflare's builder cannot see a sibling repo.
//
// THE RULE: nothing lands here unless both brands emit the exact same
// bytes after it lands. tools/verify-byte-identity.mjs is the proof.
// =====================================================================

// ---- pure helpers, no context needed ----
export const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export const clamp=(s,n)=>{s=String(s==null?'':s).replace(/\s+/g,' ').trim();return s.length<=n?s:s.slice(0,n-1).replace(/\s+\S*$/,'').trim()+'…';};

// A self-hosted @font-face rule. Both brands ship woff2 subsets from
// Fontsource under /assets/fonts/; only the families differ.
export const fontFace=BASE=>(fam,style,wght,file)=>`@font-face{font-family:'${fam}';font-style:${style};font-weight:${wght};font-display:swap;src:url('${BASE}/assets/fonts/${file}.woff2') format('woff2')}`;

// Which pack does this build read? PACK names a slug; the file is
// <brandDir>/<slug>.brandpack.json. Each repo passes its own default, so an
// ordinary build needs no env at all. Build time only: nothing here reaches the
// browser and no request ever branches on it.
//
// Named slugs today: bex-co, design-hacker.
export function resolvePack(brandDir, defaultSlug, fs, path){
  const slug=process.env.PACK||defaultSlug;
  if(!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`PACK must be a lower-case slug, got "${slug}"`);
  const file=path.join(brandDir, `${slug}.brandpack.json`);
  let raw;
  try{ raw=fs.readFileSync(file,'utf8'); }
  catch(e){
    const have=fs.readdirSync(brandDir).filter(f=>f.endsWith('.brandpack.json')).map(f=>f.replace('.brandpack.json','')).join(', ')||'none';
    throw new Error(`PACK=${slug}: no pack at ${file}. This repo carries: ${have}`);
  }
  const pack=JSON.parse(raw);
  if(!pack.outputs||!pack.outputs.web) throw new Error(`PACK=${slug}: the pack has no outputs.web layer, so the generator has no web brand to read`);
  if(slug!==defaultSlug) console.log(`[pack] building with ${slug} (default is ${defaultSlug})`);
  return {slug,file,pack};
}

// ---- reading a brand pack's outputs.web layer ----
// Both brands hold their colours in the pack and put them back into CSS at build
// time. These two helpers are that machinery, so there is one copy of it.

// Flatten outputs.web.palette into one readable name per colour, for use inside
// template literals. Nested groups flatten camelCase, so palette.teal["900"] is
// C.teal900 and palette.surface.darkTop is C.surfaceDarkTop. Keys starting with
// an underscore, and "evidence", are prose about the palette and are skipped.
// So is any entry that carries no string value, which is how a group of notes
// stays out of the colour namespace.
export function flattenPalette(palette){
  const out={};
  const skip=k=>k.startsWith('_')||k==='evidence';
  const set=(k,v)=>{ if(k in out&&out[k]!==v) throw new Error(`brand pack: two values for C.${k}`); out[k]=v; };
  for(const [k,v] of Object.entries(palette)){
    if(skip(k)) continue;
    if(v&&typeof v==='object'&&typeof v.value==='string'){ set(k,v.value); continue; }
    if(!v||typeof v!=='object') continue;
    for(const [k2,v2] of Object.entries(v)){
      if(skip(k2)) continue;
      if(!v2||typeof v2!=='object'||typeof v2.value!=='string') continue;
      set(k+k2[0].toUpperCase()+k2.slice(1), v2.value);
    }
  }
  return Object.freeze(out);
}

// Fill {{dotted.path}} placeholders in a stylesheet from outputs.web. A sheet
// that still holds an unresolved placeholder is a build error, never a silent
// pass-through of {{...}} into shipped CSS.
export function makeFillTokens(WEB){
  const packValue=dotted=>{
    let node=WEB;
    for(const seg of dotted.split('.')){
      node=node?.[seg];
      if(node===undefined) throw new Error(`brand pack: no value at outputs.web.${dotted}`);
    }
    const v=(node&&typeof node==='object'&&'value' in node)?node.value:node;
    if(typeof v!=='string') throw new Error(`brand pack: outputs.web.${dotted} is not a value`);
    return v;
  };
  const fillTokens=css=>css.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g,(_,d)=>packValue(d));
  return {packValue,fillTokens};
}

// Scroll-reveal, marquee pausing, the burger menu and the image lightbox.
// Two brands, two feature sets, one script. bex runs both extras; apex runs
// neither yet. Flipping a flag to true is how apex adopts one, and the
// byte-identity check is what says the flip landed cleanly.
//   burgerAria  — burger button announces expanded/collapsed to screen readers
//   whenNear    — window.whenNear(id, cb), defers below-fold Leaflet maps
export function makeRevealScript({burgerAria=false,whenNear=false}={}){
  const bxDef=burgerAria?`function bx(open){if(!b)return;b.setAttribute('aria-expanded',open?'true':'false');b.setAttribute('aria-label',open?'Close menu':'Open menu');}\n`:'';
  const bxOpen=burgerAria
    ? `b&&b.addEventListener('click',()=>{const o=m.classList.toggle('open');b.classList.toggle('open');bx(o);});`
    : `b&&b.addEventListener('click',()=>{m.classList.toggle('open');b.classList.toggle('open');});`;
  const bxClose=burgerAria
    ? `m&&m.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{m.classList.remove('open');b&&b.classList.remove('open');bx(false);}));`
    : `m&&m.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{m.classList.remove('open');b&&b.classList.remove('open');}));`;
  const near=whenNear?`// Defer below-fold Leaflet maps until scrolled near (saves tiles + JS during load)\nwindow.whenNear=function(id,cb){var el=document.getElementById(id);if(!el||!('IntersectionObserver'in window))return cb();var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){io.disconnect();cb();}});},{rootMargin:'400px'});io.observe(el);};\n`:'';
  return `<script>
const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12});
document.querySelectorAll('.r,.stagger').forEach(el=>{const x=el.getBoundingClientRect();if(x.top<innerHeight*.95)el.classList.add('in');else io.observe(el);});
// Pause photo marquees while off-screen so they stop compositing (mobile scroll + battery)
var mqs=[].slice.call(document.querySelectorAll('.marquee'));
if(mqs.length&&'IntersectionObserver'in window){var mio=new IntersectionObserver(function(es){es.forEach(function(e){var t=e.target.querySelectorAll('.mq-track');for(var i=0;i<t.length;i++)t[i].classList.toggle('mq-paused',!e.isIntersecting);
/* Wake the images. A lazy <img> inside a horizontally-translated marquee track sits far
   outside the viewport, so the native lazy heuristic never fires and the tile stays blank
   or pops in mid-slide. Measured on the LIVE home page 2026-09-06: 24 marquee images,
   only 3 ever loaded. Flipping loading to eager on an unloaded img starts the fetch, so
   the same observer that already unpauses the animation now also fills the strip. Fires
   at the 200px rootMargin, i.e. still below the fold, so it costs the LCP nothing. */
if(e.isIntersecting&&!e.target.__mqLit){e.target.__mqLit=1;var g=e.target.querySelectorAll('img[loading="lazy"]');for(var k=0;k<g.length;k++)g[k].loading='eager';}});},{rootMargin:'200px'});mqs.forEach(function(el){mio.observe(el);});}
const b=document.getElementById('burger'),m=document.getElementById('mobile');
${bxDef}${bxOpen}
${bxClose}
${near}// Lightbox for gallery images (img.lb with data-full)
(function(){var imgs=[].slice.call(document.querySelectorAll('img.lb'));if(!imgs.length)return;
var ov=document.createElement('div');ov.className='lightbox';ov.innerHTML='<button class="lb-x" aria-label="Close">&times;</button><button class="lb-prev" aria-label="Previous">&#8249;</button><img class="lb-img" alt=""><button class="lb-next" aria-label="Next">&#8250;</button>';document.body.appendChild(ov);
var big=ov.querySelector('.lb-img'),i=0;
function show(n){i=(n+imgs.length)%imgs.length;big.src=imgs[i].getAttribute('data-full')||imgs[i].src;big.alt=imgs[i].alt;}
function open(n){show(n);ov.classList.add('on');document.body.style.overflow='hidden';}
function close(){ov.classList.remove('on');document.body.style.overflow='';}
imgs.forEach(function(im,n){im.style.cursor='zoom-in';im.addEventListener('click',function(){open(n);});});
ov.querySelector('.lb-x').onclick=close;
ov.querySelector('.lb-prev').onclick=function(e){e.stopPropagation();show(i-1);};
ov.querySelector('.lb-next').onclick=function(e){e.stopPropagation();show(i+1);};
ov.addEventListener('click',function(e){if(e.target===ov)close();});
document.addEventListener('keydown',function(e){if(!ov.classList.contains('on'))return;if(e.key==='Escape')close();else if(e.key==='ArrowLeft')show(i-1);else if(e.key==='ArrowRight')show(i+1);});
var x0=null;ov.addEventListener('touchstart',function(e){x0=e.touches[0].clientX;},{passive:true});
ov.addEventListener('touchend',function(e){if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>40)show(i+(dx<0?1:-1));x0=null;});
})();
document.querySelectorAll('[data-shuffle]').forEach(function(c){var k=[].slice.call(c.children);for(var i=k.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=k[i];k[i]=k[j];k[j]=t;}k.forEach(function(e){c.appendChild(e);});});
</script>`;
}

// A long breadcrumb trail overflows on a phone. Scroll it to the current page.
export const crumbScript=`<script>(function(){try{var c=document.querySelector('.crumbs .container');if(c&&window.innerWidth<=560&&c.scrollWidth>c.clientWidth){c.scrollLeft=c.scrollWidth;c.classList.add('crumbs-faded');}}catch(e){}})();</script>`;

// Breadcrumb nav, rendered from the page's own BreadcrumbList JSON-LD so the
// visible trail and the structured data can never disagree.
export function crumbsNav(jsonld){
  const bc=(jsonld||[]).find(o=>o&&o["@type"]==="BreadcrumbList");
  if(!bc||!bc.itemListElement||bc.itemListElement.length<2)return "";
  const items=bc.itemListElement;
  const parts=items.map((it,i)=>{
    const last=i===items.length-1;
    const name=i===0?"Home":it.name;
    return last?`<span aria-current="page">${esc(name)}</span>`:`<a href="${it.item}">${esc(name)}</a>`;
  });
  return `<nav class="crumbs" aria-label="Breadcrumb"><div class="container">${parts.join('<span class="crumbs-sep">/</span>')}</div></nav>`;
}

// =====================================================================
// createEngine(ctx) — build the brand-aware half of the core.
//
// ctx, every field:
//   SITE          canonical origin, no trailing slash
//   BASE          path prefix, '' at a domain root
//   BUILD         asset cache-buster string
//   themeColor    <meta name="theme-color">
//   ogSiteName    og:site_name, escaped here
//   ogDefault     full URL of the fallback share image
//   headMeta      raw HTML appended straight after the theme-color line ('')
//   fontPreload   raw HTML for the font preload line ('')
//   cssHead       (canonical) => raw HTML that loads the stylesheet
//   headTail      raw HTML between cssHead and the js-class script ('')
//   reveal        {burgerAria, whenNear} feature flags for revealScript
//   shell         page chrome, all brand-owned:
//     nav(active), footer(noCta)
//     bodyAttrs({noindex})   attributes on <body>            ('')
//     bodyPrefix({noindex})  markup first inside <body>       ('')
//     scripts                after revealScript, before extraScript ('')
//     tail                   after extraScript, last in <body>      ('')
// =====================================================================
export function createEngine(ctx){
  const {SITE,BASE,BUILD}=ctx;
  const shell=ctx.shell||{};
  const nothing=()=>'';
  const bodyAttrs=shell.bodyAttrs||nothing;
  const bodyPrefix=shell.bodyPrefix||nothing;
  const navFn=shell.nav||nothing;
  const footerFn=shell.footer||nothing;

  const u=(p='')=>BASE+(p?('/'+p.replace(/^\/|\/$/g,'')+'/').replace(/\/+/g,'/'):'/');
  const abs=p=>SITE+u(p);
  const revealScript=makeRevealScript(ctx.reveal||{});

  function head({title,desc,canonical,ogImage,jsonld=[],noindex=false}){
    title=clamp(title,60);desc=clamp(desc,158);
    const img=ogImage||ctx.ogDefault;
    const ld=jsonld.map(o=>`<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('');
    return `<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${canonical}"/>
<meta name="theme-color" content="${ctx.themeColor}"/>${ctx.headMeta||''}
<link rel="icon" href="${BASE}/assets/favicon.svg?v=${BUILD}" type="image/svg+xml"/>
<link rel="icon" href="${BASE}/assets/favicon-32.png?v=${BUILD}" sizes="32x32" type="image/png"/>
<link rel="icon" href="${BASE}/assets/favicon-16.png?v=${BUILD}" sizes="16x16" type="image/png"/>
<link rel="apple-touch-icon" href="${BASE}/assets/apple-touch-icon.png?v=${BUILD}"/>
${(process.env.ROBOTS!=='allow'||noindex)?'<meta name="robots" content="noindex, nofollow"/>':''}
<meta property="og:type" content="website"/><meta property="og:site_name" content="${esc(ctx.ogSiteName)}"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(desc)}"/>
<meta property="og:url" content="${canonical}"/><meta property="og:image" content="${esc(img)}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(desc)}"/><meta name="twitter:image" content="${esc(img)}"/>
<link rel="preconnect" href="https://www.loom.com"><link rel="preconnect" href="https://cdn.loom.com"><link rel="dns-prefetch" href="https://www.loom.com">
${ctx.fontPreload||''}
${ctx.cssHead(canonical)}
${ctx.headTail||''}<script>document.documentElement.className='js'</script>${ld}`;
  }

  // shell picks the page chrome. Two values, nothing else.
  //
  //   'full' (the default) — the site document: nav, breadcrumbs, footer,
  //          reveal script, the brand's own scripts and tail. Every page that
  //          existed before this option was added takes this branch, and its
  //          bytes are exactly what they were.
  //
  //   'bare' — a standalone document. No nav, no breadcrumbs, no footer, no
  //          reveal script, none of the brand shell. The page brings its own
  //          chrome through the four slots below. This is the option a landing
  //          page, a legal page or a thank-you page needs. Without it a brand
  //          has to hand-write a second <html> shell, and a second shell is the
  //          thing this engine exists to delete.
  //
  // The four bare slots, raw HTML, each defaulting to '':
  //   bare.bodyAttrs  attributes on <body>      e.g. ' data-page-type="offer"'
  //   bare.lead       markup between <body> and <main>, a page's own header
  //   bare.mainAttrs  attributes on <main>      e.g. ' class="cs s-deep"'
  //   bare.tail       markup after </main>, before extraScript, a micro footer
  //
  // active, noCta and noCrumbs describe chrome that 'bare' does not emit, so
  // they are ignored there. extraHead and extraScript work in both.
  function page({title,desc,canonical,ogImage,jsonld,active,body,extraHead='',extraScript='',noCta=false,noCrumbs=false,noindex=false,shell:chrome='full',bare={}}){
    if(chrome!=='full'&&chrome!=='bare') throw new Error(`page(): shell must be 'full' or 'bare', got ${JSON.stringify(chrome)}`);
    const doc=`<!doctype html><html lang="en"><head>${head({title,desc,canonical,ogImage,jsonld,noindex})}${extraHead}</head>`;
    if(chrome==='bare') return `${doc}
<body${bare.bodyAttrs||''}>${bare.lead||''}<main${bare.mainAttrs||''}>${body}</main>${bare.tail||''}${extraScript}</body></html>`;
    return `${doc}
<body${bodyAttrs({noindex})}>${bodyPrefix({noindex})}${navFn(active)}<main>${noCrumbs?'':crumbsNav(jsonld)}${body}</main>${footerFn(noCta)}${revealScript}${shell.scripts||''}${extraScript}${shell.tail||''}</body></html>`;
  }

  // ---- brand-blind JSON-LD. Everything else (Organization, HairSalon,
  // Person, WebSite) carries brand facts and stays with the brand. ----
  const breadcrumbLD=items=>({"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:items.map((it,i)=>({"@type":"ListItem",position:i+1,name:it.name,item:abs(it.path)}))});
  const faqLD=qa=>({"@context":"https://schema.org","@type":"FAQPage",mainEntity:qa.map(([q,a])=>({"@type":"Question",name:q,acceptedAnswer:{"@type":"Answer",text:a}}))});

  return {u,abs,head,page,crumbsNav,crumbScript,revealScript,breadcrumbLD,faqLD,esc,clamp};
}
