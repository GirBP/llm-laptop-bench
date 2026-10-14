// GitHub Pages cannot set COOP/COEP headers. This network-only service worker
// adds them to same-origin responses. It stores no models, reports or requests.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.cache==='only-if-cached'&&event.request.mode!=='same-origin')return;
  event.respondWith((async()=>{
    const r=await fetch(event.request);
    if(r.status===0||new URL(event.request.url).origin!==self.location.origin)return r;
    const h=new Headers(r.headers);
    h.set('Cross-Origin-Opener-Policy','same-origin');
    h.set('Cross-Origin-Embedder-Policy','credentialless');
    return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
  })());
});
